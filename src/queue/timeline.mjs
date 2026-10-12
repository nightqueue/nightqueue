import { compactTokens } from "./last-cell.mjs";
import { offTierPhases, routingRow, TRACK_SLOTS, trackPhaseNumbers } from "./routing.mjs";

const ALL_SLOT_NUMBERS = TRACK_SLOTS.map((slot) => slot.number);

// The elapsed time of a narration event, null when the narrator had no clock for it.
function offsetOf(event) {
  return Number.isFinite(event?.elapsedMs) ? event.elapsedMs : null;
}

// The key a lane is tracked by: its tool_use id, else its phase when the stream gave it no id.
function laneKey(event) {
  return typeof event.laneId === "string" && event.laneId ? event.laneId : `phase-${event.phase}`;
}

// The time between two readings of the same attempt's clock, 0 when either is unknown.
function span(fromMs, toMs) {
  return Number.isFinite(fromMs) && Number.isFinite(toMs) ? Math.max(0, toMs - fromMs) : 0;
}

// A fresh accumulator: no phase reached, no lane open, the orchestrator at the brief.
function freshState() {
  return { phases: new Map(), openLanes: new Map(), laneUsage: new Map(), seenMessages: new Set(), orchPhase: 0, idleSince: null, lastElapsed: null, current: null, attempt: null, base: 0 };
}

// The totals of one phase, created the first time the phase is reached, with the attempt it is reached in registered on it.
function phaseEntry(state, number) {
  if (!state.phases.has(number)) state.phases.set(number, { durationMs: 0, tokens: 0, model: null, startMs: state.base + (state.lastElapsed ?? 0), byAttempt: new Map() });
  const entry = state.phases.get(number);
  if (state.attempt !== null && !entry.byAttempt.has(state.attempt)) entry.byAttempt.set(state.attempt, { durationMs: 0, last: false });
  return entry;
}

// Adds time to a phase, both to its total and to the attempt the accumulator is in.
function addDuration(state, number, ms) {
  const entry = phaseEntry(state, number);
  entry.durationMs += ms;
  const slot = entry.byAttempt.get(state.attempt);
  if (slot) slot.durationMs += ms;
}

// Adds lane-less time to the orchestrator phase it belongs to, up to the given clock reading, and closes that idle segment.
function closeIdle(state, atMs) {
  if (state.idleSince === null || state.openLanes.size) return;
  addDuration(state, state.orchPhase, span(state.idleSince, atMs));
  state.idleSince = null;
}

// Starts counting lane-less time again once the last open lane is gone.
function openIdle(state, atMs) {
  if (!state.openLanes.size && state.idleSince === null) state.idleSince = atMs;
}

// Ends the attempt the accumulator is in: lanes that never came back count up to the attempt's last clock reading, and so does the idle segment.
function endAttempt(state) {
  for (const lane of state.openLanes.values()) addDuration(state, lane.phase, span(lane.openedAt, state.lastElapsed));
  state.openLanes.clear();
  closeIdle(state, state.lastElapsed);
}

// Moves the cumulative clock past a finished attempt and marks the phase it stopped in as that attempt's last.
function closeAttempt(state) {
  state.base += state.lastElapsed ?? 0;
  const slot = state.phases.get(state.current)?.byAttempt.get(state.attempt);
  if (slot) slot.last = true;
}

// The number of an attempt, from its `attempt N` text, else the one after the previous attempt.
function attemptNumber(state, event) {
  const match = /^attempt (\d+)/.exec(typeof event?.text === "string" ? event.text : "");
  return match ? Number(match[1]) : (state.attempt ?? 0) + 1;
}

// A new attempt: the previous one ends, the clock restarts and the orchestrator is back at the brief; the current phase is kept.
function onAttempt(state, event, atMs) {
  endAttempt(state);
  if (state.attempt !== null) closeAttempt(state);
  state.attempt = attemptNumber(state, event);
  state.orchPhase = 0;
  state.lastElapsed = atMs;
  state.idleSince = atMs ?? 0;
  phaseEntry(state, 0);
  if (state.current === null) state.current = 0;
}

// A lane opening: the idle segment closes and the lane's phase becomes the current one; a lane already open is not opened twice.
function onLaneOpen(state, event, atMs) {
  if (!Number.isInteger(event.phase) || state.openLanes.has(laneKey(event))) return;
  closeIdle(state, atMs);
  state.openLanes.set(laneKey(event), { phase: event.phase, openedAt: atMs });
  const entry = phaseEntry(state, event.phase);
  if (!entry.model && event.model) entry.model = event.model;
  state.current = event.phase;
}

