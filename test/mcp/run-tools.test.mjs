import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { runDir } from "../../src/config/paths.mjs";
import { openDb } from "../../src/memory/db.mjs";
import { addJob, claimJobById, persistRunFacts } from "../../src/memory/jobs.mjs";
import { saveLesson } from "../../src/memory/lessons.mjs";
import { getRoadmapItem, markRoadmapItemQueued, saveRoadmapItem } from "../../src/memory/roadmap.mjs";
import { decideResume } from "../../src/queue/resume.mjs";
import { makeHome, makeProject } from "../../test-support/memory.mjs";

const CLI = fileURLToPath(new URL("../../bin/nightshift.mjs", import.meta.url));
const WORKER = "host:4242";
const SLUG = "fix-the-worker";
const UTC_ISO = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/;

// Connects a real stdio client to `nightshift mcp`, closed at the end of the test.
async function connect(t, env) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [CLI, "mcp"], env, stderr: "pipe" });
  const client = new Client({ name: "nightshift-tests", version: "0.0.0" });
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

// The state.json of a run as it is on disk right now.
function readState(env, project, slug) {
  return JSON.parse(readFileSync(join(runDir(project, slug, env), "state.json"), "utf8"));
}

// A home with the project `alpha` and one claimed job, with the run slug already bound to its row unless asked otherwise.
function makeRunningJob(t, name, { slug = SLUG, sessionId = null } = {}) {
  const env = makeHome(t, name);
  makeProject(t, env, "alpha");
  const job = addJob({ project: "alpha", prompt: "rewrite the runner" }, env);
  claimJobById(job.id, { worker: WORKER, cap: 4 }, env);
  if (slug) persistRunFacts(job.id, { worker: WORKER, slug, sessionId }, env);
  return { env, job };
}

test("inside a job the run tools resolve the run from the job's own row", async (t) => {
  const { env, job } = makeRunningJob(t, "mcp-run-tools-inside");
  const client = await connect(t, { ...env, NIGHTSHIFT_JOB_ID: String(job.id) });

  const done = payloadOf(
    await client.callTool({ name: "run_phase_done", arguments: { phase: "triage", artifact: "01-triage.md", verdict: "CONFIRMED" } }),
  );
  assert.deepEqual({ ok: done.ok, project: done.project, slug: done.slug }, { ok: true, project: "alpha", slug: SLUG });
  assert.equal(done.path, join(runDir("alpha", SLUG, env), "state.json"));

  payloadOf(await client.callTool({ name: "run_set", arguments: { tier: "complex", tier_raise_reason: "a native SDK is involved" } }));
  payloadOf(await client.callTool({ name: "run_outcome", arguments: { status: "gate", notice: "the operator has to choose" } }));

  const state = readState(env, "alpha", SLUG);
  assert.deepEqual(
    { schemaVersion: state.schemaVersion, project: state.project, slug: state.slug, resumeCount: state.resumeCount },
    { schemaVersion: 1, project: "alpha", slug: SLUG, resumeCount: 0 },
  );
  assert.deepEqual(state.phases.map((entry) => entry.phase), ["triage"]);
  assert.equal(state.tier, "complex");
  assert.equal(state.tierRaiseReason, "a native SDK is involved");
  assert.equal(state.outcome.status, "gate");
  assert.match(state.updatedAt, UTC_ISO);
  assert.match(state.phases[0].at, UTC_ISO);
});

test("inside a job a run named from the outside is refused, and nothing is written for it", async (t) => {
  const { env, job } = makeRunningJob(t, "mcp-run-tools-foreign");
  const client = await connect(t, { ...env, NIGHTSHIFT_JOB_ID: String(job.id) });

  const refused = await client.callTool({
    name: "run_phase_done",
    arguments: { phase: "triage", artifact: "01-triage.md", project: "beta", slug: "another-run" },
  });
  assert.equal(refused.isError, true);
  assert.match(textOf(refused), /refusing to act on project `beta` and slug `another-run` from inside job `\d+`/);
  assert.match(textOf(refused), /resolved from its own row/);

  assert.equal(existsSync(join(runDir("beta", "another-run", env), "state.json")), false, "the refused call wrote another run");
  assert.equal(existsSync(join(runDir("alpha", SLUG, env), "state.json")), false, "the refused call wrote its own run");
});

