import assert from "node:assert/strict";
import { test } from "node:test";
import { narrateLog } from "../../src/queue/narrate.mjs";
import { createTimeline, phaseTimeline } from "../../src/queue/timeline.mjs";
import { agentToolUseEvent, assistantEvent, attemptMarker, resultEvent, secondsIntoAttempt, systemInitEvent, taskNotificationEvent, toNdjson, toolUseEvent, usageBlock } from "../../test-support/streams.mjs";

// A lane opening event, the way the narrator emits it.
function open(phase, agent, elapsedMs, { model = null, laneId = `lane-${phase}-${elapsedMs}` } = {}) {
  return { kind: "laneOpen", phase, agent, model, laneId, elapsedMs };
}

// A lane closing event, the way the narrator emits it.
function close(phase, agent, elapsedMs, { durationMs = null, laneId, laneTokens = null } = {}) {
  return { kind: "laneClose", phase, agent, durationMs, laneId, laneTokens, elapsedMs };
}

// An orchestrator Bash call that marks a phase.
function marker(phase, elapsedMs) {
  return { kind: "tool", tool: "Bash", phase, indent: false, elapsedMs };
}

// The state of every phase of a timeline, by number.
function states(timeline) {
  return Object.fromEntries(timeline.phases.map((phase) => [phase.number, phase.state]));
}

// One phase of a timeline, by number.
function phaseOf(timeline, number) {
  return timeline.phases.find((phase) => phase.number === number);
}

test("a complex job running its coder has the brief done, the skipped lanes marked and the coder now", () => {
  const events = [{ kind: "attempt", elapsedMs: 0 }, marker(0, 1000), open(4, "coder", 5000, { model: "opus" })];
  const timeline = phaseTimeline(events, { tier: "complex", status: "running" });
  assert.equal(timeline.track, "Standard");
  assert.deepEqual(states(timeline), { 0: "done", 1: "skip", 2: "skip", 3: "skip", 4: "now", 5: "pending", 6: "pending", 7: "pending", 8: "pending" });
  assert.equal(phaseOf(timeline, 0).durationMs, 5000);
  const coder = phaseOf(timeline, 4);
  assert.deepEqual([coder.durationMs, coder.liveSinceMs, coder.model], [0, 5000, "opus"]);
  assert.equal("offsetMs" in coder, false, "the wire carries no start time");
});

test("a fix loop sums its lanes instead of spanning from the first opening to the last close", () => {
  const events = [
    { kind: "attempt", elapsedMs: 0 },
    open(4, "coder", 1000, { laneId: "c1" }),
    close(4, "coder", 3000, { durationMs: 2000, laneId: "c1" }),
    open(6, "verifier", 3000, { laneId: "v1" }),
    close(6, "verifier", 4000, { durationMs: 1000, laneId: "v1" }),
    open(4, "coder", 4000, { laneId: "c2" }),
    close(4, "coder", 9000, { durationMs: 5000, laneId: "c2" }),
  ];
  const timeline = phaseTimeline(events, { tier: "simple", status: "done" });
  const coder = phaseOf(timeline, 4);
  assert.deepEqual([coder.durationMs, coder.state], [7000, "done"]);
  assert.equal(coder.model, "sonnet", "the routing row's model is the fallback when the lane carried none");
});

test("a gate stops the timeline at the last phase reached", () => {
  const events = [{ kind: "attempt", elapsedMs: 0 }, open(1, "triager", 1000, { laneId: "t" }), close(1, "triager", 2000, { durationMs: 1000, laneId: "t" }), open(3, "architect", 2500, { laneId: "a" })];
  const timeline = phaseTimeline(events, { tier: "complex", status: "gate" });
  assert.equal(states(timeline)[3], "gate");
  assert.equal(states(timeline)[1], "done");
  assert.equal(states(timeline)[4], "pending");
});

