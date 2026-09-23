import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { runDir } from "../../src/config/paths.mjs";
import { decideResume } from "../../src/queue/resume.mjs";
import {
  recordOutcome,
  recordPhaseDone,
  recordPrTemplate,
  recordPrUrl,
  recordResume,
  recordRunFields,
  recordTermination,
  RUN_OUTCOME_STATUSES,
} from "../../src/queue/run-state.mjs";
import { makeHome } from "../../test-support/memory.mjs";

const RUN = { project: "alpha", slug: "fix-the-worker" };
const UTC_ISO = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/;

// The state.json of the run as it is on disk right now.
function readState(env) {
  return JSON.parse(readFileSync(join(runDir(RUN.project, RUN.slug, env), "state.json"), "utf8"));
}

// Writes a state.json in the run directory, in the shape another writer would have left it.
function writeState(env, content) {
  const dir = runDir(RUN.project, RUN.slug, env);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "state.json"), JSON.stringify(content));
}

test("a completed phase is appended with the fixed fields of the contract and a real UTC stamp", (t) => {
  const env = makeHome(t, "run-state-phase");

  const written = recordPhaseDone({ ...RUN, phase: "triage", artifact: "01-triage.md", verdict: "CONFIRMED", env });
  assert.equal(written.status, "written", written.reason);

  const state = readState(env);
  assert.deepEqual(
    { schemaVersion: state.schemaVersion, project: state.project, slug: state.slug, resumeCount: state.resumeCount },
    { schemaVersion: 1, project: "alpha", slug: "fix-the-worker", resumeCount: 0 },
  );
  assert.deepEqual(state.phases, [{ phase: "triage", at: state.phases[0].at, artifact: "01-triage.md", verdict: "CONFIRMED" }]);
  assert.match(state.phases[0].at, UTC_ISO);
  assert.match(state.updatedAt, UTC_ISO);
  assert.equal(new Date(state.updatedAt).toISOString(), state.updatedAt, "the stamp is not a real instant read from the clock");
  assert.ok(Math.abs(Date.now() - Date.parse(state.updatedAt)) < 60_000, "the stamp did not come from the clock");
  assert.equal("note" in state.phases[0], false, "an absent note was recorded as an empty key");
});

test("an unknown phase is refused with the accepted list and writes nothing", (t) => {
  const env = makeHome(t, "run-state-unknown-phase");

  const phase = recordPhaseDone({ ...RUN, phase: "triagem", artifact: "01-triagem.md", env });
  assert.equal(phase.status, "kept");
  assert.match(phase.reason, /unknown phase `triagem`; accepted: triage, explore, architecture, implementation, qa, verification, runtime, commit/);

  const termination = recordTermination({ ...RUN, phase: "critique", reason: "no reproduction", env });
  assert.equal(termination.status, "kept");
  assert.match(termination.reason, /unknown phase `critique`/);

  assert.equal(existsSync(join(runDir(RUN.project, RUN.slug, env), "state.json")), false, "a refused record created the file");
});

test("a status outside done|gate is refused, and the notice of a gate is recorded with the outcome", (t) => {
  const env = makeHome(t, "run-state-outcome");
  assert.deepEqual(RUN_OUTCOME_STATUSES, ["done", "gate"]);

  const refused = recordOutcome({ ...RUN, status: "failed", env });
  assert.equal(refused.status, "kept");
  assert.match(refused.reason, /unknown status `failed`; accepted: done, gate/);

  assert.equal(recordOutcome({ ...RUN, status: "gate", notice: "  the migration needs a decision  ", env }).status, "written");
  const state = readState(env);
  assert.equal(state.outcome.status, "gate");
  assert.equal(state.outcome.notice, "the migration needs a decision");
  assert.match(state.outcome.at, UTC_ISO);
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
  assert.equal(existsSync(join(runDir(RUN.project, RUN.slug, env), "state.json")), false, "a refused URL created the file");

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

  for (const template of [null, { source: "other", headings }, { source: "nightshift", headings: "## QA" }, { source: "repo", headings }, { source: "repo", path: " ", headings }]) {
    assert.equal(recordPrTemplate({ ...RUN, template, env }).status, "kept", JSON.stringify(template));
  }
  assert.equal(existsSync(join(runDir(RUN.project, RUN.slug, env), "state.json")), false, "a refused template created the file");

  assert.equal(recordPrTemplate({ ...RUN, template: { source: "repo", path: "CLAUDE.md", headings }, env }).status, "written");
  const { at, ...repo } = readState(env).prTemplate;
  assert.deepEqual(repo, { source: "repo", path: "CLAUDE.md", headings });
  assert.match(at, UTC_ISO);

  assert.equal(recordPrTemplate({ ...RUN, template: { source: "nightshift", path: null, headings: ["## QA"] }, env }).status, "written");
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
  assert.equal(existsSync(join(runDir(RUN.project, RUN.slug, env), "state.json")), false, "a refused record created the file");

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
  assert.equal(existsSync(join(runDir(RUN.project, RUN.slug, env), "state.json")), false, "a refused record created the file");

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

test("an unsafe project or slug records nothing at all", (t) => {
  const env = makeHome(t, "run-state-unsafe");
  for (const run of [{ project: "../escape", slug: "fix-the-worker" }, { project: "alpha", slug: "../escape" }]) {
    const written = recordPhaseDone({ ...run, phase: "triage", artifact: "01-triage.md", env });
    assert.deepEqual({ status: written.status, path: written.path }, { status: "kept", path: null });
  }
});
