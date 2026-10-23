import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { withLockSync } from "../../src/config/lock.mjs";
import { runDir } from "../../src/config/paths.mjs";
import { decideResume } from "../../src/queue/resume.mjs";
import {
  clearTermination,
  recordCheck,
  recordOutcome,
  recordPhaseDone,
  recordPrTemplate,
  recordPrUrl,
  recordResume,
  recordRunFields,
  recordSkip,
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
    { schemaVersion: state.schemaVersion, projectId: state.projectId, slug: state.slug, resumeCount: state.resumeCount },
    { schemaVersion: 1, projectId: FIXED_PROJECT_ID, slug: "fix-the-worker", resumeCount: 0 },
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

test("a plain `run_phase_done` repeating the runtime's last entry merges into it; a reason, another phase or another artifact appends", (t) => {
  const env = makeHome(t, "run-state-phase-merge");
  recordPhaseDone({ ...RUN, phase: "implementation", artifact: "04-implementation.md", verdict: "OK", by: "runtime", env });

  recordPhaseDone({ ...RUN, phase: "implementation", artifact: "04-implementation.md", verdict: "done", note: "by hand", env });
  recordPhaseDone({ ...RUN, phase: "implementation", verdict: "done again", env });
  assert.equal(readState(env).phases.length, 1, "an older SKILL's repeat of the runtime's record doubled the row");
  assert.deepEqual([readState(env).phases[0].verdict, readState(env).phases[0].note, readState(env).phases[0].by], ["done again", "by hand", "runtime"]);

  recordPhaseDone({ ...RUN, phase: "implementation", artifact: "04-implementation.md", reason: "fix loop 1", env });
  recordPhaseDone({ ...RUN, phase: "implementation", artifact: "04-implementation.md", verdict: "x", by: "runtime", env });
  recordPhaseDone({ ...RUN, phase: "implementation", artifact: "other.md", env });
  recordPhaseDone({ ...RUN, phase: "qa", env });
  assert.deepEqual(readState(env).phases.map((entry) => entry.phase), ["implementation", "implementation", "implementation", "implementation", "qa"]);
});

test("a check memo replaces the check's previous one, and only a memo that did not pass becomes the run's last failure", (t) => {
  const env = makeHome(t, "run-state-check-memo");
  const failing = { line: "GATE: runtime-not-met — x", ok: false, completed: false, digest: "a" };
  assert.equal(recordCheck({ ...RUN, check: "06.5", memo: failing, env }).phase, null);
  const passing = { line: "OK", ok: true, completed: true, digest: "b" };
  const written = recordCheck({ ...RUN, check: "06.5", memo: passing, done: { phase: "runtime", artifact: "06-runtime.md", verdict: "CONFIRMED" }, env });
  assert.deepEqual(written.phase, { status: "appended", reason: "GATE: runtime-not-met — x" });
  const state = readState(env);
  assert.deepEqual([state.checks["06.5"].line, state.checks["06.5"].ok, state.checks.lastFailure.line], ["OK", true, "GATE: runtime-not-met — x"]);
  assert.equal(state.phases[0].by, "runtime");
  const again = recordCheck({ ...RUN, check: "06.5", memo: passing, done: { phase: "runtime", artifact: "06-runtime.md", verdict: "CONFIRMED" }, env });
  assert.deepEqual(again.phase, { status: "already", reason: null });
  assert.equal(readState(env).phases.length, 1);
  assert.equal(recordCheck({ ...RUN, check: "06.5", memo: passing, done: { phase: "nope" }, env }).status, "kept");
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
  assert.equal(decideResume({ state }).reason, "terminated-by-verdict");
});

test("run fields refuse an unknown field and a value outside the enum, and record the ones they own", (t) => {
  const env = makeHome(t, "run-state-fields");

  assert.match(recordRunFields({ ...RUN, fields: {}, env }).reason, /no field to record; accepted: type, tier, tierRaiseReason, branch, worktree/);
  assert.match(recordRunFields({ ...RUN, fields: { slug: "other-run" }, env }).reason, /unknown field `slug`/);
  assert.match(recordRunFields({ ...RUN, fields: { tier: "huge" }, env }).reason, /unknown tier `huge`; accepted: trivial, simple, complex/);
  assert.match(recordRunFields({ ...RUN, fields: { branch: "  " }, env }).reason, /field `branch` cannot be empty/);
  assert.match(recordRunFields({ ...RUN, fields: { qaStageA: { verdict: "BREAKS-FOUND" } }, env }).reason, /field `qaStageA` needs the `artifact`/);
  assert.match(recordRunFields({ ...RUN, fields: { qaStageA: "05a-qa-analyst.md" }, env }).reason, /field `qaStageA` needs the `artifact`/);
  assert.equal(existsSync(join(runDir(RUN.projectId, RUN.slug, env), "state.json")), false, "a refused record created the file");

  assert.equal(recordRunFields({ ...RUN, fields: { tier: "complex", type: "bug/error", branch: "fix/the-worker" }, env }).status, "written");
  const state = readState(env);
  assert.deepEqual(
    { tier: state.tier, type: state.type, branch: state.branch },
    { tier: "complex", type: "bug/error", branch: "fix/the-worker" },
  );
});

test("the operator fields accept only their enums, and the evidence level is kept as an integer", (t) => {
  const env = makeHome(t, "run-state-operator-fields");

  assert.match(recordRunFields({ ...RUN, fields: { origin: "x" }, env }).reason, /unknown origin `x`; accepted: operator/);
  assert.match(recordRunFields({ ...RUN, fields: { evidenceLevel: 0 }, env }).reason, /unknown evidenceLevel `0`; accepted: 1, 2, 3, 4/);
  assert.match(recordRunFields({ ...RUN, fields: { evidenceLevel: "3" }, env }).reason, /unknown evidenceLevel `3`/);
  assert.match(recordRunFields({ ...RUN, fields: { evidenceLevel: 2.5 }, env }).reason, /unknown evidenceLevel/);
  assert.match(recordRunFields({ ...RUN, fields: { planStatus: "final" }, env }).reason, /unknown planStatus `final`; accepted: draft, approved/);
  assert.equal(existsSync(join(runDir(RUN.projectId, RUN.slug, env), "state.json")), false, "a refused record created the file");

  const written = recordRunFields({ ...RUN, fields: { origin: "operator", evidenceLevel: 3, planStatus: "approved" }, env });
  assert.equal(written.status, "written");
  const state = readState(env);
  assert.deepEqual({ origin: state.origin, evidenceLevel: state.evidenceLevel, planStatus: state.planStatus }, { origin: "operator", evidenceLevel: 3, planStatus: "approved" });
});

test("the writers never lose each other's fields, and the resume decision reads the file they built", (t) => {
  const env = makeHome(t, "run-state-sequence");

  recordRunFields({ ...RUN, fields: { tier: "simple", branch: "fix/the-worker", worktree: "/tmp/wt" }, env });
  recordPhaseDone({ ...RUN, phase: "triage", artifact: "01-triage.md", verdict: "CONFIRMED", env });
  recordPhaseDone({ ...RUN, phase: "explore", artifact: "02-explore.md", verdict: "ok", note: "index refreshed", env });
  recordOutcome({ ...RUN, status: "gate", notice: "the operator has to choose", env });

  const state = readState(env);
  assert.deepEqual(state.phases.map((entry) => entry.phase), ["triage", "explore"]);
  assert.equal(state.phases[1].note, "index refreshed");
  assert.equal(state.tier, "simple");
  assert.equal(state.outcome.status, "gate");
  assert.deepEqual(decideResume({ state }), {
    resume: true,
    fromPhase: "architecture",
    fromStage: null,
    reuseWorktree: true,
    reason: "resume",
    resumeCount: 1,
    lastPhase: "explore",
  });
});

test("the QA stage A marker lives outside `phases` and makes the resume re-enter at stage B", (t) => {
  const env = makeHome(t, "run-state-qa-stage-a");
  for (const phase of ["triage", "explore", "architecture", "implementation"]) {
    recordPhaseDone({ ...RUN, phase, artifact: `0-${phase}.md`, verdict: "ok", env });
  }
  assert.equal(decideResume({ state: readState(env) }).fromStage, null, "the stage was offered before the marker existed");

  const marker = { artifact: " 05a-qa-analyst.md ", verdict: "BREAKS-FOUND" };
  assert.equal(recordRunFields({ ...RUN, fields: { qaStageA: marker }, env }).status, "written");

  const state = readState(env);
  assert.equal(state.qaStageA.artifact, "05a-qa-analyst.md");
  assert.equal(state.qaStageA.verdict, "BREAKS-FOUND");
  assert.match(state.qaStageA.at, UTC_ISO);
  assert.deepEqual(state.phases.map((entry) => entry.phase), ["triage", "explore", "architecture", "implementation"]);
  assert.equal(state.schemaVersion, 1, "the additive marker bumped the schema version");
  assert.deepEqual(
    { fromPhase: decideResume({ state }).fromPhase, fromStage: decideResume({ state }).fromStage },
    { fromPhase: "qa", fromStage: "qa-stage-b" },
  );
});

test("an updatedAt written by an older plugin is overwritten by the clock, and the resume count is never reset", (t) => {
  const env = makeHome(t, "run-state-updated-at");
  writeState(env, { schemaVersion: 1, project: "alpha", slug: "fix-the-worker", resumeCount: 1, updatedAt: "yesterday", phases: [] });

  assert.equal(recordPhaseDone({ ...RUN, phase: "triage", artifact: "01-triage.md", env }).status, "written");
  const state = readState(env);
  assert.match(state.updatedAt, UTC_ISO);
  assert.equal(state.resumeCount, 1, "the record reset the resume count the runtime owns");
  assert.equal(recordResume({ ...RUN, resumeCount: 2, env }).status, "written");
  assert.equal(readState(env).resumeCount, 2);
});

// The skips of the run on disk, each reduced to its author.
function skipAuthors(env) {
  return Object.fromEntries(Object.entries(readState(env).skips ?? {}).map(([phase, entry]) => [phase, entry.by]));
}

test("a tier and type write records the tier skips the routing implies, recomputed on every later tier or type write", (t) => {
  const env = makeHome(t, "run-state-tier-skips");

  assert.equal(recordRunFields({ ...RUN, fields: { branch: "fix/the-worker" }, env }).status, "written");
  assert.equal("skips" in readState(env), false, "a write without tier or type wrote skips");

  assert.equal(recordRunFields({ ...RUN, fields: { tier: "simple", type: "bug/error" }, env }).status, "written");
  assert.deepEqual(skipAuthors(env), { explore: "tier", architecture: "tier", qa: "tier", runtime: "tier" });
  const firstAt = readState(env).skips.explore.at;
  assert.match(firstAt, UTC_ISO);
  assert.equal("reason" in readState(env).skips.explore, false);

  assert.equal(recordRunFields({ ...RUN, fields: { type: "feature/refactor" }, env }).status, "written");
  assert.deepEqual(skipAuthors(env), { explore: "tier", architecture: "tier", qa: "tier", runtime: "tier", triage: "tier" });
  assert.equal(readState(env).skips.explore.at, firstAt, "an existing tier entry keeps its time");

  assert.equal(recordRunFields({ ...RUN, fields: { type: "bug/error" }, env }).status, "written");
  assert.deepEqual(skipAuthors(env), { explore: "tier", architecture: "tier", qa: "tier", runtime: "tier" });
});

test("a type written before the tier records nothing until the tier is known, then the tier alone stands in for an old run", (t) => {
  const env = makeHome(t, "run-state-type-first");
  assert.equal(recordRunFields({ ...RUN, fields: { type: "feature/refactor" }, env }).status, "written");
  assert.equal("skips" in readState(env), false);
  assert.equal(recordRunFields({ ...RUN, fields: { tier: "trivial" }, env }).status, "written");
  assert.deepEqual(skipAuthors(env), { triage: "tier", explore: "tier", architecture: "tier", qa: "tier", runtime: "tier" });
});

test("a raise to complex drops the tier skips and keeps an agent's", (t) => {
  const env = makeHome(t, "run-state-raise-skips");
  recordRunFields({ ...RUN, fields: { tier: "simple", type: "bug/error" }, env });
  assert.equal(recordSkip({ ...RUN, phase: "runtime", by: "verifier", reason: "nothing to run", env }).status, "written");
  assert.equal(recordRunFields({ ...RUN, fields: { tier: "complex", tierRaiseReason: "the cause is in the store" }, env }).status, "written");
  assert.deepEqual(readState(env).skips, { runtime: { by: "verifier", reason: "nothing to run", at: readState(env).skips.runtime.at } });
});

test("an agent skip wins over the tier entry of the same phase and survives a type write", (t) => {
  const env = makeHome(t, "run-state-agent-wins");
  recordRunFields({ ...RUN, fields: { tier: "simple", type: "bug/error" }, env });
  assert.equal(recordSkip({ ...RUN, phase: "qa", by: "architect", reason: "docs only", env }).status, "written");
  recordRunFields({ ...RUN, fields: { type: "feature/refactor" }, env });
  assert.deepEqual(readState(env).skips.qa.by, "architect");
  assert.equal(readState(env).skips.qa.reason, "docs only");
});

test("a skip is refused for a phase already run, the runtime's own author, an empty reason and an unknown phase", (t) => {
  const env = makeHome(t, "run-state-skip-refusals");
  recordPhaseDone({ ...RUN, phase: "triage", artifact: "01-triage.md", env });

  assert.match(recordSkip({ ...RUN, phase: "triage", by: "architect", reason: "late", env }).reason, /`triage` already ran: only a later phase can be skipped/);
  assert.match(recordSkip({ ...RUN, phase: "qa", by: "tier", reason: "mine", env }).reason, /`tier` skips are written by the runtime only/);
  assert.match(recordSkip({ ...RUN, phase: "qa", by: "operator", reason: "mine", env }).reason, /unknown by `operator`; accepted: orchestrator, triager/);
  assert.match(recordSkip({ ...RUN, phase: "qa", by: "architect", reason: "   ", env }).reason, /a skip needs a reason/);
  assert.match(recordSkip({ ...RUN, phase: "critique", by: "architect", reason: "x", env }).reason, /unknown phase `critique`/);
  assert.equal("skips" in readState(env), false, "a refused skip was recorded");
});

test("a recorded skip never moves the resume decision", (t) => {
  const env = makeHome(t, "run-state-skip-resume");
  for (const phase of ["triage", "explore", "architecture", "implementation"]) recordPhaseDone({ ...RUN, phase, artifact: `0-${phase}.md`, env });
  recordOutcome({ ...RUN, status: "gate", notice: "stopped", env });
  const without = decideResume({ state: readState(env) });
  assert.equal(recordSkip({ ...RUN, phase: "qa", by: "architect", reason: "docs only", env }).status, "written");
  const state = readState(env);
  assert.deepEqual(state.phases.map((entry) => entry.phase), ["triage", "explore", "architecture", "implementation"], "a skip went into phases");
  assert.deepEqual(decideResume({ state }), without);
  assert.equal(without.fromPhase, "qa");
});

test("an unsafe project or slug records nothing at all", (t) => {
  const env = makeHome(t, "run-state-unsafe");
  for (const run of [{ projectId: "../escape", slug: "fix-the-worker" }, { projectId: "alpha", slug: "fix-the-worker" }, { projectId: FIXED_PROJECT_ID, slug: "../escape" }]) {
    const written = recordPhaseDone({ ...run, phase: "triage", artifact: "01-triage.md", env });
    assert.deepEqual({ status: written.status, path: written.path }, { status: "kept", path: null });
  }
});