// A lane closing: its own measured duration is added to its phase, and its reported total stands in when no assistant usage was seen for it.
function onLaneClose(state, event, atMs) {
  state.openLanes.delete(laneKey(event));
  if (Number.isInteger(event.phase)) {
    const entry = phaseEntry(state, event.phase);
    if (Number.isFinite(event.durationMs)) addDuration(state, event.phase, event.durationMs);
    if (Number.isFinite(event.laneTokens) && !(state.laneUsage.get(laneKey(event)) > 0)) entry.tokens += event.laneTokens;
  }
  openIdle(state, atMs);
}

// A lane that never reported back: it counts from its opening to the last clock reading.
function onLaneOrphan(state, event, atMs) {
  const lane = state.openLanes.get(laneKey(event));
  if (lane) addDuration(state, lane.phase, span(lane.openedAt, atMs));
  state.openLanes.delete(laneKey(event));
  openIdle(state, atMs);
}

// An orchestrator command that marks a phase: the idle time so far goes to the previous phase, the rest to the marked one.
function onMarker(state, event, atMs) {
  closeIdle(state, atMs);
  state.orchPhase = event.phase;
  phaseEntry(state, event.phase);
  state.current = event.phase;
  openIdle(state, atMs);
}

// The tokens of one assistant message, counted once per message id: to its lane's phase, else to the orchestrator's.
function onUsage(state, event) {
  if (event.messageId) {
    if (state.seenMessages.has(event.messageId)) return;
    state.seenMessages.add(event.messageId);
  }
  const tokens = Number.isFinite(event.tokens) ? event.tokens : 0;
  const inLane = typeof event.laneId === "string" && event.laneId && Number.isInteger(event.phase);
  phaseEntry(state, inLane ? event.phase : state.orchPhase).tokens += tokens;
  if (inLane) state.laneUsage.set(event.laneId, (state.laneUsage.get(event.laneId) ?? 0) + tokens);
}

// Tells whether a narration event is an orchestrator command that marks a phase.
function isMarker(event) {
  return event.kind === "tool" && Number.isInteger(event.phase) && !event.indent;
}

// Folds one narration event into the accumulator.
function pushEvent(state, event) {
  if (!event || typeof event !== "object") return;
  const atMs = offsetOf(event) ?? state.lastElapsed;
  if (event.kind === "attempt") return onAttempt(state, event, atMs);
  if (state.lastElapsed === null && state.current === null) onAttempt(state, null, atMs);
  if (atMs !== null) state.lastElapsed = atMs;
  if (event.kind === "laneOpen") onLaneOpen(state, event, atMs);
  else if (event.kind === "laneClose") onLaneClose(state, event, atMs);
  else if (event.kind === "laneOrphan") onLaneOrphan(state, event, atMs);
  else if (event.kind === "usage") onUsage(state, event);
  else if (isMarker(event)) onMarker(state, event, atMs);
}

// The model a phase runs on: the one its lane was opened with, else the routing row's for the tier, null for the orchestrator phases and a skipped slot.
function phaseModel(slot, { entry, models, skipped }) {
  if (entry?.model) return entry.model;
  if (skipped || !slot.agent) return null;
  return models[slot.agent] ?? null;
}

// The clock reading since which a phase is still accruing time, null when nothing of it is open.
function liveSince(state, number) {
  const opened = [...state.openLanes.values()].filter((lane) => lane.phase === number).map((lane) => lane.openedAt).filter(Number.isFinite);
  if (state.idleSince !== null && !state.openLanes.size && state.orchPhase === number) opened.push(state.idleSince);
  return opened.length ? Math.min(...opened) : null;
}

// The time still open in a phase at the last clock reading, counted only once the job stopped.
function openTime(state, number) {
  const since = liveSince(state, number);
  return since === null ? 0 : span(since, state.lastElapsed);
}

// The state of a phase the job reached, from every attempt and the status of the job; null for a phase it never reached.
function reachedState(number, { state, status, gatePhase }) {
  const running = status === "running";
  const open = [...state.openLanes.values()].some((lane) => lane.phase === number);
  if (number === state.current && running) return "now";
  if (number === gatePhase && status === "gate") return "gate";
  if (open && running) return "now";
  return state.phases.has(number) ? "done" : null;
}

// The skip record of a slot: an agent's, else the tier's while the slot is off the run's routing, recorded or derived; null for any other slot.
function skipRecordOf(slot, { skips, offTier }) {
  const recorded = slot.phase ? (skips[slot.phase] ?? null) : null;
  if (recorded && recorded.by !== "tier") return recorded;
  if (!offTier.includes(slot.phase)) return null;
  return recorded ?? { by: "tier", reason: null, at: null };
}

