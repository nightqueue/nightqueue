import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { jobLogPath, logsDir } from "../../src/config/paths.mjs";
import { openDb, openDbReadOnly } from "../../src/memory/db.mjs";
import { addJob } from "../../src/memory/jobs.mjs";
import { logPipelineRun, runTimeline } from "../../src/memory/runs.mjs";
import { runTimelineLines } from "../../src/mcp/run-timeline.mjs";
import { ensureProject, makeHome, makeProject } from "../../test-support/memory.mjs";
import { agentToolUseEvent, attemptMarker, toNdjson } from "../../test-support/streams.mjs";

const SLUG = "add-slugify";
const FALLBACK_ITEM = "the run timeline comes from state.json: `pipeline_log` recorded no run for this attempt";

// A home with a project, a job of this run whose attempt started now, and the env the job runs with.
function makeJobRun(t, name) {
  const env = makeHome(t, name);
  makeProject(t, env, "alpha");
  const projectId = ensureProject(env, "alpha");
  const id = addJob({ projectId, prompt: "add slugify" }, env).id;
  openDb(env).prepare("UPDATE jobs SET slug = ?, attempt_started_at = datetime('now', '-1 minute') WHERE id = ?").run(SLUG, id);
  return { env: { ...env, NIGHTQUEUE_JOB_ID: String(id) }, id, run: { project: "alpha", projectId, slug: SLUG } };
}

// Records one pipeline run of the slug with the given phases.
function logRun(env, projectId, phases) {
  return logPipelineRun({ projectId, slug: SLUG, outcome: "pr_opened", phases }, env);
}

// Renders the timeline and answers it with the open items it pushed.
async function timeline({ run, state = {}, env }) {
  const openItems = [];
  const text = await runTimelineLines({ run, state, env, openItems });
  return { text, openItems };
}

test("the recorded phases render in seq order with their models, statuses and reasons", async (t) => {
  const { env, run } = makeJobRun(t, "timeline-rows");
  logRun(env, run.projectId, [
    { phase: "implementation", model: "sonnet", status: "ok" },
    { phase: "verification", model: "opus", status: "failed" },
    { phase: "implementation", model: "sonnet", status: "ok", retry: true, reason: "fix loop 1: the suite failed" },
    { phase: "verification", model: "opus", status: "ok", retry: true },
  ]);
  const { text, openItems } = await timeline({ run, env });
  assert.equal(
    text,
    [
      "1. implementation · sonnet · ok · first run",
      "2. verification · opus · failed · first run",
      "3. implementation · sonnet · ok · fix loop 1: the suite failed",
      "4. verification · opus · ok · re-run (no reason recorded)",
    ].join("\n"),
  );
  assert.deepEqual(openItems, []);
});

test("each row shows the model its entry recorded, a row with none shows a dash, and the job log's lanes are never read", async (t) => {
  const { env, id, run } = makeJobRun(t, "timeline-recorded-model");
  logRun(env, run.projectId, [
    { phase: "verification", model: "haiku", status: "failed" },
    { phase: "verification", status: "ok", retry: true, reason: "fix loop 1: lint" },
  ]);
  mkdirSync(logsDir(env), { recursive: true });
  const lanes = [
    agentToolUseEvent({ id: "toolu_v1", subagentType: "nightqueue:verifier", model: "sonnet" }),
    agentToolUseEvent({ id: "toolu_v2", subagentType: "nightqueue:verifier", model: "opus" }),
  ];
  writeFileSync(jobLogPath(id, env), [attemptMarker(1), toNdjson(lanes)].join("\n"));
  const { text } = await timeline({ run, env });
  assert.equal(text, ["1. verification · haiku · failed · first run", "2. verification · - · ok · fix loop 1: lint"].join("\n"));
});

