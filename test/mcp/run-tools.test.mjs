import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { run } from "../../src/cli/index.mjs";
import { runDir } from "../../src/config/paths.mjs";
import { openDb } from "../../src/memory/db.mjs";
import { addJob, claimJobById, persistRunFacts } from "../../src/memory/jobs.mjs";
import { saveLesson } from "../../src/memory/lessons.mjs";
import { decideResume } from "../../src/queue/resume.mjs";
import { recordOutcome, recordPhaseDone, recordPrUrl, recordRunFields } from "../../src/queue/run-state.mjs";
import { ensureProject, makeHome, makeProject, projectIdOf } from "../../test-support/memory.mjs";

const CLI = fileURLToPath(new URL("../../bin/nightqueue.mjs", import.meta.url));
const WORKER = "host:4242";
const SLUG = "fix-the-worker";
const UTC_ISO = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/;

// Connects a real stdio client to `nightqueue mcp`, closed at the end of the test.
async function connect(t, env) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [CLI, "mcp"], env, stderr: "pipe" });
  const client = new Client({ name: "nightqueue-tests", version: "0.0.0" });
  await client.connect(transport);
  t.after(() => client.close());
  return client;
}

// Plain text of a tool result.
function textOf(result) {
  return result.content.map((block) => block.text).join("\n");
}

// JSON payload of a successful tool result.
function payloadOf(result) {
  assert.notEqual(result.isError, true, textOf(result));
  return JSON.parse(textOf(result));
}

// The state.json of a run of a project named by the test, as it is on disk right now.
function readState(env, project, slug) {
  return JSON.parse(readFileSync(join(runDir(projectIdOf(env, project), slug, env), "state.json"), "utf8"));
}

// A home with the project `alpha` and one claimed job, with the run slug already bound to its row unless asked otherwise.
function makeRunningJob(t, name, { slug = SLUG, sessionId = null } = {}) {
  const env = makeHome(t, name);
  makeProject(t, env, "alpha");
  const job = addJob({ projectId: ensureProject(env, "alpha"), prompt: "rewrite the runner" }, env);
  claimJobById(job.id, { worker: WORKER, cap: 4 }, env);
  if (slug) persistRunFacts(job.id, { worker: WORKER, slug, sessionId }, env);
  return { env, job };
}

test("inside a job the run tools resolve the run from the job's own row", async (t) => {
  const { env, job } = makeRunningJob(t, "mcp-run-tools-inside");
  const client = await connect(t, { ...env, NIGHTQUEUE_JOB_ID: String(job.id) });

  const done = payloadOf(
    await client.callTool({ name: "run_phase_done", arguments: { phase: "triage", artifact: "01-triage.md", verdict: "CONFIRMED" } }),
  );
  assert.deepEqual({ ok: done.ok, project: done.project, slug: done.slug }, { ok: true, project: "alpha", slug: SLUG });
  assert.equal(done.path, join(runDir(ensureProject(env, "alpha"), SLUG, env), "state.json"));

  payloadOf(await client.callTool({ name: "run_set", arguments: { type: "bug/error" } }));
  payloadOf(await client.callTool({ name: "run_outcome", arguments: { status: "gate", notice: "the operator has to choose" } }));

  const state = readState(env, "alpha", SLUG);
  assert.deepEqual(
    { schemaVersion: state.schemaVersion, projectId: state.projectId, slug: state.slug, resumeCount: state.resumeCount },
    { schemaVersion: 1, projectId: projectIdOf(env, "alpha"), slug: SLUG, resumeCount: 0 },
  );
  assert.deepEqual(state.phases.map((entry) => entry.phase), ["triage"]);
  assert.equal(state.type, "bug/error");
  assert.equal("tier" in state, false, "run_set recorded a tier");
  assert.equal(state.outcome.status, "gate");
  assert.match(state.updatedAt, UTC_ISO);
  assert.match(state.phases[0].at, UTC_ISO);
});

