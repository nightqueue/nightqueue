import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { withLockSync } from "../../src/config/lock.mjs";
import { runDir } from "../../src/config/paths.mjs";
import {
  clearTermination,
  recordCheck,
  recordOutcome,
  recordPhaseDone,
  recordPrTemplate,
  recordPrUrl,
  recordRunFields,
  recordRuntimeField,
  recordTermination,
  RUN_OUTCOME_STATUSES,
  RUNTIME_AUTHOR,
} from "../../src/queue/run-state.mjs";
import { FIXED_PROJECT_ID, makeHome } from "../../test-support/memory.mjs";

const RUN = { projectId: FIXED_PROJECT_ID, slug: "fix-the-worker" };
const UTC_ISO = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/;

// The state.json of the run as it is on disk right now.
function readState(env) {
  return JSON.parse(readFileSync(join(runDir(RUN.projectId, RUN.slug, env), "state.json"), "utf8"));
}

// Writes a state.json in the run directory, in the shape another writer would have left it.
function writeState(env, content) {
  const dir = runDir(RUN.projectId, RUN.slug, env);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "state.json"), JSON.stringify(content));
}

for (const [label, name, value, reason] of [
  ["a QA mode outside the accepted ones", "qaMode", { mode: "bogus", reason: "r" }, /unknown QA mode `bogus`/],
  ["a QA mode that is a bare string", "qaMode", "full", /unknown QA mode `undefined`/],
  ["a QA mode with an empty reason", "qaMode", { mode: "lite", reason: " " }, /a QA mode needs its reason/],
  ["loops that are not an object", "pipelineLoops", [1], /the pipeline loops must be an object/],
]) {
  test(`${label} is refused and never reaches the state`, (t) => {
    const env = makeHome(t, "run-state-runtime-field");
    const written = recordRuntimeField({ ...RUN, name, value, env });
    assert.equal(written.status, "kept");
    assert.match(written.reason, reason);
    assert.equal(existsSync(join(runDir(RUN.projectId, RUN.slug, env), "state.json")), false);
  });
}

test("only the runtime's own termination is cleared, of the named phase, and a held lock keeps the file as it was", (t) => {
  const env = makeHome(t, "run-state-clear-termination");
  recordTermination({ ...RUN, phase: "triage", reason: "NEEDS-CLARIFICATION: by hand", env });
  assert.equal(clearTermination({ ...RUN, env }).status, "absent");
  assert.equal(readState(env).termination.reason, "NEEDS-CLARIFICATION: by hand");

  recordTermination({ ...RUN, phase: "triage", reason: "NEEDS-CLARIFICATION: which one?", by: RUNTIME_AUTHOR, env });
  assert.equal(readState(env).termination.by, RUNTIME_AUTHOR);
  assert.equal(clearTermination({ ...RUN, phase: "explore", env }).status, "absent");

  const before = readFileSync(join(runDir(RUN.projectId, RUN.slug, env), "state.json"), "utf8");
  const held = withLockSync(`${runDir(RUN.projectId, RUN.slug, env)}.lock`, () => clearTermination({ ...RUN, phase: "triage", env }));
  assert.equal(held.status, "kept");
  assert.equal(readFileSync(join(runDir(RUN.projectId, RUN.slug, env), "state.json"), "utf8"), before);

  assert.equal(clearTermination({ ...RUN, phase: "triage", env }).status, "written");
  assert.equal(readState(env).termination, undefined);
});

test("a completed phase is appended with the fixed fields of the contract and a real UTC stamp", (t) => {
  const env = makeHome(t, "run-state-phase");

  const written = recordPhaseDone({ ...RUN, phase: "triage", artifact: "01-triage.md", verdict: "CONFIRMED", env });
  assert.equal(written.status, "written", written.reason);

  const state = readState(env);
  assert.deepEqual(
    { schemaVersion: state.schemaVersion, projectId: state.projectId, slug: state.slug },
    { schemaVersion: 1, projectId: FIXED_PROJECT_ID, slug: "fix-the-worker" },
  );
  assert.deepEqual(state.phases, [{ phase: "triage", at: state.phases[0].at, artifact: "01-triage.md", verdict: "CONFIRMED" }]);
  assert.match(state.phases[0].at, UTC_ISO);
  assert.match(state.updatedAt, UTC_ISO);
  assert.equal(new Date(state.updatedAt).toISOString(), state.updatedAt, "the stamp is not a real instant read from the clock");
  assert.ok(Math.abs(Date.now() - Date.parse(state.updatedAt)) < 60_000, "the stamp did not come from the clock");
  assert.equal("note" in state.phases[0], false, "an absent note was recorded as an empty key");
});

