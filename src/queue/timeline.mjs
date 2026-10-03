import { routingRow, trackPhaseNumbers } from "./routing.mjs";

const PHASE_NAMES = new Map([
  [0, "brief"],
  [1, "triager"],
  [2, "explore"],
  [3, "architect"],
  [4, "coder"],
  [5, "qa-guardian"],
  [6, "verifier"],
  [7, "runtime"],
  [8, "commit · PR"],
]);

const ROUTING_AGENTS = new Map([
  [1, "triager"],
  [2, "explore"],
  [3, "architect"],
  [4, "coder"],
  [5, "qaGuardian"],
  [6, "verifier"],
]);

const LANE_PHASES = new Set(ROUTING_AGENTS.keys());

// The elapsed time of a narration event, null when the narrator had no clock for it.
function offsetOf(event) {
  return Number.isFinite(event?.elapsedMs) ? event.elapsedMs : null;
}

// Tells whether a narration event marks the start of a pipeline phase: a lane opening or an orchestrator phase command.
function phaseStartOf(event) {
  if (!Number.isInteger(event?.phase)) return null;
  if (event.kind === "laneOpen" || event.kind === "tool") return event.phase;
  return null;
}

// Where a lane close puts the end of its phase: the later of the clock at the close and the lane's own reported duration from its opening.
function laneEnd(event, openedAt) {
  const atClose = offsetOf(event);
  const reported = openedAt !== null && Number.isFinite(event.durationMs) ? openedAt + event.durationMs : null;
  if (atClose === null) return reported;
  return reported === null ? atClose : Math.max(atClose, reported);
}

// The first start, the last lane close and the model of every phase the events reached.
function collectSpans(events) {
  const spans = new Map();
  const lastOpen = new Map();
  if (events.length) spans.set(0, { start: 0, end: null, model: null });
  for (const event of events) {
    const phase = phaseStartOf(event);
    if (phase !== null && !spans.has(phase)) spans.set(phase, { start: offsetOf(event), end: null, model: event.model ?? null });
    if (phase !== null && event.kind === "laneOpen") lastOpen.set(phase, offsetOf(event));
    if (event.kind === "laneClose" && Number.isInteger(event.phase) && spans.has(event.phase)) spans.get(event.phase).end = laneEnd(event, lastOpen.get(event.phase) ?? null);
  }
  return spans;
}

// The phase reached after this one, by start time; the end of every phase that has no close of its own.
function nextStart(spans, number) {
  const own = spans.get(number)?.start ?? null;
  const later = [...spans.entries()].filter(([other, span]) => other !== number && span.start !== null && own !== null && span.start > own);
  return later.length ? Math.min(...later.map(([, span]) => span.start)) : null;
}

// Closes the spans of the orchestrator phases (0, 7, 8) at the start of the next phase reached, or at the last event once the job stopped.
function closeOrchestratorSpans(spans, { lastOffset, running }) {
  for (const [number, span] of spans) {
    if (LANE_PHASES.has(number) || span.end !== null) continue;
    span.end = nextStart(spans, number) ?? (running ? null : lastOffset);
  }
}

// The number of the phase the job stands at: the one reached last, by start time.
function currentPhase(spans) {
  let current = null;
  for (const [number, span] of spans) {
    if (current === null || (span.start ?? -1) >= (spans.get(current).start ?? -1)) current = number;
  }
  return current;
}

// The state of one phase of the track, from what the events reached and the status of the job.
function phaseState(number, { spans, current, status, lastReached }) {
  const span = spans.get(number);
  if (!span) return number < lastReached ? "skip" : "pending";
  if (number === current && status === "running") return "now";
  if (number === current && status === "gate") return "gate";
  return span.end !== null || status !== "running" ? "done" : "now";
}

// The model a phase runs on: the one its lane was opened with, else the routing row's for the tier, null for the orchestrator phases.
function phaseModel(number, span, models) {
  if (span?.model) return span.model;
  const agent = ROUTING_AGENTS.get(number);
  return agent ? (models[agent] ?? null) : null;
}

// The phase track of a job's current attempt, derived from its narration events alone and never from state.json.
export function phaseTimeline(events, { tier, status }) {
  const numbers = trackPhaseNumbers(tier);
  if (!numbers) return { track: null, phases: [] };
  const { track, models } = routingRow(tier);
  const list = Array.isArray(events) ? events : [];
  const spans = collectSpans(list);
  const running = status === "running";
  const lastOffset = list.reduce((last, event) => offsetOf(event) ?? last, null);
  closeOrchestratorSpans(spans, { lastOffset, running });
  const current = currentPhase(spans);
  const lastReached = Math.max(-1, ...spans.keys());
  const phases = numbers.map((number) => {
    const span = spans.get(number) ?? null;
    const offsetMs = span?.start ?? null;
    const durationMs = span && span.end !== null && offsetMs !== null ? Math.max(0, span.end - offsetMs) : null;
    return { number, name: PHASE_NAMES.get(number), model: phaseModel(number, span, models), state: phaseState(number, { spans, current, status, lastReached }), offsetMs, durationMs };
  });
  return { track, phases };
}