test("run_skip records an agent skip of a later phase and refuses a phase that already ran", async (t) => {
  const { env, job } = makeRunningJob(t, "mcp-run-tools-skip");
  const client = await connect(t, { ...env, NIGHTQUEUE_JOB_ID: String(job.id) });

  payloadOf(await client.callTool({ name: "run_phase_done", arguments: { phase: "triage", artifact: "01-triage.md" } }));
  const skipped = payloadOf(await client.callTool({ name: "run_skip", arguments: { phase: "qa", by: "architect", reason: "docs only" } }));
  assert.deepEqual({ ok: skipped.ok, slug: skipped.slug }, { ok: true, slug: SLUG });
  const state = readState(env, "alpha", SLUG);
  assert.deepEqual({ by: state.skips.qa.by, reason: state.skips.qa.reason }, { by: "architect", reason: "docs only" });
  assert.match(state.skips.qa.at, UTC_ISO);
  assert.deepEqual(state.phases.map((entry) => entry.phase), ["triage"], "a skip went into phases");

  const refused = await client.callTool({ name: "run_skip", arguments: { phase: "triage", by: "architect", reason: "late" } });
  assert.equal(refused.isError, true);
  assert.match(textOf(refused), /`triage` already ran: only a later phase can be skipped/);
});

test("inside a job a run named from the outside is refused, and nothing is written for it", async (t) => {
  const { env, job } = makeRunningJob(t, "mcp-run-tools-foreign");
  const client = await connect(t, { ...env, NIGHTQUEUE_JOB_ID: String(job.id) });

  const refused = await client.callTool({
    name: "run_phase_done",
    arguments: { phase: "triage", artifact: "01-triage.md", project: "beta", slug: "another-run" },
  });
  assert.equal(refused.isError, true);
  assert.match(textOf(refused), /refusing to act on project `beta` and slug `another-run` from inside job `\d+`/);
  assert.match(textOf(refused), /resolved from its own row/);

  assert.equal(existsSync(join(runDir(ensureProject(env, "beta"), "another-run", env), "state.json")), false, "the refused call wrote another run");
  assert.equal(existsSync(join(runDir(ensureProject(env, "alpha"), SLUG, env), "state.json")), false, "the refused call wrote its own run");
});

test("a job whose row has no run slug yet is told to print it instead of getting a guessed run directory", async (t) => {
  const { env, job } = makeRunningJob(t, "mcp-run-tools-no-slug", { slug: null });
  const client = await connect(t, { ...env, NIGHTQUEUE_JOB_ID: String(job.id) });

  const refused = await client.callTool({ name: "run_terminate", arguments: { phase: "triage", reason: "not reproducible" } });
  assert.equal(refused.isError, true);
  assert.match(textOf(refused), new RegExp(`job \`${job.id}\` has no run slug on its row yet`));
  assert.match(textOf(refused), /SLUG: <slug>/);
  assert.match(textOf(refused), /QUEUE_SLUG: <slug>/);
});

test("outside a job the project and the slug are both required, and a registered project writes its run", async (t) => {
  const env = makeHome(t, "mcp-run-tools-operator");
  makeProject(t, env, "alpha");
  const client = await connect(t, env);

  const missing = await client.callTool({ name: "run_phase_done", arguments: { phase: "triage", artifact: "01-triage.md" } });
  assert.equal(missing.isError, true);
  assert.match(textOf(missing), /outside a job, `project` \(the registered NAME\) and `slug`/);

  const unknown = await client.callTool({ name: "run_phase_done", arguments: { phase: "triage", project: "nope", slug: SLUG } });
  assert.equal(unknown.isError, true);
  assert.match(textOf(unknown), /unknown project `nope`/);

  const unsafe = await client.callTool({ name: "run_phase_done", arguments: { phase: "triage", project: "alpha", slug: "../escape" } });
  assert.equal(unsafe.isError, true);
  assert.match(textOf(unsafe), /invalid slug `\.\.\/escape`/);

  const written = payloadOf(await client.callTool({ name: "run_phase_done", arguments: { phase: "triage", project: "alpha", slug: SLUG } }));
  assert.equal(written.ok, true);
  assert.deepEqual(readState(env, "alpha", SLUG).phases.map((entry) => entry.phase), ["triage"]);
});

