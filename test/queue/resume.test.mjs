import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { runDir } from "../../src/config/paths.mjs";
import { clearRunOutcome, decideResume, isSafeSegment, readRunState, RESUME_PHASE_ORDER, resumeHandoff } from "../../src/queue/resume.mjs";
import { buildPrompt } from "../../src/queue/spawn.mjs";
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

test("clearRunOutcome drops the record of the previous attempt and keeps everything else the run wrote", (t) => {
  const env = makeHome(t, "resume-clear-outcome");
  const terminal = { status: "gate", prUrl: null, finishedAt: "2026-09-14T00:00:00Z" };
  writeState(env, {
    project: "alpha",
    slug: "fix-the-worker",
    content: state({ outcome: { status: "done", prUrl: "https://github.com/acme/api/pull/42" }, terminal }),
  });

  assert.equal(clearRunOutcome({ project: "alpha", slug: "fix-the-worker", env }).status, "written");
  const cleared = readRunState({ project: "alpha", slug: "fix-the-worker", env });
  assert.equal(cleared.outcome, undefined, "the record of the previous attempt survived the clear");
  assert.deepEqual(cleared.terminal, terminal, "clearing the record threw away the witness");
  assert.equal(cleared.schemaVersion, 1);
  assert.equal(cleared.phases.length, 2);
  assert.equal(decideResume({ state: cleared }).fromPhase, "architecture", "the resume decision changed with the clear");

  assert.equal(clearRunOutcome({ project: "alpha", slug: "fix-the-worker", env }).status, "absent", "a state with no record was rewritten");
  assert.equal(clearRunOutcome({ project: "alpha", slug: "never-ran", env }).status, "absent");
  assert.equal(existsSync(join(runDir("alpha", "never-ran", env), "state.json")), false, "the clear created a state.json");
  assert.equal(clearRunOutcome({ project: "alpha", slug: "../../escape", env }).status, "absent");
});

test("the handoff tells the agent where the run lives, what it kept and which phase comes next", (t) => {
  const env = makeHome(t, "resume-handoff");
  const job = { id: 7, project: "alpha", slug: "fix-the-worker" };
  const written = state({ phases: ["triage", "explore", "architecture", "implementation"], qaStageA: { artifact: "05a-qa-analyst.md" } });
  writeState(env, { project: "alpha", slug: job.slug, content: written });
  const stored = readRunState({ project: "alpha", slug: job.slug, env });

  assert.deepEqual(resumeHandoff({ job, resume: decideResume({ state: stored }), state: stored, env }), {
    slug: "fix-the-worker",
    runDir: runDir("alpha", "fix-the-worker", env),
    branch: "fix/the-worker",
    worktree: "/tmp/worktrees/fix-the-worker",
    lastPhase: "implementation",
    fromPhase: "qa",
    fromStage: "qa-stage-b",
  });

  const bare = state({ branch: "  ", worktree: undefined });
  const plain = resumeHandoff({ job, resume: decideResume({ state: bare }), state: bare, env });
  assert.deepEqual({ branch: plain.branch, worktree: plain.worktree, fromStage: plain.fromStage }, { branch: null, worktree: null, fromStage: null });
});

