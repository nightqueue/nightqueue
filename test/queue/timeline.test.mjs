import assert from "node:assert/strict";
import { test } from "node:test";
import { phaseTimeline } from "../../src/queue/timeline.mjs";

// A lane opening event, the way the narrator emits it.
function open(phase, agent, elapsedMs, model = null) {
  return { kind: "laneOpen", phase, agent, model, elapsedMs };
}

// A lane closing event, the way the narrator emits it.
function close(phase, agent, elapsedMs, durationMs = null) {
  return { kind: "laneClose", phase, agent, durationMs, elapsedMs };
}

// An orchestrator Bash call that marks a phase.
function marker(phase, elapsedMs) {
  return { kind: "tool", tool: "Bash", phase, elapsedMs };
}

// The state of every phase of a timeline, by number.
function states(timeline) {
  return Object.fromEntries(timeline.phases.map((phase) => [phase.number, phase.state]));
}

test("a complex job running its coder has the brief done, the skipped lanes marked and the coder now", () => {
  const events = [{ kind: "attempt", elapsedMs: 0 }, marker(0, 1000), open(4, "coder", 5000, "opus")];
  const timeline = phaseTimeline(events, { tier: "complex", status: "running" });
  assert.equal(timeline.track, "Standard");
  assert.deepEqual(states(timeline), { 0: "done", 1: "skip", 2: "skip", 3: "skip", 4: "now", 5: "pending", 6: "pending", 7: "pending", 8: "pending" });
  const brief = timeline.phases[0];
  assert.deepEqual([brief.offsetMs, brief.durationMs], [0, 5000]);
  const coder = timeline.phases.find((phase) => phase.number === 4);
  assert.deepEqual([coder.offsetMs, coder.durationMs, coder.model], [5000, null, "opus"]);
});

test("a fix loop keeps the first opening and the last close of its phase", () => {
  const events = [{ kind: "attempt", elapsedMs: 0 }, open(4, "coder", 1000), close(4, "coder", 3000), open(6, "verifier", 3000), close(6, "verifier", 4000), open(4, "coder", 4000), close(4, "coder", 9000)];
  const timeline = phaseTimeline(events, { tier: "simple", status: "running" });
  const coder = timeline.phases.find((phase) => phase.number === 4);
  assert.deepEqual([coder.offsetMs, coder.durationMs, coder.state], [1000, 8000, "done"]);
  assert.equal(coder.model, "sonnet", "the routing row's model is the fallback when the lane carried none");
});

test("a gate stops the timeline at the last phase reached", () => {
  const events = [{ kind: "attempt", elapsedMs: 0 }, open(1, "triager", 1000), close(1, "triager", 2000), open(3, "architect", 2500)];
  const timeline = phaseTimeline(events, { tier: "complex", status: "gate" });
  assert.equal(states(timeline)[3], "gate");
  assert.equal(states(timeline)[1], "done");
  assert.equal(states(timeline)[4], "pending");
});

test("a trivial job that published and reported is done end to end", () => {
  const events = [{ kind: "attempt", elapsedMs: 0 }, open(4, "coder", 1000), close(4, "coder", 5000), open(6, "verifier", 5000), close(6, "verifier", 6000), marker(7, 7000), marker(8, 9000), { kind: "resultEnd", elapsedMs: 10000 }];
  const timeline = phaseTimeline(events, { tier: "trivial", status: "done" });
  assert.equal(timeline.track, "Fast Lite");
  assert.deepEqual(timeline.phases.map((phase) => phase.number), [0, 4, 6, 7, 8]);
  assert.deepEqual(new Set(timeline.phases.map((phase) => phase.state)), new Set(["done"]));
  const publish = timeline.phases.find((phase) => phase.number === 7);
  assert.deepEqual([publish.offsetMs, publish.durationMs], [7000, 2000]);
  const report = timeline.phases.find((phase) => phase.number === 8);
  assert.deepEqual([report.offsetMs, report.durationMs], [9000, 1000]);
});

test("an unknown tier has no track, and no events leave every phase pending", () => {
  assert.deepEqual(phaseTimeline([open(4, "coder", 0)], { tier: null, status: "running" }), { track: null, phases: [] });
  const empty = phaseTimeline([], { tier: "simple", status: "pending" });
  assert.deepEqual(new Set(empty.phases.map((phase) => phase.state)), new Set(["pending"]));
});