test("`run_set` records the QA stage A marker, and the resume decision reads it back as the stage B re-entry", async (t) => {
  const { env, job } = makeRunningJob(t, "mcp-run-tools-qa-stage-a");
  const client = await connect(t, { ...env, NIGHTQUEUE_JOB_ID: String(job.id) });
  for (const phase of ["triage", "explore", "architecture", "implementation"]) {
    payloadOf(await client.callTool({ name: "run_phase_done", arguments: { phase, artifact: `0-${phase}.md`, verdict: "ok" } }));
  }

  await new Promise((done) => setTimeout(done, 5));
  const marker = { artifact: "05-qa.md", verdict: "BREAKS-FOUND" };
  payloadOf(await client.callTool({ name: "run_set", arguments: { qa_stage_a: marker } }));

  const state = readState(env, "alpha", SLUG);
  assert.deepEqual({ artifact: state.qaStageA.artifact, verdict: state.qaStageA.verdict }, marker);
  assert.match(state.qaStageA.at, UTC_ISO);
  assert.equal(state.phases.some((entry) => entry.phase.startsWith("qa-")), false, "a sub-phase was written into `phases`");
  assert.deepEqual(
    { fromPhase: decideResume({ state }).fromPhase, fromStage: decideResume({ state }).fromStage },
    { fromPhase: "qa", fromStage: "qa-stage-b" },
  );

  const refused = await client.callTool({ name: "run_set", arguments: { qa_stage_a: { verdict: "BREAKS-FOUND" } } });
  assert.equal(refused.isError, true);
  assert.match(textOf(refused), /artifact/);
});

test("inside a job `pipeline_log` records the run of its own row and the fields the run already recorded", async (t) => {
  const { env, job } = makeRunningJob(t, "mcp-pipeline-log-inside");
  const client = await connect(t, { ...env, NIGHTQUEUE_JOB_ID: String(job.id) });

  payloadOf(
    await client.callTool({
      name: "run_set",
      arguments: { type: "bug/error" },
    }),
  );

  const logged = payloadOf(
    await client.callTool({
      name: "pipeline_log",
      arguments: { project: "beta", slug: "another-run", outcome: "pr_opened", phases: [{ phase: "triage" }] },
    }),
  );
  assert.equal(logged.project, "alpha");

  const row = openDb(env).prepare("SELECT * FROM pipeline_runs ORDER BY id DESC LIMIT 1").get();
  assert.deepEqual(
    { projectId: row.project_id, slug: row.slug, taskType: row.task_type },
    { projectId: projectIdOf(env, "alpha"), slug: SLUG, taskType: "bug/error" },
    "the run named from the outside was recorded instead of the job's own",
  );
});

test("`pipeline_log` ignores the sent `phases` and records the run's state.json phases with their reasons", async (t) => {
  const { env, job } = makeRunningJob(t, "mcp-pipeline-log-reasons");
  const client = await connect(t, { ...env, NIGHTQUEUE_JOB_ID: String(job.id) });
  const reason = "fix loop 1: the lint check failed";

  payloadOf(await client.callTool({ name: "run_set", arguments: { type: "feature/refactor" } }));
  payloadOf(await client.callTool({ name: "run_phase_done", arguments: { phase: "verification", verdict: "FAILED" } }));
  payloadOf(await client.callTool({ name: "run_phase_done", arguments: { phase: "verification", verdict: "PASSED", reason } }));
  payloadOf(await client.callTool({ name: "run_phase_done", arguments: { phase: "qa", verdict: "PASSED" } }));

  const sent = [{ phase: "triage", reason: "sent by an older plugin" }, { phase: "triage" }];
  const logged = payloadOf(await client.callTool({ name: "pipeline_log", arguments: { outcome: "pr_opened", phases: sent, tier_operator: "x" } }));

  assert.equal("reasons_unpaired" in logged, false, "the answer still carries the retired pairing field");
  const rows = openDb(env)
    .prepare("SELECT phase, status, retry, reason FROM pipeline_phases WHERE run_id = ? ORDER BY seq")
    .all(logged.runId)
    .map((row) => ({ phase: row.phase, status: row.status, retry: Number(row.retry), reason: row.reason }));
  assert.deepEqual(rows, [
    { phase: "verification", status: "failed", retry: 0, reason: null },
    { phase: "verification", status: "ok", retry: 1, reason },
    { phase: "qa", status: "ok", retry: 0, reason: null },
  ]);
});