test("a job whose row has no run slug yet is told to print it instead of getting a guessed run directory", async (t) => {
  const { env, job } = makeRunningJob(t, "mcp-run-tools-no-slug", { slug: null });
  const client = await connect(t, { ...env, NIGHTSHIFT_JOB_ID: String(job.id) });

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

test("`run_outcome` done closes the roadmap item the job came from, and a gate leaves it open", async (t) => {
  const { env, job } = makeRunningJob(t, "mcp-run-tools-roadmap");
  const item = saveRoadmapItem({ project: "alpha", horizon: "now", title: "deliver the thing" }, env);
  assert.equal(markRoadmapItemQueued(item.id, job.id, env), true, "setup: the item was not linked to its job");
  const client = await connect(t, { ...env, NIGHTSHIFT_JOB_ID: String(job.id) });

  payloadOf(await client.callTool({ name: "run_outcome", arguments: { status: "gate", notice: "the operator has to choose" } }));
  assert.equal(getRoadmapItem(item.id, env).status, "queued", "a gated run closed the item it never delivered");

  payloadOf(await client.callTool({ name: "run_outcome", arguments: { status: "done" } }));
  assert.equal(getRoadmapItem(item.id, env).status, "done");
  assert.equal(readState(env, "alpha", SLUG).outcome.status, "done");
});

test("`run_set` records the QA stage A marker, and the resume decision reads it back as the stage B re-entry", async (t) => {
  const { env, job } = makeRunningJob(t, "mcp-run-tools-qa-stage-a");
  const client = await connect(t, { ...env, NIGHTSHIFT_JOB_ID: String(job.id) });
  for (const phase of ["triage", "explore", "architecture", "implementation"]) {
    payloadOf(await client.callTool({ name: "run_phase_done", arguments: { phase, artifact: `0-${phase}.md`, verdict: "ok" } }));
  }

  const marker = { artifact: "05a-qa-analyst.md", verdict: "BREAKS-FOUND" };
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
  const client = await connect(t, { ...env, NIGHTSHIFT_JOB_ID: String(job.id) });

  payloadOf(
    await client.callTool({
      name: "run_set",
      arguments: { tier: "complex", type: "bug/error", tier_raise_reason: "a stack trace in the claim path" },
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
    { project: row.project, slug: row.slug, tier: row.tier, taskType: row.task_type, reason: row.tier_raise_reason },
    { project: "alpha", slug: SLUG, tier: "complex", taskType: "bug/error", reason: "a stack trace in the claim path" },
    "the run named from the outside was recorded instead of the job's own",
  );
});

test("outside a job `pipeline_log` records the operator's outcomes, and inside a job it refuses them", async (t) => {
  const { env, job } = makeRunningJob(t, "mcp-pipeline-log-operator");
  const outside = await connect(t, env);
  for (const outcome of ["investigated", "queued"]) {
    const logged = payloadOf(
      await outside.callTool({ name: "pipeline_log", arguments: { project: "alpha", slug: `hunt-${outcome}`, tier: "complex", outcome } }),
    );
    const row = openDb(env).prepare("SELECT slug, outcome FROM pipeline_runs WHERE id = ?").get(logged.runId);
    assert.deepEqual({ slug: row.slug, outcome: row.outcome }, { slug: `hunt-${outcome}`, outcome });
  }

  const inside = await connect(t, { ...env, NIGHTSHIFT_JOB_ID: String(job.id) });
  const refused = await inside.callTool({ name: "pipeline_log", arguments: { tier: "complex", outcome: "investigated" } });
  assert.equal(refused.isError, true);
  assert.match(textOf(refused), /outcome `investigated` is the operator's/);
});

test("outside a job `run_set` records the operator fields, the evidence level as a number, and the schema refuses a level out of range", async (t) => {
  const env = makeHome(t, "mcp-run-set-operator");
  makeProject(t, env, "alpha");
  const client = await connect(t, env);
  const run = { project: "alpha", slug: "hunt-the-notice" };

  payloadOf(await client.callTool({ name: "run_set", arguments: { ...run, origin: "operator", evidence_level: 3, plan_status: "draft" } }));
  const state = readState(env, "alpha", run.slug);
  assert.deepEqual({ origin: state.origin, evidenceLevel: state.evidenceLevel, planStatus: state.planStatus }, { origin: "operator", evidenceLevel: 3, planStatus: "draft" });

  const outOfRange = await client.callTool({ name: "run_set", arguments: { ...run, evidence_level: 5 } });
  assert.equal(outOfRange.isError, true);
  assert.equal(readState(env, "alpha", run.slug).evidenceLevel, 3);
});

test("a phase, a status or a call with nothing to record is refused with the accepted contract", async (t) => {
  const { env, job } = makeRunningJob(t, "mcp-run-tools-enums");
  const client = await connect(t, { ...env, NIGHTSHIFT_JOB_ID: String(job.id) });

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

  assert.equal(existsSync(join(runDir("alpha", SLUG, env), "state.json")), false, "a refused call created the file");
});

test("inside a job the recall drops what the run already saw, and gives it back when it is all there is", async (t) => {
  const { env, job } = makeRunningJob(t, "mcp-run-tools-context", { sessionId: "session-of-the-run" });
  for (let i = 0; i < 8; i += 1) {
    saveLesson(
      {
        project: "alpha",
        title: `the worker drops the lease number ${i}`,
        root_cause: "the early return skipped the renewal",
        solution: "renew it in a finally block",
        prevention: `renew the lease of the worker in a finally block ${i}`,
      },
      env,
    );
  }
  const client = await connect(t, { ...env, NIGHTSHIFT_JOB_ID: String(job.id) });
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