// The state of one slot and its skip record: reached wins, then a skip record, then an in-track slot passed over, else pending.
function slotState(slot, context) {
  const reached = reachedState(slot.number, context);
  if (reached) return { state: reached, skipped: null };
  const skipped = skipRecordOf(slot, context);
  if (skipped) return { state: "skipped", skipped };
  const index = context.inTrack.indexOf(slot.number);
  return { state: index !== -1 && index < context.lastReachedIndex ? "skipped" : "pending", skipped: null };
}

// The time a phase spent in each attempt that reached it, in attempt order; once the job stopped, its current attempt takes the still open time and the stopped phase is marked last.
function attemptsWire(state, number, entry, running) {
  if (!entry) return [];
  return [...entry.byAttempt.entries()]
    .sort(([left], [right]) => left - right)
    .map(([attempt, slot]) => {
      const stoppedHere = !running && attempt === state.attempt;
      return { attempt, durationMs: slot.durationMs + (stoppedHere ? openTime(state, number) : 0), last: slot.last || (stoppedHere && number === state.current) };
    });
}

// One phase of the wire: name, routing agent, model, state, skip record, summed duration, the clock its open part runs from, where it started on the job's clock, its attempts and its estimated tokens.
function phaseWire(slot, context) {
  const { state, status, models } = context;
  const number = slot.number;
  const entry = state.phases.get(number) ?? null;
  const running = status === "running";
  const durationMs = entry ? entry.durationMs + (running ? 0 : openTime(state, number)) : null;
  const tokens = entry ? entry.tokens : 0;
  const { state: slotStateName, skipped } = slotState(slot, context);
  return {
    number,
    name: slot.name,
    agent: slot.agent,
    model: phaseModel(slot, { entry, models, skipped: slotStateName === "skipped" }),
    state: slotStateName,
    skipped,
    durationMs,
    liveSinceMs: running ? liveSince(state, number) : null,
    startMs: entry ? entry.startMs : null,
    attempts: entry ? entry.byAttempt.size : 0,
    byAttempt: attemptsWire(state, number, entry, running),
    tokens,
    tokens_label: compactTokens(tokens, { estimated: true }),
  };
}

// The job's active clock at the last reading: every finished attempt's time plus the current one's, null before any attempt.
function clockOf(state) {
  return state.attempt === null ? null : state.base + (state.lastElapsed ?? 0);
}

// A text field of a skip record, or null when it is absent or not text.
function skipText(value) {
  return typeof value === "string" && value ? value : null;
}

// The skip records of a run as the track reads them: only entries naming their author, with their reason and time as text or null.
function readSkips(skips) {
  if (!skips || typeof skips !== "object" || Array.isArray(skips)) return {};
  const valid = Object.entries(skips).filter(([, entry]) => entry && typeof entry === "object" && typeof entry.by === "string" && entry.by);
  return Object.fromEntries(valid.map(([phase, entry]) => [phase, { by: entry.by, reason: skipText(entry.reason), at: skipText(entry.at) }]));
}

// The phase track of a job as it stands: all nine slots, each with what every attempt so far reached or why it is skipped.
function snapshotOf(state, { tier, type, status, skips }) {
  const numbers = trackPhaseNumbers(tier);
  const { track, models } = numbers ? routingRow(tier) : { track: null, models: {} };
  const inTrack = numbers ?? ALL_SLOT_NUMBERS;
  const lastReachedIndex = Math.max(-1, ...inTrack.map((number, index) => (state.phases.has(number) ? index : -1)));
  const gatePhase = state.current ?? inTrack[0];
  const context = { state, status, models, inTrack, lastReachedIndex, gatePhase, skips: readSkips(skips), offTier: offTierPhases(tier, type) };
  const phases = TRACK_SLOTS.map((slot) => phaseWire(slot, context));
  return { track, tier: numbers ? tier : null, phases, clockMs: clockOf(state) };
}

// An accumulator of a job's phase track: narration events of every attempt go in one by one, a snapshot comes out at any time.
export function createTimeline({ tier = null } = {}) {
  const state = freshState();
  return {
    push: (event) => pushEvent(state, event),
    snapshot: ({ status, tier: snapshotTier = tier, type = null, skips = null } = {}) => snapshotOf(state, { tier: snapshotTier, type, status, skips }),
  };
}

// The phase track of a job from a list of its narration events, every attempt included, with the run's recorded skips and type when given.
export function phaseTimeline(events, { tier, type = null, status, skips = null }) {
  const timeline = createTimeline({ tier });
  for (const event of Array.isArray(events) ? events : []) timeline.push(event);
  return timeline.snapshot({ status, type, skips });
}