test("inside a job a second `pipeline_log` in the same attempt answers `already_recorded` and adds no row", async (t) => {
  const { env, job } = makeRunningJob(t, "mcp-pipeline-log-once");
  const client = await connect(t, { ...env, NIGHTQUEUE_JOB_ID: String(job.id) });
  payloadOf(await client.callTool({ name: "run_phase_done", arguments: { phase: "triage", verdict: "PROCEED" } }));

  const first = payloadOf(await client.callTool({ name: "pipeline_log", arguments: { outcome: "no_commit", gate_stop: "triage" } }));
  const second = payloadOf(await client.callTool({ name: "pipeline_log", arguments: { outcome: "pr_opened" } }));

  assert.equal(Number.isInteger(first.runId), true, JSON.stringify(first));
  assert.deepEqual({ ok: second.ok, already: second.already_recorded }, { ok: true, already: true });
  const rows = openDb(env).prepare("SELECT outcome FROM pipeline_runs WHERE slug = ?").all(SLUG);
  assert.deepEqual(rows.map((row) => row.outcome), ["no_commit"]);
});

test("outside a job an older plugin's `pipeline_log` after `run report` answers `already_recorded` and adds no row", async (t) => {
  const env = makeHome(t, "mcp-pipeline-log-after-report");
  makeProject(t, env, "alpha");
  const target = { projectId: ensureProject(env, "alpha"), slug: SLUG, env };
  recordRunFields({ ...target, fields: { type: "bug/error" } });
  for (const phase of ["implementation", "commit"]) recordPhaseDone({ ...target, phase, verdict: "ok", note: "x", artifact: `${phase}.md` });
  recordOutcome({ ...target, status: "done" });
  recordPrUrl({ ...target, prUrl: "https://github.com/acme/api/pull/9" });
  const out = [];
  const code = await run(["run", "report", "--json", "--project", "alpha", "--slug", SLUG], { env, out: (line) => out.push(line), err: () => {}, stdout: { write: () => {} } });
  assert.equal(code, 0);
  assert.equal(JSON.parse(out[0]).recorded, "recorded");

  const client = await connect(t, env);
  const logged = payloadOf(await client.callTool({ name: "pipeline_log", arguments: { project: "alpha", slug: SLUG, outcome: "pr_opened" } }));

  assert.deepEqual({ ok: logged.ok, already: logged.already_recorded }, { ok: true, already: true });
  assert.equal(openDb(env).prepare("SELECT count(*) AS n FROM pipeline_runs WHERE slug = ?").get(SLUG).n, 1);
});

test("outside a job the operator's outcome sent twice for one slug records two rows", async (t) => {
  const env = makeHome(t, "mcp-pipeline-log-operator-always");
  makeProject(t, env, "alpha");
  const client = await connect(t, env);
  for (let i = 0; i < 2; i += 1) {
    payloadOf(await client.callTool({ name: "pipeline_log", arguments: { project: "alpha", slug: "hunt", outcome: "investigated" } }));
  }
  assert.equal(openDb(env).prepare("SELECT count(*) AS n FROM pipeline_runs WHERE slug = 'hunt'").get().n, 2);
});

