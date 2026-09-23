// H3 (05a-qa-analyst.md, Group B) — a hand-crafted operator state.json that already recorded BOTH
// the "triage" and the "architecture" phase (a state the real pipeline would never reach on its
// own without first clearing the triage trap, but a manually edited/replayed state.json can) makes
// `decideResume` resume from "triage" while STILL attaching an "architecture" rerun line the agent
// cannot act on yet — it has not reached architecture in this resume, so re-running it is unearned
// noise in the handoff prompt. `operatorReruns` reads the raw, unfiltered `state.phases`, not
// `phasesBeforeRerun`'s output, so both traps fire together even though only the earliest one
// (triage) governs where the resume actually restarts.
import assert from "node:assert/strict";
import { test } from "node:test";
import { decideResume, resumeHandoff } from "../../src/queue/resume.mjs";
import { buildPrompt } from "../../src/queue/spawn.mjs";

// A state.json an operator session recorded: no branch nor worktree, and `origin: operator`.
// Mirrors test/queue/resume.test.mjs's own `operatorState` helper so the fixture shape matches
// what the rest of the suite already exercises.
function operatorState({ phases, resumeCount = 0, ...extra } = {}) {
  return {
    schemaVersion: 1,
    slug: "fix-the-worker",
    project: "alpha",
    tier: "simple",
    type: "bug/error",
    resumeCount,
    updatedAt: "2026-09-06T00:00:00Z",
    phases: phases.map((phase) => ({ phase, artifact: `0X-${phase}.md`, verdict: "ok" })),
    origin: "operator",
    ...extra,
  };
}

test("a double-trap operator state.json resumes at triage without an unearned architecture rerun line", () => {
  // Both traps are armed in the recorded phases: evidence level 2 (< 3) on a bug leaves the
  // "triage" trap set, and plan status "draft" leaves the "architecture" trap set, on a state.json
  // that already recorded both phases as done.
  const recorded = operatorState({ phases: ["triage", "architecture"], evidenceLevel: 2, planStatus: "draft" });
  const decision = decideResume({ state: recorded });

  // The earliest trap governs where the resume actually restarts: triage.
  assert.equal(decision.resume, true);
  assert.equal(decision.fromPhase, "triage");

  // The resume has not reached architecture yet — this run of the pipeline will re-decide the
  // architecture trap for itself once it gets there. Attaching an "architecture" rerun line NOW,
  // alongside "triage", tells the agent to re-run a phase it cannot even reach in this resume.
  assert.deepEqual(
    decision.reruns.map((rerun) => rerun.phase),
    ["triage"],
    `expected only the earliest trap (triage) in reruns, got ${JSON.stringify(decision.reruns.map((r) => r.phase))}`,
  );

  // The handoff prompt actually shown to the resuming agent must not carry the unearned line.
  const job = { id: 7, project: "alpha", slug: "fix-the-worker", prompt: "p" };
  const handoff = resumeHandoff({ job, resume: decision, state: recorded, env: { NIGHTSHIFT_HOME: "/tmp/ns" } });
  const prompt = buildPrompt({ job, handoff });
  assert.ok(prompt.includes("Re-run: triage"), prompt);
  assert.ok(!prompt.includes("Re-run: architecture"), prompt);
});