test("there is no handoff when the decision refuses, when the job has no safe slug or when the project is not a name", (t) => {
  const env = makeHome(t, "resume-handoff-refused");
  const job = { id: 7, project: "alpha", slug: "fix-the-worker" };
  const resume = decideResume({ state: state() });

  assert.equal(resumeHandoff({ job, resume: decideResume({ state: null }), state: null, env }), null);
  assert.equal(resumeHandoff({ job, resume: decideResume({ state: state({ resumeCount: 1 }) }), state: state(), env }), null);
  assert.equal(resumeHandoff({ job: { ...job, slug: "../../escape" }, resume, state: state(), env }), null);
  assert.equal(resumeHandoff({ job: { ...job, slug: null }, resume, state: state(), env }), null);
  assert.equal(resumeHandoff({ job: { ...job, project: "../../etc" }, resume, state: state(), env }), null);
  assert.equal(resumeHandoff({}), null);
  assert.equal(resumeHandoff({ job, resume, state: "not an object", env }).branch, null, "a broken state stopped the handoff instead of degrading it");
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

// A state.json an operator session recorded: no branch nor worktree, and `origin: operator`.
function operatorState({ phases = ["triage"], resumeCount = 0, ...extra } = {}) {
  const { branch, worktree, ...base } = state({ phases, resumeCount });
  return { ...base, origin: "operator", ...extra };
}

// The prompt the runner builds for a job resumed from the given state.
function resumePrompt(recorded) {
  const job = { id: 7, project: "alpha", slug: "fix-the-worker", prompt: "p" };
  const handoff = resumeHandoff({ job, resume: decideResume({ state: recorded }), state: recorded, env: { NIGHTSHIFT_HOME: "/tmp/ns" } });
  return buildPrompt({ job, handoff });
}

test("an operator run with a triage at evidence level 3 resumes at explore, with nothing to re-run", () => {
  const recorded = operatorState({ evidenceLevel: 3 });
  const decision = decideResume({ state: recorded });
  assert.equal(decision.fromPhase, "explore");
  assert.equal(decision.reuseWorktree, false);
  assert.equal("reruns" in decision, false);
  assert.ok(resumePrompt(recorded).includes("Resume from phase: explore"));
});

test("an operator run whose bug triage stopped below level 3 re-runs the triage, and says so in the prompt", () => {
  const recorded = operatorState({ evidenceLevel: 2 });
  const decision = decideResume({ state: recorded });
  assert.equal(decision.resume, true);
  assert.equal(decision.fromPhase, "triage");
  assert.equal(decision.lastPhase, null);
  assert.equal(decision.reason, "operator-rerun");
  assert.equal(decision.reruns[0].phase, "triage");
  assert.match(decision.reruns[0].reason, /evidence level 2/);
  const prompt = resumePrompt(recorded);
  assert.ok(prompt.includes("Re-run: triage"), prompt);
  assert.ok(prompt.includes("Last completed phase: none"), prompt);
});

test("an operator run resumes at implementation only with an approved plan, and re-runs a draft architecture", () => {
  const phases = ["triage", "explore", "architecture"];
  const approved = decideResume({ state: operatorState({ phases, evidenceLevel: 3, planStatus: "approved" }) });
  assert.equal(approved.fromPhase, "implementation");
  assert.equal("reruns" in approved, false);

  const draft = decideResume({ state: operatorState({ phases, evidenceLevel: 3, planStatus: "draft" }) });
  assert.equal(draft.fromPhase, "architecture");
  assert.equal(draft.lastPhase, "explore");
  assert.deepEqual(draft.reruns.map((rerun) => rerun.phase), ["architecture"]);
  assert.match(draft.reruns[0].reason, /plan status draft/);

  const unrecorded = decideResume({ state: operatorState({ phases, evidenceLevel: 3 }) });
  assert.match(unrecorded.reruns[0].reason, /plan status not recorded/);
});

test("the triage trap reads a missing type as a bug, and never applies to a feature", () => {
  const { type, ...untyped } = operatorState({ evidenceLevel: 2 });
  assert.equal(decideResume({ state: untyped }).fromPhase, "triage");
  const unrecorded = decideResume({ state: operatorState({}) });
  assert.match(unrecorded.reruns[0].reason, /evidence level not recorded/);
  const feature = decideResume({ state: operatorState({ type: "feature/refactor" }) });
  assert.equal(feature.fromPhase, "explore");
  assert.equal("reruns" in feature, false);
});

test("the operator handoff does not spend the job's own resume, and the cap still bites after it", () => {
  assert.equal(decideResume({ state: operatorState({ evidenceLevel: 3, resumeCount: 1 }) }).fromPhase, "explore");
  assert.equal(decideResume({ state: operatorState({ evidenceLevel: 3, resumeCount: 2 }) }).reason, "resume-cap");
});

test("a trapped triage is re-run even when its recorded verdict would have closed the run", () => {
  const recorded = operatorState({ evidenceLevel: 2 });
  recorded.phases[0].verdict = "NOT-REPRODUCIBLE";
  const decision = decideResume({ state: recorded });
  assert.equal(decision.resume, true);
  assert.equal(decision.fromPhase, "triage");
});

test("a run with no operator origin takes exactly the decision it took before", () => {
  const phases = ["triage", "explore", "architecture"];
  assert.deepEqual(decideResume({ state: state({ phases, evidenceLevel: 1 }) }), {
    resume: true,
    fromPhase: "implementation",
    fromStage: null,
    reuseWorktree: true,
    reason: "resume",
    resumeCount: 1,
    lastPhase: "architecture",
  });
  assert.equal(decideResume({ state: state({ phases, resumeCount: 1 }) }).reason, "resume-cap");
});