test("outside a job `pipeline_log` records the operator's outcomes, and inside a job it refuses them", async (t) => {
  const { env, job } = makeRunningJob(t, "mcp-pipeline-log-operator");
  const outside = await connect(t, env);
  for (const outcome of ["investigated", "queued"]) {
    const logged = payloadOf(
      await outside.callTool({ name: "pipeline_log", arguments: { project: "alpha", slug: `hunt-${outcome}`, outcome } }),
    );
    const row = openDb(env).prepare("SELECT slug, outcome FROM pipeline_runs WHERE id = ?").get(logged.runId);
    assert.deepEqual({ slug: row.slug, outcome: row.outcome }, { slug: `hunt-${outcome}`, outcome });
  }

  const inside = await connect(t, { ...env, NIGHTQUEUE_JOB_ID: String(job.id) });
  const refused = await inside.callTool({ name: "pipeline_log", arguments: { outcome: "investigated" } });
  assert.equal(refused.isError, true);
  assert.match(textOf(refused), /outcome `investigated` is the operator's/);
});

test("`run_set` refuses the fields retired with the operator runs, and a null one is ignored", async (t) => {
  const env = makeHome(t, "mcp-run-set-retired");
  makeProject(t, env, "alpha");
  const client = await connect(t, env);
  const run = { project: "alpha", slug: "hunt-the-notice" };

  for (const [field, value] of [["origin", "operator"], ["evidence_level", 3], ["plan_status", "draft"]]) {
    const refused = await client.callTool({ name: "run_set", arguments: { ...run, type: "bug/error", [field]: value } });
    assert.equal(refused.isError, true, field);
    assert.match(textOf(refused), new RegExp(`\`${field}\` was removed with the operator runs`));
  }

  payloadOf(await client.callTool({ name: "run_set", arguments: { ...run, type: "bug/error", origin: null, evidence_level: null, plan_status: null } }));
  const state = readState(env, "alpha", run.slug);
  assert.deepEqual({ type: state.type, origin: state.origin, evidenceLevel: state.evidenceLevel }, { type: "bug/error", origin: undefined, evidenceLevel: undefined });
});

test("a phase, a status or a call with nothing to record is refused with the accepted contract", async (t) => {
  const { env, job } = makeRunningJob(t, "mcp-run-tools-enums");
  const client = await connect(t, { ...env, NIGHTQUEUE_JOB_ID: String(job.id) });

  const phase = await client.callTool({ name: "run_phase_done", arguments: { phase: "triagem", artifact: "01-triagem.md" } });
  assert.equal(phase.isError, true);
  assert.match(textOf(phase), /phase/);
  assert.match(textOf(phase), /triage \| explore \| architecture \| implementation \| qa \| verification \| runtime \| commit/);

  const status = await client.callTool({ name: "run_outcome", arguments: { status: "failed" } });
  assert.equal(status.isError, true);
  assert.match(textOf(status), /done \| gate/);

  const empty = await client.callTool({ name: "run_set", arguments: {} });
  assert.equal(empty.isError, true);
  assert.match(textOf(empty), /nothing was recorded in the state.json of `alpha\/fix-the-worker`: no field to record/);

  assert.equal(existsSync(join(runDir(ensureProject(env, "alpha"), SLUG, env), "state.json")), false, "a refused call created the file");
});

test("`run_outcome` composes a gate notice from the run's artifact and question, and refuses what it cannot compose", async (t) => {
  const { env, job } = makeRunningJob(t, "mcp-run-tools-gate-notice");
  const dir = runDir(ensureProject(env, "alpha"), SLUG, env);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "03-plan.md"), "## Implementation plan\nx\n\n## Requires user confirmation\n1. Approve C1?\n\n## Assumptions\n- none\n");
  const client = await connect(t, { ...env, NIGHTQUEUE_JOB_ID: String(job.id) });

  const refusals = [
    [{ status: "gate", from_artifact: { file: "../03-plan.md", section: "## Requires user confirmation" } }, /bare name of a run artifact/],
    [{ status: "gate", from_artifact: { file: "03-plan.md", section: "## Nope" } }, /03-plan.md has no `## Nope` section: nothing was recorded/],
    [{ status: "done", question: "why?" }, /only compose a `gate` notice/],
    [{ status: "gate", notice: "hand-written", question: "why?" }, /either `notice` or `question`\/`from_artifact`, never both/],
  ];
  for (const [args, message] of refusals) {
    const refused = await client.callTool({ name: "run_outcome", arguments: args });
    assert.equal(refused.isError, true, JSON.stringify(args));
    assert.match(textOf(refused), message);
  }
  assert.equal(existsSync(join(dir, "state.json")), false, "a refused call wrote state.json");

  const composed = payloadOf(
    await client.callTool({
      name: "run_outcome",
      arguments: { status: "gate", question: "Approve?", from_artifact: { file: "03-plan.md", section: "## Requires user confirmation" } },
    }),
  );
  const expected = `## Requires user confirmation\n1. Approve C1?\n\nApprove?\n\nAnswer with: nightqueue queue retry J-${job.id} --note "<your answer>"`;
  assert.equal(composed.notice, expected);
  assert.deepEqual(readState(env, "alpha", SLUG).outcome.notice, expected);
  assert.equal(readState(env, "alpha", SLUG).outcome.status, "gate");
});