test("the reason a phase ran again is recorded trimmed, a blank one is dropped, and a first run keeps today's shape", (t) => {
  const env = makeHome(t, "run-state-phase-reason");

  recordPhaseDone({ ...RUN, phase: "verification", artifact: "06-verification.md", verdict: "FAILED", env });
  recordPhaseDone({ ...RUN, phase: "verification", artifact: "06-verification.md", verdict: "PASSED", reason: "  fix loop 1: lint failed  ", env });
  recordPhaseDone({ ...RUN, phase: "commit", reason: "   ", env });

  const [first, second, blank] = readState(env).phases;
  assert.deepEqual(Object.keys(first), ["phase", "at", "artifact", "verdict"], "an entry with no reason changed shape");
  assert.equal(second.reason, "fix loop 1: lint failed");
  assert.deepEqual(Object.keys(blank), ["phase", "at"], "a blank reason was recorded as a key");
});

test("a check memo replaces the check's previous one, and only a memo that did not pass becomes the run's last failure", (t) => {
  const env = makeHome(t, "run-state-check-memo");
  const failing = { line: "GATE: runtime-not-met — x", ok: false, completed: false, digest: "a" };
  assert.equal(recordCheck({ ...RUN, check: "07", memo: failing, env }).phase, null);
  const passing = { line: "OK", ok: true, completed: true, digest: "b" };
  const written = recordCheck({ ...RUN, check: "07", memo: passing, done: { phase: "runtime", artifact: "07-runtime.md", verdict: "CONFIRMED" }, env });
  assert.deepEqual(written.phase, { status: "appended", reason: "GATE: runtime-not-met — x" });
  const state = readState(env);
  assert.deepEqual([state.checks["07"].line, state.checks["07"].ok, state.checks.lastFailure.line], ["OK", true, "GATE: runtime-not-met — x"]);
  assert.equal(state.phases[0].by, "runtime");
  const again = recordCheck({ ...RUN, check: "07", memo: passing, done: { phase: "runtime", artifact: "07-runtime.md", verdict: "CONFIRMED" }, env });
  assert.deepEqual(again.phase, { status: "already", reason: null });
  assert.equal(readState(env).phases.length, 1);
  assert.equal(recordCheck({ ...RUN, check: "07", memo: passing, done: { phase: "nope" }, env }).status, "kept");
});

test("an unknown phase is refused with the accepted list and writes nothing", (t) => {
  const env = makeHome(t, "run-state-unknown-phase");

  const phase = recordPhaseDone({ ...RUN, phase: "triagem", artifact: "01-triagem.md", env });
  assert.equal(phase.status, "kept");
  assert.match(phase.reason, /unknown phase `triagem`; accepted: triage, explore, architecture, implementation, qa, verification, runtime, commit/);

  const termination = recordTermination({ ...RUN, phase: "critique", reason: "no reproduction", env });
  assert.equal(termination.status, "kept");
  assert.match(termination.reason, /unknown phase `critique`/);

  assert.equal(existsSync(join(runDir(RUN.projectId, RUN.slug, env), "state.json")), false, "a refused record created the file");
});

test("a status outside done|gate|no_change is refused, and the notice of a gate is recorded with the outcome", (t) => {
  const env = makeHome(t, "run-state-outcome");
  assert.deepEqual(RUN_OUTCOME_STATUSES, ["done", "gate", "no_change"]);

  const refused = recordOutcome({ ...RUN, status: "failed", env });
  assert.equal(refused.status, "kept");
  assert.match(refused.reason, /unknown status `failed`; accepted: done, gate, no_change/);

  assert.equal(recordOutcome({ ...RUN, status: "gate", notice: "  the migration needs a decision  ", env }).status, "written");
  const state = readState(env);
  assert.equal(state.outcome.status, "gate");
  assert.equal(state.outcome.notice, "the migration needs a decision");
  assert.match(state.outcome.at, UTC_ISO);
});

