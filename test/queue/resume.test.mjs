import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { runDir } from "../../src/config/paths.mjs";
import { phaseNamesOf } from "../../src/queue/pipeline-package.mjs";
import { isSafeSegment, readRunState, recordsOfClaim, runFacts } from "../../src/queue/resume.mjs";
import { recordHeldWorktree, recordJobBlock } from "../../src/queue/run-state.mjs";
import { buildPrompt } from "../../src/queue/spawn.mjs";
import { FIXED_PROJECT_ID as ALPHA_ID, makeHome } from "../../test-support/memory.mjs";

// A state.json in the shape the plugin writes it, with the canonical ENGLISH keys and phase names.
function state({ phases = ["triage", "explore"], ...extra } = {}) {
  return {
    schemaVersion: 1,
    slug: "fix-the-worker",
    project: "alpha",
    type: "bug/error",
    branch: "fix/the-worker",
    worktree: "/tmp/worktrees/fix-the-worker",
    updatedAt: "2026-09-06T00:00:00Z",
    phases: phases.map((phase) => ({ phase, artifact: `0X-${phase}.md`, verdict: "ok" })),
    ...extra,
  };
}

// Writes a state.json in the run directory of a project and slug.
function writeState(env, { projectId, slug, content }) {
  const dir = runDir(projectId, slug, env);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "state.json"), typeof content === "string" ? content : JSON.stringify(content));
  return join(dir, "state.json");
}

test("the phase names are the enum of the plugin's contract, in english", () => {
  assert.deepEqual(phaseNamesOf(null), ["triage", "explore", "architecture", "implementation", "qa", "verification", "runtime", "commit"]);
});

test("the facts of a state hold its records in the order it recorded them, with the directory given", () => {
  const facts = runFacts(state({ wip: { commit: "abcdef1234", short: "abcdef1", files: ["a.mjs", "b.mjs"] }, answers: [{ text: "go", at: "2026-09-06T01:00:00Z", attempt: 2 }] }), { runDir: "/tmp/run" });
  assert.deepEqual(facts, {
    runDir: "/tmp/run",
    branch: "fix/the-worker",
    worktree: "/tmp/worktrees/fix-the-worker",
    phases: [
      { phase: "triage", verdict: "ok", artifact: "0X-triage.md", at: null },
      { phase: "explore", verdict: "ok", artifact: "0X-explore.md", at: null },
    ],
    answers: [{ text: "go", at: "2026-09-06T01:00:00Z", attempt: 2 }],
    wip: { commit: "abcdef1234", short: "abcdef1", files: ["a.mjs", "b.mjs"] },
  });
});

test("the facts keep a phase name outside the enum and a repeated phase: deciding from them is the pipeline's", () => {
  const facts = runFacts({ phases: [{ phase: "triage", verdict: "NOT-REPRODUCIBLE" }, { phase: "triagem" }, { phase: "triage", verdict: "PROCEED" }] });
  assert.deepEqual(facts.phases.map((entry) => [entry.phase, entry.verdict]), [["triage", "NOT-REPRODUCIBLE"], ["triagem", null], ["triage", "PROCEED"]]);
});

test("a schema version the runtime does not know is no refusal: the facts still come", () => {
  assert.equal(runFacts({ ...state(), schemaVersion: 2 }).phases.length, 2);
});

test("an unreadable state has no facts, malformed entries are dropped, and nothing ever throws", () => {
  for (const held of [null, undefined, "text", 7, [1]]) assert.equal(runFacts(held), null);
  const facts = runFacts({ branch: "  ", worktree: 3, phases: [null, 3, "qa", {}, { phase: " " }, { phase: "qa", verdict: 1 }], answers: "junk", wip: { files: [] } });
  assert.deepEqual(facts, { runDir: null, branch: null, worktree: null, phases: [{ phase: "qa", verdict: null, artifact: null, at: null }], answers: [], wip: null });
  assert.deepEqual(runFacts({ answers: [null, {}, { text: " " }, { text: "ok", attempt: "2" }] }).answers, [{ text: "ok", at: null, attempt: null }]);
  assert.deepEqual(runFacts({ wip: { commit: "abcdef1234" } }).wip, { commit: "abcdef1234", short: "abcdef1", files: [] });
});

