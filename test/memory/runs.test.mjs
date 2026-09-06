import assert from "node:assert/strict";
import { test } from "node:test";
import { UserError } from "../../src/config/errors.mjs";
import { openDb } from "../../src/memory/db.mjs";
import { logPipelineRun } from "../../src/memory/runs.mjs";
import { makeHome, makeProject } from "../../test-support/memory.mjs";

// Rows of the two telemetry tables, in insertion order.
function telemetry(env) {
  const db = openDb(env);
  return {
    runs: db.prepare("SELECT * FROM pipeline_runs ORDER BY id").all(),
    phases: db.prepare("SELECT * FROM pipeline_phases ORDER BY id").all(),
  };
}

// Minimal valid run, overridable field by field.
function run(overrides = {}) {
  return { project: "alpha", slug: "fix-the-worker", tier: "simple", outcome: "pr_opened", ...overrides };
}

test("a run and its phases are stored with the sequence of the call", (t) => {
  const env = makeHome(t, "runs-store");
  makeProject(t, env, "alpha");
  const logged = logPipelineRun(
    run({
      taskType: "bug/error",
      gateStop: "triage",
      durationS: 42,
      phases: [
        { phase: "triager", model: "opus", status: "ok", duration_s: 10 },
        { phase: "architect", model: "opus", status: "skipped", retry: true, note: "gate stop" },
      ],
    }),
    env,
  );
  assert.equal(logged.project, "alpha");
  assert.equal(logged.phases, 2);

  const stored = telemetry(env);
  assert.equal(stored.runs.length, 1);
  assert.equal(stored.runs[0].slug, "fix-the-worker");
  assert.equal(stored.runs[0].gate_stop, "triage");
  assert.equal(stored.runs[0].duration_s, 42);
  assert.deepEqual(
    stored.phases.map((phase) => [phase.seq, phase.phase, phase.status, phase.retry]),
    [
      [1, "triager", "ok", 0],
      [2, "architect", "skipped", 1],
    ],
  );
  assert.equal(stored.phases[0].run_id, logged.runId);
});

test("an outcome outside the contract is refused and stores nothing at all", (t) => {
  const env = makeHome(t, "runs-outcome");
  makeProject(t, env, "alpha");
  assert.throws(
    () => logPipelineRun(run({ outcome: "pr_aberto", phases: [{ phase: "triager" }] }), env),
    (err) => {
      assert.ok(err instanceof UserError);
      assert.match(err.message, /invalid `outcome`: `pr_aberto`; expected one of pr_opened\|local_commit\|no_commit/);
      return true;
    },
  );
  assert.deepEqual(telemetry(env), { runs: [], phases: [] });
});

test("every enum names the values it accepts when it refuses one", (t) => {
  const env = makeHome(t, "runs-enums");
  makeProject(t, env, "alpha");
  assert.throws(() => logPipelineRun(run({ tier: "complexo" }), env), /invalid `tier`.*trivial\|simple\|complex/);
  assert.throws(
    () => logPipelineRun(run({ gateStop: "triagem" }), env),
    /invalid `gate_stop`.*critique\|triage\|architect\|qa\|verification\|runtime\|user/,
  );
  assert.throws(
    () => logPipelineRun(run({ phases: [{ phase: "coder", status: "falhou" }] }), env),
    /invalid `status`.*ok\|failed\|skipped/,
  );
  assert.throws(() => logPipelineRun(run({ taskType: "bug" }), env), /invalid `task_type`.*bug\/error\|feature\/refactor/);
  assert.throws(() => logPipelineRun(run({ slug: "  " }), env), /`slug` is required/);
  assert.throws(() => logPipelineRun(run({ phases: [{ phase: " " }] }), env), /every phase needs a non-empty `phase`/);
  assert.deepEqual(telemetry(env), { runs: [], phases: [] });
});

test("a run without gate stop and without phases is valid", (t) => {
  const env = makeHome(t, "runs-minimal");
  makeProject(t, env, "alpha");
  const logged = logPipelineRun(run({ gateStop: null }), env);
  assert.equal(logged.phases, 0);
  const stored = telemetry(env);
  assert.equal(stored.runs[0].gate_stop, null);
  assert.equal(stored.runs[0].task_type, null);
  assert.equal(stored.runs[0].duration_s, null);
  assert.deepEqual(stored.phases, []);
});

test("the model and the session come from the environment of the process, never from a parameter", (t) => {
  const env = makeHome(t, "runs-env");
  makeProject(t, env, "alpha");
  logPipelineRun(run(), { ...env, NIGHTSHIFT_MODEL: "opus", NIGHTSHIFT_SESSION_ID: "s-42" });
  logPipelineRun(run({ slug: "second-run" }), env);
  const stored = telemetry(env);
  assert.deepEqual(
    stored.runs.map((row) => [row.slug, row.model, row.session_id]),
    [
      ["fix-the-worker", "opus", "s-42"],
      ["second-run", null, null],
    ],
  );
});