test("a refused `run_outcome` notice says why and that nothing was recorded, so the run can fix it and emit again", async (t) => {
  const { env, job } = makeRunningJob(t, "mcp-run-tools-notice-reasons");
  const dir = runDir(ensureProject(env, "alpha"), SLUG, env);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "03-plan.md"), "## Implementation plan\nx\n");
  const client = await connect(t, { ...env, NIGHTQUEUE_JOB_ID: String(job.id) });

  const refusals = [
    [{ status: "no_change" }, /needs the run's conclusion as its notice/],
    [{ status: "no_change", notice: "   " }, /needs the run's conclusion as its notice/],
    [{ status: "gate", from_artifact: { file: "03-plan.md", section: "## X" } }, /has no `## X` section: nothing was recorded/],
  ];
  for (const [args, reason] of refusals) {
    const refused = await client.callTool({ name: "run_outcome", arguments: args });
    assert.equal(refused.isError, true, JSON.stringify(args));
    assert.match(textOf(refused), reason);
    assert.match(textOf(refused), /nothing was recorded/);
  }
  assert.equal(existsSync(join(dir, "state.json")), false, "a refused notice wrote state.json");
});

test("inside a job the recall drops what the run already saw, and gives it back when it is all there is", async (t) => {
  const { env, job } = makeRunningJob(t, "mcp-run-tools-context", { sessionId: "session-of-the-run" });
  for (let i = 0; i < 8; i += 1) {
    saveLesson(
      {
        projectId: projectIdOf(env, "alpha"),
        title: `the worker drops the lease number ${i}`,
        root_cause: "the early return skipped the renewal",
        solution: "renew it in a finally block",
        prevention: `renew the lease of the worker in a finally block ${i}`,
      },
      env,
    );
  }
  const client = await connect(t, { ...env, NIGHTQUEUE_JOB_ID: String(job.id) });
  const idsOf = (block) => [...block.matchAll(/\[L(\d+)\]/g)].map((match) => Number(match[1]));

  const context = payloadOf(
    await client.callTool({ name: "context_for_phase", arguments: { target: "coder", query: "worker lease" } }),
  );
  assert.equal(context.project, "alpha");
  assert.match(context.block, /^## Applicable lessons\n- \[L\d+\] renew the lease of the worker in a finally block/);
  const injected = idsOf(context.block);
  assert.equal(injected.length, 4);

  const recalled = payloadOf(await client.callTool({ name: "lesson_recall", arguments: { query: "worker lease" } }));
  const repeated = recalled.map((lesson) => lesson.id).filter((id) => injected.includes(id));
  assert.deepEqual(repeated, [], "the recall handed back a lesson this run had already been given");

  const exhausted = payloadOf(await client.callTool({ name: "lesson_recall", arguments: { query: "worker lease" } }));
  assert.equal(exhausted.length, 8, "the exclusion emptied the recall instead of retrying without it");
});