test("a no_change outcome is recorded with the run's conclusion as its notice, and refused without one", (t) => {
  const env = makeHome(t, "run-state-outcome-no-change");
  for (const notice of [undefined, "", "   "]) {
    const refused = recordOutcome({ ...RUN, status: "no_change", notice, env });
    assert.equal(refused.status, "kept");
    assert.match(refused.reason, /a no_change outcome needs the run's conclusion as its notice/);
  }
  assert.equal(existsSync(join(runDir(RUN.projectId, RUN.slug, env), "state.json")), false, "a refused no_change created the file");

  assert.equal(recordOutcome({ ...RUN, status: "no_change", notice: "  the cause is in the CDN config, not in this repo  ", env }).status, "written");
  const state = readState(env);
  assert.equal(state.outcome.status, "no_change");
  assert.equal(state.outcome.notice, "the cause is in the CDN config, not in this repo");
});

test("the outcome records the delivered files when given and keeps them through a later outcome with none", (t) => {
  const env = makeHome(t, "run-state-outcome-files");
  writeState(env, { schemaVersion: 1, project: "alpha", slug: "fix-the-worker", phases: [] });

  assert.equal(recordOutcome({ ...RUN, status: "gate", notice: "stopped", env }).status, "written");
  assert.equal("files" in readState(env).outcome, false);
  assert.equal(recordOutcome({ ...RUN, status: "done", files: ["a.txt"], env }).status, "written");
  assert.deepEqual(readState(env).outcome.files, ["a.txt"]);
  assert.equal(recordOutcome({ ...RUN, status: "done", env }).status, "written");
  assert.deepEqual(readState(env).outcome.files, ["a.txt"]);
});

test("the outcome keeps the pull request URL the runtime wrote: the agent never sends one", (t) => {
  const env = makeHome(t, "run-state-outcome-prurl");
  writeState(env, { schemaVersion: 1, project: "alpha", slug: "fix-the-worker", phases: [], outcome: { prUrl: "https://github.com/o/r/pull/7" } });

  assert.equal(recordOutcome({ ...RUN, status: "done", env }).status, "written");
  assert.deepEqual(
    { status: readState(env).outcome.status, prUrl: readState(env).outcome.prUrl },
    { status: "done", prUrl: "https://github.com/o/r/pull/7" },
  );
});

test("the pull request the runtime read is recorded into the outcome, and anything that is not one is refused", (t) => {
  const env = makeHome(t, "run-state-pr-url");
  const prUrl = "https://github.com/acme/api/pull/42";

  for (const value of [null, "", "https://example.com/not-a-pull-request", 42]) {
    const refused = recordPrUrl({ ...RUN, prUrl: value, env });
    assert.equal(refused.status, "kept", String(value));
    assert.match(refused.reason, /is not a pull request URL/);
  }
  assert.equal(existsSync(join(runDir(RUN.projectId, RUN.slug, env), "state.json")), false, "a refused URL created the file");

  assert.equal(recordOutcome({ ...RUN, status: "gate", notice: "the checks are still red", env }).status, "written");
  assert.equal(recordPrUrl({ ...RUN, prUrl, env }).status, "written");
  const state = readState(env);
  assert.deepEqual(
    { status: state.outcome.status, notice: state.outcome.notice, prUrl: state.outcome.prUrl, schemaVersion: state.schemaVersion },
    { status: "gate", notice: "the checks are still red", prUrl, schemaVersion: 1 },
  );
  assert.match(state.outcome.at, UTC_ISO);
});

test("the pull request template is a top-level record the latest call overwrites, refused when its shape is wrong or an agent sends it", (t) => {
  const env = makeHome(t, "run-state-pr-template");
  const headings = ["## Summary", "## Changes"];

  for (const template of [null, { source: "other", headings }, { source: "nightqueue", headings: "## QA" }, { source: "repo", headings }, { source: "repo", path: " ", headings }]) {
    assert.equal(recordPrTemplate({ ...RUN, template, env }).status, "kept", JSON.stringify(template));
  }
  assert.equal(existsSync(join(runDir(RUN.projectId, RUN.slug, env), "state.json")), false, "a refused template created the file");

  assert.equal(recordPrTemplate({ ...RUN, template: { source: "repo", path: "CLAUDE.md", headings }, env }).status, "written");
  const { at, ...repo } = readState(env).prTemplate;
  assert.deepEqual(repo, { source: "repo", path: "CLAUDE.md", headings });
  assert.match(at, UTC_ISO);

  assert.equal(recordPrTemplate({ ...RUN, template: { source: "nightqueue", path: null, headings: ["## QA"] }, env }).status, "written");
  assert.deepEqual(Object.keys(readState(env).prTemplate).sort(), ["at", "headings", "source"]);
  assert.equal(readState(env).outcome, undefined, "the template was recorded as an outcome of a run that has not ended");

  const viaAgent = recordRunFields({ ...RUN, fields: { prTemplate: "repo" }, env });
  assert.equal(viaAgent.status, "kept");
  assert.match(viaAgent.reason, /unknown field `prTemplate`/);
});

test("a termination without a reason is refused, and one with it closes the run for the resume decision", (t) => {
  const env = makeHome(t, "run-state-termination");
  recordPhaseDone({ ...RUN, phase: "triage", artifact: "01-triage.md", env });

  const refused = recordTermination({ ...RUN, phase: "triage", reason: "   ", env });
  assert.equal(refused.status, "kept");
  assert.match(refused.reason, /a termination needs a reason/);

  assert.equal(recordTermination({ ...RUN, phase: "triage", reason: "not reproducible", env }).status, "written");
  const state = readState(env);
  assert.equal(state.termination.phase, "triage");
  assert.equal(state.termination.reason, "not reproducible");
  assert.match(state.termination.at, UTC_ISO);
});

test("run fields refuse an unknown field and a value outside the enum, and record the ones they own", (t) => {
  const env = makeHome(t, "run-state-fields");

  assert.match(recordRunFields({ ...RUN, fields: {}, env }).reason, /no field to record; accepted: type, branch, worktree/);
  assert.match(recordRunFields({ ...RUN, fields: { slug: "other-run" }, env }).reason, /unknown field `slug`/);
  assert.match(recordRunFields({ ...RUN, fields: { tier: "complex" }, env }).reason, /unknown field `tier`/);
  assert.match(recordRunFields({ ...RUN, fields: { tierRaiseReason: "a stack trace" }, env }).reason, /unknown field `tierRaiseReason`/);
  assert.match(recordRunFields({ ...RUN, fields: { type: "chore" }, env }).reason, /unknown type `chore`; accepted: bug\/error, feature\/refactor/);
  assert.match(recordRunFields({ ...RUN, fields: { branch: "  " }, env }).reason, /field `branch` cannot be empty/);
  for (const removed of ["qaStageA", "origin", "evidenceLevel", "planStatus"]) {
    assert.match(recordRunFields({ ...RUN, fields: { [removed]: "x" }, env }).reason, new RegExp(`unknown field \`${removed}\``));
  }
  assert.equal(existsSync(join(runDir(RUN.projectId, RUN.slug, env), "state.json")), false, "a refused record created the file");

  assert.equal(recordRunFields({ ...RUN, fields: { type: "bug/error", branch: "fix/the-worker" }, env }).status, "written");
  const state = readState(env);
  assert.deepEqual({ type: state.type, branch: state.branch }, { type: "bug/error", branch: "fix/the-worker" });
});

test("the writers never lose each other's fields", (t) => {
  const env = makeHome(t, "run-state-sequence");

  recordRunFields({ ...RUN, fields: { type: "bug/error", branch: "fix/the-worker", worktree: "/tmp/wt" }, env });
  recordPhaseDone({ ...RUN, phase: "triage", artifact: "01-triage.md", verdict: "CONFIRMED", env });
  recordPhaseDone({ ...RUN, phase: "explore", artifact: "02-explore.md", verdict: "ok", note: "index refreshed", env });
  recordOutcome({ ...RUN, status: "gate", notice: "the operator has to choose", env });

  const state = readState(env);
  assert.deepEqual(state.phases.map((entry) => entry.phase), ["triage", "explore"]);
  assert.equal(state.phases[1].note, "index refreshed");
  assert.equal(state.type, "bug/error");
  assert.equal(state.outcome.status, "gate");
});

test("an updatedAt written by an older plugin is overwritten by the clock, and a stale key of an older state is left alone", (t) => {
  const env = makeHome(t, "run-state-updated-at");
  writeState(env, { schemaVersion: 1, project: "alpha", slug: "fix-the-worker", staleKey: 1, updatedAt: "yesterday", phases: [] });

  assert.equal(recordPhaseDone({ ...RUN, phase: "triage", artifact: "01-triage.md", env }).status, "written");
  const state = readState(env);
  assert.match(state.updatedAt, UTC_ISO);
  assert.equal(state.staleKey, 1);
});

// The skips of the run on disk, each reduced to its author.
function skipAuthors(env) {
  return Object.fromEntries(Object.entries(readState(env).skips ?? {}).map(([phase, entry]) => [phase, entry.by]));
}

test("a type write records no skip: every run executes every phase", (t) => {
  const env = makeHome(t, "run-state-no-type-skips");
  assert.equal(recordRunFields({ ...RUN, fields: { branch: "fix/the-worker" }, env }).status, "written");
  assert.equal(recordRunFields({ ...RUN, fields: { type: "bug/error" }, env }).status, "written");
  assert.equal(recordRunFields({ ...RUN, fields: { type: "feature/refactor" }, env }).status, "written");
  assert.equal("skips" in readState(env), false, "a type write wrote skips");
  assert.deepEqual(skipAuthors(env), {});
});

test("an unsafe project or slug records nothing at all", (t) => {
  const env = makeHome(t, "run-state-unsafe");
  for (const run of [{ projectId: "../escape", slug: "fix-the-worker" }, { projectId: "alpha", slug: "fix-the-worker" }, { projectId: FIXED_PROJECT_ID, slug: "../escape" }]) {
    const written = recordPhaseDone({ ...run, phase: "triage", artifact: "01-triage.md", env });
    assert.deepEqual({ status: written.status, path: written.path }, { status: "kept", path: null });
  }
});