test("a trivial job that published and reported is done end to end, its orchestrator phases timed between markers", () => {
  const events = [
    { kind: "attempt", elapsedMs: 0 },
    open(4, "coder", 1000, { laneId: "c" }),
    close(4, "coder", 5000, { durationMs: 4000, laneId: "c" }),
    open(6, "verifier", 5000, { laneId: "v" }),
    close(6, "verifier", 6000, { durationMs: 1000, laneId: "v" }),
    marker(7, 7000),
    marker(8, 9000),
    { kind: "resultEnd", elapsedMs: 10000 },
  ];
  const timeline = phaseTimeline(events, { tier: "trivial", status: "done" });
  assert.equal(timeline.track, "Fast Lite");
  assert.deepEqual(timeline.phases.map((phase) => phase.number), [0, 4, 6, 7, 8]);
  assert.deepEqual(new Set(timeline.phases.map((phase) => phase.state)), new Set(["done"]));
  assert.equal(phaseOf(timeline, 0).durationMs, 2000);
  assert.equal(phaseOf(timeline, 7).durationMs, 2000);
  assert.equal(phaseOf(timeline, 8).durationMs, 1000);
});

test("an unknown tier has no track, and no events leave every phase pending", () => {
  assert.deepEqual(phaseTimeline([open(4, "coder", 0)], { tier: null, status: "running" }), { track: null, phases: [], clockMs: 0 });
  const empty = phaseTimeline([], { tier: "simple", status: "pending" });
  assert.deepEqual(new Set(empty.phases.map((phase) => phase.state)), new Set(["pending"]));
  assert.deepEqual(new Set(empty.phases.map((phase) => phase.tokens_label)), new Set(["-"]));
});

test("a gated job with no narrated event stops at the track's first phase", () => {
  const timeline = phaseTimeline([], { tier: "complex", status: "gate" });
  const gated = timeline.phases.filter((phase) => phase.state === "gate");
  assert.deepEqual(
    gated.map((phase) => phase.number),
    [timeline.phases[0].number],
  );
});

test("a lane killed by the attempt boundary counts up to that attempt's last clock reading, and a lane without usage counts its reported tokens", () => {
  const timeline = createTimeline({ tier: "complex" });
  for (const event of [
    { kind: "attempt", elapsedMs: 0 },
    open(1, "triager", 1000, { laneId: "t" }),
    close(1, "triager", 3000, { durationMs: 2000, laneId: "t", laneTokens: 4200 }),
    open(3, "architect", 3000, { laneId: "a" }),
    { kind: "text", indent: true, elapsedMs: 11000 },
    { kind: "attempt", elapsedMs: 0 },
    open(4, "coder", 500, { laneId: "c" }),
  ]) {
    timeline.push(event);
  }
  const snapshot = timeline.snapshot({ status: "running" });
  assert.equal(phaseOf(snapshot, 3).durationMs, 8000);
  assert.equal(phaseOf(snapshot, 3).state, "done");
  assert.deepEqual([phaseOf(snapshot, 1).tokens, phaseOf(snapshot, 1).tokens_label], [4200, "~4k"]);
  assert.equal(phaseOf(snapshot, 4).state, "now");
});

// Attempt 1 runs the triager and stops inside the architect at 00:10.
const GATED_ATTEMPT = [
  { kind: "attempt", text: "attempt 1", elapsedMs: 0 },
  open(1, "triager", 1000, { laneId: "t" }),
  close(1, "triager", 2000, { durationMs: 1000, laneId: "t" }),
  open(3, "architect", 2500, { laneId: "a" }),
  { kind: "text", indent: true, elapsedMs: 10000 },
];

test("a gated job has its stopped phase in the gate state, its time counted to the stop and the job clock at the stop", () => {
  const timeline = phaseTimeline(GATED_ATTEMPT, { tier: "complex", status: "gate" });
  assert.equal(states(timeline)[3], "gate");
  const architect = phaseOf(timeline, 3);
  assert.deepEqual([architect.startMs, architect.attempts, architect.durationMs], [2500, 1, 7500]);
  assert.deepEqual(architect.byAttempt, [{ attempt: 1, durationMs: 7500, last: true }]);
  assert.equal(timeline.clockMs, 10000);
  assert.deepEqual([phaseOf(timeline, 4).startMs, phaseOf(timeline, 4).attempts, phaseOf(timeline, 4).byAttempt], [null, 0, []]);
});