test("the state file is read from the run directory, and an unsafe segment never becomes a path", (t) => {
  const env = makeHome(t, "resume-read");
  writeState(env, { projectId: ALPHA_ID, slug: "fix-the-worker", content: state() });
  assert.equal(readRunState({ projectId: ALPHA_ID, slug: "fix-the-worker", env }).branch, "fix/the-worker");

  assert.equal(readRunState({ projectId: ALPHA_ID, slug: "missing-run", env }), null);
  assert.equal(readRunState({ projectId: ALPHA_ID, slug: null, env }), null);
  assert.equal(readRunState({ projectId: ALPHA_ID, slug: "../../escape", env }), null);
  assert.equal(readRunState({ projectId: "../../etc", slug: "fix-the-worker", env }), null);
  assert.equal(readRunState({ projectId: "alpha", slug: "fix-the-worker", env }), null);
  assert.equal(isSafeSegment("../../escape"), false);
  assert.equal(isSafeSegment("fix-the-worker"), true);

  writeState(env, { projectId: ALPHA_ID, slug: "broken-run", content: "{ not json" });
  assert.equal(readRunState({ projectId: ALPHA_ID, slug: "broken-run", env }), null);
});

test("the claim's view drops a termination of another attempt and keeps the phases of the earlier claims; an unstamped or own one stays", () => {
  const phases = ["triage", "explore"];
  const stale = state({ phases, termination: { phase: "qa", reason: "Old.", claim: { attempt: 1, session: "s" } } });
  const view = recordsOfClaim(stale, 2);
  assert.equal(view.termination, undefined);
  assert.deepEqual(view.ignoredAttempts, [1]);
  assert.equal(runFacts(view).phases.length, 2, "the phases of an earlier claim are what a retry is handed");

  const own = recordsOfClaim(stale, 1);
  assert.equal(own.termination.reason, "Old.");
  assert.equal(own.ignoredAttempts, undefined);
  const unstamped = recordsOfClaim(state({ phases, termination: { phase: "qa", reason: "Old." } }), 2);
  assert.equal(unstamped.termination.reason, "Old.");
});

test("the claim's view leaves anything that is not a usable state or attempt as it came", () => {
  for (const held of [null, undefined, "text", [1]]) assert.equal(recordsOfClaim(held, 2), held);
  const stale = state({ termination: { phase: "qa", reason: "Old.", claim: { attempt: 1 } } });
  assert.equal(recordsOfClaim(stale, undefined), stale);
  const odd = state({ termination: "legacy text", terminal: { status: "done", claim: "not a stamp" }, ignoredRecords: "junk" });
  assert.deepEqual(recordsOfClaim(odd, 2), odd);
});

test("a first attempt whose state.json holds only the job block and the worktree prints no facts block", (t) => {
  const env = makeHome(t, "resume-job-block-only");
  const slug = "fix-the-worker";
  const block = { id: 3, createdAt: "2026-01-01T00:00:00.000Z" };
  assert.equal(recordJobBlock({ projectId: ALPHA_ID, slug, block, env }).status, "written");
  assert.equal(recordHeldWorktree({ projectId: ALPHA_ID, slug, branch: "fix/the-worker", worktree: "/tmp/wt", env }).status, "written");

  const facts = runFacts(readRunState({ projectId: ALPHA_ID, slug, env }));
  const prompt = buildPrompt({ job: { id: 3, project: "alpha", project_id: ALPHA_ID, slug, prompt: "p" }, facts, env });

  assert.equal(prompt.includes("RUN FACTS"), false, prompt);
});
