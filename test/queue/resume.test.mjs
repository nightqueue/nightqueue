import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { runDir } from "../../src/config/paths.mjs";
import { decideResume, isSafeSegment, readRunState, RESUME_PHASE_ORDER } from "../../src/queue/resume.mjs";
import { makeHome } from "../../test-support/memory.mjs";

// A state.json in the shape the plugin writes it, with the canonical ENGLISH keys and phase names.
function state({ phases = ["triage", "explore"], resumeCount = 0, ...extra } = {}) {
  return {
    schemaVersion: 1,
    slug: "fix-the-worker",
    project: "alpha",
    tier: "simple",
    type: "bug/error",
    branch: "fix/the-worker",
    worktree: "/tmp/worktrees/fix-the-worker",
    resumeCount,
    updatedAt: "2026-09-06T00:00:00Z",
    phases: phases.map((phase) => ({ phase, artifact: `0X-${phase}.md`, verdict: "ok" })),
    ...extra,
  };
}

// Writes a state.json in the run directory of a project and slug.
function writeState(env, { project, slug, content }) {
  const dir = runDir(project, slug, env);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "state.json"), typeof content === "string" ? content : JSON.stringify(content));
  return join(dir, "state.json");
}

test("the phase order is the canonical contract of the plugin, in english", () => {
  assert.deepEqual(RESUME_PHASE_ORDER, [
    "triage",
    "explore",
    "architecture",
    "implementation",
    "qa",
    "verification",
    "runtime",
    "commit",
  ]);
});

test("a run stopped after a completed phase resumes from the next one and reuses the worktree", () => {
  const decision = decideResume({ state: state({ phases: ["triage", "explore"] }) });
  assert.deepEqual(decision, {
    resume: true,
    fromPhase: "architecture",
    fromStage: null,
    reuseWorktree: true,
    reason: "resume",
    resumeCount: 1,
    lastPhase: "explore",
  });
  assert.equal(decideResume({ state: JSON.stringify(state()) }).resume, true, "a raw string of the file is not parsed");
});

test("the qa stage A marker sends the resume to stage B instead of redoing the analysis", () => {
  const phases = ["triage", "explore", "architecture", "implementation"];
  const plain = decideResume({ state: state({ phases }) });
  assert.deepEqual({ fromPhase: plain.fromPhase, fromStage: plain.fromStage }, { fromPhase: "qa", fromStage: null });
  const staged = decideResume({ state: state({ phases, qaStageA: { artifact: "05a-qa-analyst.md", verdict: "BREAKS-FOUND" } }) });
  assert.deepEqual({ fromPhase: staged.fromPhase, fromStage: staged.fromStage }, { fromPhase: "qa", fromStage: "qa-stage-b" });
  assert.equal(decideResume({ state: state({ phases, qaStageA: "05a-qa-analyst.md" }) }).fromStage, null);
});

test("a state written with the PORTUGUESE keys of another runtime is never resumable", () => {
  const portuguese = {
    schemaVersion: 1,
    slug: "corrigir-o-worker",
    resumeCount: 0,
    fases: [{ fase: "triagem" }, { fase: "arquitetura" }],
    phases: [{ fase: "triagem", artefato: "01-triagem.md", veredito: "ok" }],
  };
  assert.equal(decideResume({ state: portuguese }).resume, false);
  assert.equal(decideResume({ state: portuguese }).reason, "unknown-phase");
  const translatedNames = state({ phases: ["triagem", "exploracao"] });
  assert.equal(decideResume({ state: translatedNames }).reason, "unknown-phase");
  const terminationInPortuguese = state({ encerramento: { fase: "triage", motivo: "nao reproduzivel" } });
  assert.equal(decideResume({ state: terminationInPortuguese }).resume, true, "a portuguese `encerramento` was honoured as a termination");
});

test("a deliberate termination closes the run, whether it came as an object or as a verdict", () => {
  assert.equal(decideResume({ state: state({ termination: { phase: "triage", reason: "not reproducible" } }) }).reason, "terminated-by-verdict");
  assert.equal(decideResume({ state: state({ termination: "closed on purpose" }) }).reason, "terminated-by-verdict");
  assert.equal(decideResume({ state: state({ termination: "   " }) }).resume, true, "an empty termination closed the run");

  const verdict = { schemaVersion: 1, slug: "s", resumeCount: 0, phases: [{ phase: "triage", verdict: "NOT-REPRODUCIBLE" }] };
  assert.equal(decideResume({ state: verdict }).reason, "terminated-by-verdict");
  const clarification = { ...verdict, phases: [{ phase: "triage", verdict: "NEEDS CLARIFICATION: no repro steps" }] };
  const stopped = decideResume({ state: clarification });
  assert.deepEqual({ reason: stopped.reason, lastPhase: stopped.lastPhase }, { reason: "terminated-by-verdict", lastPhase: "triage" });
});

test("the resume budget is spent once: the second stop of the same run stays stopped", () => {
  assert.equal(decideResume({ state: state({ resumeCount: 0 }) }).resumeCount, 1);
  assert.equal(decideResume({ state: state({ resumeCount: 1 }) }).reason, "resume-cap");
  assert.equal(decideResume({ state: state({ resumeCount: 1 }), maxResumes: 2 }).resume, true);
  assert.equal(decideResume({ state: state({ resumeCount: 2 }), maxResumes: 2 }).reason, "resume-cap");
  assert.equal(decideResume({ state: state({ resumeCount: null }) }).reason, "resume-cap");
});

test("every broken state has its own reason and none of them ever throws", () => {
  assert.equal(decideResume({ state: null }).reason, "no-state");
  assert.equal(decideResume({}).reason, "no-state");
  assert.equal(decideResume({ state: "{ not json" }).reason, "corrupt-state");
  assert.equal(decideResume({ state: [] }).reason, "invalid-state");
  assert.equal(decideResume({ state: { slug: "s", phases: [] } }).reason, "invalid-state");
  assert.equal(decideResume({ state: { ...state(), schemaVersion: 2 } }).reason, "unknown-schema");
  assert.equal(decideResume({ state: state({ phases: [] }) }).reason, "no-completed-phase");
  assert.equal(decideResume({ state: state({ phases: [...RESUME_PHASE_ORDER] }) }).reason, "run-already-done");
  for (const decision of [decideResume({ state: null }), decideResume({ state: "{ not json" })]) {
    assert.deepEqual({ resume: decision.resume, fromPhase: decision.fromPhase, reuseWorktree: decision.reuseWorktree }, { resume: false, fromPhase: null, reuseWorktree: false });
  }
});

test("the state file is read from the run directory, and an unsafe segment never becomes a path", (t) => {
  const env = makeHome(t, "resume-read");
  writeState(env, { project: "alpha", slug: "fix-the-worker", content: state() });
  assert.equal(readRunState({ project: "alpha", slug: "fix-the-worker", env }).branch, "fix/the-worker");

  assert.equal(readRunState({ project: "alpha", slug: "missing-run", env }), null);
  assert.equal(readRunState({ project: "alpha", slug: null, env }), null);
  assert.equal(readRunState({ project: "alpha", slug: "../../escape", env }), null);
  assert.equal(readRunState({ project: "../../etc", slug: "fix-the-worker", env }), null);
  assert.equal(isSafeSegment("../../escape"), false);
  assert.equal(isSafeSegment("fix-the-worker"), true);

  writeState(env, { project: "alpha", slug: "broken-run", content: "{ not json" });
  assert.equal(readRunState({ project: "alpha", slug: "broken-run", env }), null);
});