test("a job resumed after a gate counts each phase's attempts, splits their time per attempt and starts later phases on the cumulative clock", () => {
  const resumed = [
    ...GATED_ATTEMPT,
    { kind: "attempt", text: "attempt 2", elapsedMs: 0 },
    open(3, "architect", 1000, { laneId: "a2" }),
    close(3, "architect", 4000, { durationMs: 3000, laneId: "a2" }),
    open(4, "coder", 5000, { laneId: "c" }),
    close(4, "coder", 9000, { durationMs: 4000, laneId: "c" }),
  ];
  const timeline = phaseTimeline(resumed, { tier: "complex", status: "done" });
  assert.equal(new Set(timeline.phases.map((phase) => phase.state)).has("gate"), false);
  const architect = phaseOf(timeline, 3);
  assert.deepEqual([architect.attempts, architect.durationMs, architect.startMs], [2, 10500, 2500]);
  assert.deepEqual(architect.byAttempt, [
    { attempt: 1, durationMs: 7500, last: true },
    { attempt: 2, durationMs: 3000, last: false },
  ]);
  const coder = phaseOf(timeline, 4);
  assert.deepEqual([coder.attempts, coder.startMs], [1, 15000]);
  assert.deepEqual(coder.byAttempt, [{ attempt: 2, durationMs: 4000, last: true }]);
  assert.equal(phaseOf(timeline, 0).attempts, 2, "every attempt passes through the brief");
  assert.equal(phaseOf(timeline, 1).attempts, 1);
  assert.equal(timeline.clockMs, 19000);
});

const ATTEMPT_1 = "2026-09-07T19:50:00.000Z";
const ATTEMPT_2 = "2026-09-07T21:10:00.000Z";

// An event that also carries the usage of its message, the way the CLI writes every assistant event of a turn.
function withUsage(event, tokensIn) {
  event.message.usage = usageBlock({ tokensIn });
  return event;
}

// One subagent lane: its launch, an assistant turn with usage inside it (optionally repeated) and its notification.
function lane({ id, agent, at, durationS, iso, tokens = null, repeat = false, totalTokens = 1200 }) {
  const events = [agentToolUseEvent({ id, subagentType: `nightqueue:${agent}`, description: agent, timestamp: secondsIntoAttempt(at, iso) })];
  if (tokens !== null) {
    const turn = () => assistantEvent(`${agent} at work`, { messageId: `msg_${id}`, usage: { tokensIn: tokens }, parentToolUseId: id, timestamp: secondsIntoAttempt(at + 1, iso) });
    events.push(turn());
    if (repeat) events.push(turn());
  }
  events.push(assistantEvent(`${agent} done`, { messageId: `msg_${id}_end`, parentToolUseId: id, timestamp: secondsIntoAttempt(at + durationS, iso) }));
  events.push(taskNotificationEvent({ toolUseId: id, durationMs: durationS * 1000, totalTokens }));
  return events;
}

// An orchestrator command that marks a phase, with the usage of its own message.
function orchestratorCommand(id, command, at, tokens) {
  return withUsage(toolUseEvent({ id, name: "Bash", input: { command }, timestamp: secondsIntoAttempt(at, ATTEMPT_2) }), tokens);
}

