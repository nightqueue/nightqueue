import assert from "node:assert/strict";
import { test } from "node:test";
import { UserError } from "../../src/config/errors.mjs";
import { closeDb, openDb } from "../../src/memory/db.mjs";
import { logPipelineRun, updateRunTelemetry } from "../../src/memory/runs.mjs";
import { makeHome, makeProject, projectIdOf } from "../../test-support/memory.mjs";

// Rows of the two telemetry tables, in insertion order.
function telemetry(env) {
  const db = openDb(env);
  return {
    runs: db.prepare("SELECT * FROM pipeline_runs ORDER BY id").all(),
    phases: db.prepare("SELECT * FROM pipeline_phases ORDER BY id").all(),
  };
}

// Minimal valid run, overridable field by field.
function run(env, overrides = {}) {
  return { projectId: projectIdOf(env, "alpha"), slug: "fix-the-worker", outcome: "pr_opened", ...overrides };
}

test("a run and its phases are stored with the sequence of the call", (t) => {
  const env = makeHome(t, "runs-store");
  makeProject(t, env, "alpha");
  const logged = logPipelineRun(
    run(env, {
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
  assert.equal(logged.projectId, projectIdOf(env, "alpha"));
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

test("the reason a phase ran again is stored trimmed, and a phase with none stores null", (t) => {
  const env = makeHome(t, "runs-reason");
  makeProject(t, env, "alpha");
  logPipelineRun(
    run(env, {
      phases: [
        { phase: "verification", status: "failed" },
        { phase: "verification", retry: true, reason: "  fix loop 1: lint failed  " },
        { phase: "commit", reason: "   " },
      ],
    }),
    env,
  );
  assert.deepEqual(
    telemetry(env).phases.map((phase) => phase.reason),
    [null, "fix loop 1: lint failed", null],
  );
});

test("a database whose phases table lacks `reason` gains the column on open, and a second open is a no-op", (t) => {
  const env = makeHome(t, "runs-reason-column");
  makeProject(t, env, "alpha");
  const columns = (db) => db.prepare("PRAGMA table_info(pipeline_phases)").all().map((column) => column.name);
  const db = openDb(env);
  db.exec("ALTER TABLE pipeline_phases DROP COLUMN reason");
  assert.equal(columns(db).includes("reason"), false);
  closeDb(env);

  assert.deepEqual(columns(openDb(env)).filter((name) => name === "reason"), ["reason"]);
  closeDb(env);
  assert.deepEqual(columns(openDb(env)).filter((name) => name === "reason"), ["reason"]);
});

test("every run stores the constant legacy tier and leaves the operator tier and the raise reason empty, whatever a replayed spec carries", (t) => {
  const env = makeHome(t, "runs-tier-deprecated");
  makeProject(t, env, "alpha");

  logPipelineRun(run(env), env);
  logPipelineRun(run(env, { tier: "trivial", tierOperator: "urgent", tierRaiseReason: "stack trace in the claim path" }), env);

  for (const row of telemetry(env).runs) {
    assert.deepEqual(
      { tier: row.tier, operator: row.tier_operator, reason: row.tier_raise_reason },
      { tier: "complex", operator: null, reason: null },
    );
  }
});

test("an outcome outside the contract is refused and stores nothing at all", (t) => {
  const env = makeHome(t, "runs-outcome");
  makeProject(t, env, "alpha");
  assert.throws(
    () => logPipelineRun(run(env, { outcome: "pr_aberto", phases: [{ phase: "triager" }] }), env),
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
  assert.throws(
    () => logPipelineRun(run(env, { gateStop: "triagem" }), env),
    /invalid `gate_stop`.*critique\|triage\|architect\|qa\|verification\|runtime\|user/,
  );
  assert.throws(
    () => logPipelineRun(run(env, { phases: [{ phase: "coder", status: "falhou" }] }), env),
    /invalid `status`.*ok\|failed\|skipped/,
  );
  assert.throws(() => logPipelineRun(run(env, { taskType: "bug" }), env), /invalid `task_type`.*bug\/error\|feature\/refactor/);
  assert.throws(() => logPipelineRun(run(env, { slug: "  " }), env), /`slug` is required/);
  assert.throws(() => logPipelineRun(run(env, { phases: [{ phase: " " }] }), env), /every phase needs a non-empty `phase`/);
  assert.deepEqual(telemetry(env), { runs: [], phases: [] });
});

test("the operator's two outcomes are stored like any other", (t) => {
  const env = makeHome(t, "runs-operator-outcomes");
  makeProject(t, env, "alpha");
  logPipelineRun(run(env, { slug: "hunt-a", outcome: "investigated" }), env);
  logPipelineRun(run(env, { slug: "hunt-b", outcome: "queued" }), env);
  assert.deepEqual(telemetry(env).runs.map((row) => row.outcome), ["investigated", "queued"]);
});

test("a run without gate stop and without phases is valid", (t) => {
  const env = makeHome(t, "runs-minimal");
  makeProject(t, env, "alpha");
  const logged = logPipelineRun(run(env, { gateStop: null }), env);
  assert.equal(logged.phases, 0);
  const stored = telemetry(env);
  assert.equal(stored.runs[0].gate_stop, null);
  assert.equal(stored.runs[0].task_type, null);
  assert.equal(stored.runs[0].duration_s, null);
  assert.deepEqual(stored.phases, []);
});

test("the telemetry the runtime measured wins, and what the agent sent survives only where the runtime measured nothing", (t) => {
  const env = makeHome(t, "runs-telemetry-update");
  makeProject(t, env, "alpha");
  logPipelineRun(
    run(env, {
      durationS: 999,
      phases: [
        { phase: "triage", model: "haiku", duration_s: 7 },
        { phase: "implementation", model: null, duration_s: null },
        { phase: "implementation", model: null, duration_s: null },
        { phase: "verification", model: "sonnet", duration_s: 213 },
        { phase: "commit", model: null, duration_s: 11 },
      ],
    }),
    env,
  );

  const updated = updateRunTelemetry(
    {
      projectId: projectIdOf(env, "alpha"),
      slug: "fix-the-worker",
      durationS: 3900,
      phases: [
        { phase: "triage", model: "sonnet", durationS: 61 },
        { phase: "implementation", model: "opus", durationS: 420 },
        { phase: "implementation", model: "opus", durationS: 173 },
        { phase: "verification", model: null, durationS: null },
        { phase: "explore", model: "sonnet", durationS: 90 },
      ],
    },
    env,
  );
  assert.equal(updated.phases, 4, "the phase the agent never recorded has no row and is not inserted");

  const stored = telemetry(env);
  assert.equal(stored.runs[0].duration_s, 3900);
  assert.deepEqual(
    stored.phases.map((phase) => [phase.phase, phase.model, phase.duration_s]),
    [
      ["triage", "sonnet", 61],
      ["implementation", "opus", 420],
      ["implementation", "opus", 173],
      ["verification", "sonnet", 213],
      ["commit", null, 11],
    ],
  );
});

test("a run the agent never recorded is left alone: the measured telemetry never inserts a row of its own", (t) => {
  const env = makeHome(t, "runs-telemetry-absent");
  makeProject(t, env, "alpha");

  const answer = updateRunTelemetry({ projectId: projectIdOf(env, "alpha"), slug: "never-logged", durationS: 120, phases: [{ phase: "triage", durationS: 10 }] }, env);

  assert.deepEqual({ runId: answer.runId, phases: answer.phases, projectId: answer.projectId }, { runId: null, phases: 0, projectId: projectIdOf(env, "alpha") });
  assert.deepEqual(telemetry(env), { runs: [], phases: [] });
  assert.throws(() => updateRunTelemetry({ projectId: projectIdOf(env, "alpha"), slug: "  " }, env), /`slug` is required/);
});

test("the measured telemetry of a retried job lands on the LAST run recorded for that slug", (t) => {
  const env = makeHome(t, "runs-telemetry-retry");
  makeProject(t, env, "alpha");
  logPipelineRun(run(env, { durationS: 100, phases: [{ phase: "triage" }] }), env);
  const second = logPipelineRun(run(env, { durationS: 200, phases: [{ phase: "triage" }] }), env);

  updateRunTelemetry({ projectId: projectIdOf(env, "alpha"), slug: "fix-the-worker", durationS: 3000, phases: [{ phase: "triage", model: "opus", durationS: 30 }] }, env);

  const stored = telemetry(env);
  assert.deepEqual(stored.runs.map((row) => row.duration_s), [100, 3000]);
  assert.deepEqual(
    stored.phases.map((phase) => [phase.run_id === second.runId, phase.model, phase.duration_s]),
    [
      [false, null, null],
      [true, "opus", 30],
    ],
  );
});

test("the model and the session come from the environment of the process, never from a parameter", (t) => {
  const env = makeHome(t, "runs-env");
  makeProject(t, env, "alpha");
  logPipelineRun(run(env), { ...env, NIGHTQUEUE_MODEL: "opus", NIGHTQUEUE_SESSION_ID: "s-42" });
  logPipelineRun(run(env, { slug: "second-run" }), env);
  const stored = telemetry(env);
  assert.deepEqual(
    stored.runs.map((row) => [row.slug, row.model, row.session_id]),
    [
      ["fix-the-worker", "opus", "s-42"],
      ["second-run", null, null],
    ],
  );
});