test("a run older than the attempt is ignored and state.json speaks, with an open item", async (t) => {
  const { env, run } = makeJobRun(t, "timeline-stale");
  const old = logRun(env, run.projectId, [{ phase: "triage", model: "opus", status: "ok" }]);
  openDb(env).prepare("UPDATE pipeline_runs SET created_at = '2000-01-01 00:00:00' WHERE id = ?").run(old.runId);
  const state = {
    phases: [
      { phase: "verification", verdict: "FAILED" },
      { phase: "verification", verdict: "PASSED", reason: "fix loop 1: the suite failed" },
      { phase: "verification", verdict: "PASSED" },
    ],
  };
  const { text, openItems } = await timeline({ run, state, env });
  assert.equal(
    text,
    [
      "1. verification · - · FAILED · first run",
      "2. verification · - · PASSED · fix loop 1: the suite failed",
      "3. verification · - · PASSED · re-run (no reason recorded)",
    ].join("\n"),
  );
  assert.deepEqual(openItems, [FALLBACK_ITEM]);
});

test("a QA skip reaches the reflector's timeline with its reason, from either source", async (t) => {
  const { env, run } = makeJobRun(t, "timeline-qa-skip");
  const reason = "QA skipped: only text changed.";
  const fromState = await timeline({ run, state: { phases: [{ phase: "qa", verdict: "SKIPPED", note: "only text changed.", reason }] }, env });
  assert.equal(fromState.text, `1. qa · - · SKIPPED · ${reason}`);
  logRun(env, run.projectId, [{ phase: "qa", model: "sonnet", status: "ok", reason }]);
  const fromRecord = await timeline({ run, env });
  assert.equal(fromRecord.text, `1. qa · sonnet · ok · ${reason}`);
});

test("no recorded run and no state phases answer `none recorded`", async (t) => {
  const { env, run } = makeJobRun(t, "timeline-empty");
  const { text, openItems } = await timeline({ run, env });
  assert.equal(text, "none recorded");
  assert.deepEqual(openItems, [FALLBACK_ITEM]);
});

test("a failing lookup answers `none recorded` and an open item instead of throwing", async (t) => {
  const { env, run } = makeJobRun(t, "timeline-failure");
  const { text, openItems } = await timeline({ run: { ...run, slug: "" }, env });
  assert.equal(text, "none recorded");
  assert.equal(openItems.length, 1);
  assert.match(openItems[0], /^the run timeline failed: /);
});

test("outside a job the latest run of the slug speaks, with no `since`", async (t) => {
  const { env: jobEnv, run } = makeJobRun(t, "timeline-no-job");
  const { NIGHTQUEUE_JOB_ID: _job, ...env } = jobEnv;
  logRun(env, run.projectId, [{ phase: "triage", model: "opus", status: "ok" }]);
  const { text } = await timeline({ run, env });
  assert.equal(text, "1. triage · opus · ok · first run");
});

test("the timeline is capped at 60 lines", async (t) => {
  const { env, run } = makeJobRun(t, "timeline-cap");
  const phases = Array.from({ length: 70 }, (_, index) => ({ phase: "verification", model: "opus", status: "ok", retry: index > 0, reason: index > 0 ? `fix loop ${index}: x` : undefined }));
  logRun(env, run.projectId, phases);
  const { text } = await timeline({ run, env });
  const lines = text.split("\n");
  assert.equal(lines.length, 60);
  assert.equal(lines.at(-1), "… 11 more phases not shown");
});

test("runTimeline only reads: it answers through a read-only connection", (t) => {
  const { env, run } = makeJobRun(t, "timeline-read-only");
  logRun(env, run.projectId, [{ phase: "triage", model: "opus", status: "ok", reason: "artifact MISSING" }]);
  const readOnly = openDbReadOnly(env);
  t.after(() => readOnly.close());
  assert.deepEqual(runTimeline({ projectId: run.projectId, slug: SLUG }, env, readOnly), [
    { seq: 1, phase: "triage", model: "opus", status: "ok", retry: false, reason: "artifact MISSING" },
  ]);
  assert.deepEqual(runTimeline({ projectId: run.projectId, slug: "never-ran" }, env, readOnly), []);
});