// J-125's shape: attempt 1 runs triager, explore and architect and dies; attempt 2 resumes at the coder and loops coder/qa/verifier before publishing.
function j125Log() {
  const first = [
    systemInitEvent(),
    assistantEvent("reading the brief", { messageId: "msg_o1", usage: { tokensIn: 100 }, timestamp: secondsIntoAttempt(1, ATTEMPT_1) }),
    withUsage(toolUseEvent({ id: "toolu_start", name: "Bash", input: { command: "nightqueue run start --json" }, timestamp: secondsIntoAttempt(2, ATTEMPT_1) }), 10),
    ...lane({ id: "tri", agent: "triager", at: 10, durationS: 60, iso: ATTEMPT_1, tokens: 200, repeat: true }),
    ...lane({ id: "exp", agent: "explore", at: 80, durationS: 90, iso: ATTEMPT_1, tokens: 300 }),
    ...lane({ id: "arc", agent: "architect", at: 180, durationS: 120, iso: ATTEMPT_1, totalTokens: 5000 }),
    resultEvent({ subtype: "error_during_execution" }),
  ];
  const second = [
    systemInitEvent(),
    ...lane({ id: "c1", agent: "coder", at: 5, durationS: 300, iso: ATTEMPT_2, tokens: 1000 }),
    ...lane({ id: "q1", agent: "qa-guardian", at: 320, durationS: 60, iso: ATTEMPT_2, tokens: 400 }),
    ...lane({ id: "v1", agent: "verifier", at: 400, durationS: 100, iso: ATTEMPT_2, tokens: 600 }),
    ...lane({ id: "c2", agent: "coder", at: 520, durationS: 200, iso: ATTEMPT_2, tokens: 700 }),
    ...lane({ id: "q2", agent: "qa-guardian", at: 740, durationS: 40, iso: ATTEMPT_2, tokens: 150 }),
    ...lane({ id: "v2", agent: "verifier", at: 800, durationS: 80, iso: ATTEMPT_2, tokens: 250 }),
    ...lane({ id: "c3", agent: "coder", at: 900, durationS: 50, iso: ATTEMPT_2, tokens: 90 }),
    assistantEvent("all green, publishing", { messageId: "msg_o2", usage: { tokensIn: 50 }, timestamp: secondsIntoAttempt(960, ATTEMPT_2) }),
    orchestratorCommand("toolu_pub", "nightqueue run publish --message-file m.txt", 970, 70),
    assistantEvent("pull request open", { messageId: "msg_o3", usage: { tokensIn: 30 }, timestamp: secondsIntoAttempt(990, ATTEMPT_2) }),
    orchestratorCommand("toolu_rep", "nightqueue run report --json", 1000, 40),
    assistantEvent("reported", { messageId: "msg_o4", usage: { tokensIn: 20 }, timestamp: secondsIntoAttempt(1010, ATTEMPT_2) }),
    resultEvent(),
  ];
  return `${attemptMarker(1, ATTEMPT_1)}\n${toNdjson(first)}${attemptMarker(2, ATTEMPT_2)}\n${toNdjson(second)}`;
}

test("J-125: a job resumed in attempt 2 keeps the phases attempt 1 ran, each summed over its own lanes, with its tokens", () => {
  const timeline = phaseTimeline(narrateLog(j125Log(), { usage: true }), { tier: "complex", status: "done" });
  assert.deepEqual(states(timeline), { 0: "done", 1: "done", 2: "done", 3: "done", 4: "done", 5: "done", 6: "done", 7: "done", 8: "done" });
  for (const phase of timeline.phases) assert.ok(Number.isFinite(phase.durationMs), `phase ${phase.number} has no duration`);
  assert.deepEqual([1, 2, 3].map((number) => phaseOf(timeline, number).durationMs), [60000, 90000, 120000]);
  assert.equal(phaseOf(timeline, 4).durationMs, 550000, "the coder is the sum of its three lanes");
  assert.equal(phaseOf(timeline, 5).durationMs, 100000);
  assert.ok(phaseOf(timeline, 6).durationMs <= 180000, "the verifier never spans the gaps between its rounds");
  assert.equal(phaseOf(timeline, 1).tokens, 200, "a repeated message id counts once");
  assert.deepEqual([2, 4, 5, 6].map((number) => phaseOf(timeline, number).tokens), [300, 1790, 550, 850]);
  assert.equal(phaseOf(timeline, 3).tokens, 5000, "a lane with no assistant usage counts its reported total");
  assert.equal(phaseOf(timeline, 0).tokens, 160, "lane-less usage before the publish marker, both attempts");
  assert.equal(phaseOf(timeline, 7).tokens, 100, "the publish command and what follows it until the report");
  assert.equal(phaseOf(timeline, 8).tokens, 60);
  assert.ok(timeline.phases.every((phase) => phase.tokens_label.startsWith("~") || phase.tokens === 0));
});
