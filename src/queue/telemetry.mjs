import { laneName, parseAttemptMarker, parseEventLine } from "./stream.mjs";

// The phase each subagent lane is recorded under in `pipeline_phases`; a lane outside this map has no phase row of its own.
const LANE_PHASES = new Map([
  ["triager", "triage"],
  ["explore", "explore"],
  ["architect", "architecture"],
  ["coder", "implementation"],
  ["qa-guardian", "qa"],
  ["verifier", "verification"],
]);

// Instant of an ISO timestamp in milliseconds, or null when the value is not a date.
function isoMs(value) {
  if (typeof value !== "string" || !value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

// A duration in whole seconds, or null when the milliseconds are not a duration anyone measured.
function durationS(ms) {
  return Number.isFinite(ms) && ms >= 0 ? Math.round(ms / 1000) : null;
}

// Instant an event of the stream happened; only `assistant` and `user` events carry one, and no other type is ever read.
function eventMs(event) {
  return event?.type === "assistant" || event?.type === "user" ? isoMs(event.timestamp) : null;
}

// How long the LAST attempt of a job took, in seconds: from its attempt marker to the last event that carried a clock; null when nothing was timed.
export function runDurationS(log) {
  let startMs = null;
  let lastMs = null;
  for (const line of String(log ?? "").split("\n")) {
    const marker = parseAttemptMarker(line);
    if (marker) {
      startMs = isoMs(marker.at);
      lastMs = null;
      continue;
    }
    const ms = eventMs(parseEventLine(line));
    if (ms === null || startMs === null || ms < startMs) continue;
    lastMs = lastMs === null ? ms : Math.max(lastMs, ms);
  }
  return startMs === null || lastMs === null ? null : durationS(lastMs - startMs);
}

// The lane a `tool_use` block opens: the block carries `subagent_type` and, next to it, the model the orchestrator picked for it.
function laneFromBlock(block) {
  const subagentType = block?.input?.subagent_type;
  if (block?.type !== "tool_use" || typeof subagentType !== "string" || !subagentType.trim()) return null;
  const phase = LANE_PHASES.get(laneName(subagentType));
  if (!phase) return null;
  const model = typeof block.input.model === "string" ? block.input.model.trim() : "";
  return { id: typeof block.id === "string" ? block.id : null, phase, model: model || null, durationS: null };
}

// Registers the lanes an `assistant` event opened, keeping the MOST RECENT opening of a tool id as the one a report closes.
function openLanes(event, lanes, byId) {
  const blocks = Array.isArray(event?.message?.content) ? event.message.content : [];
  for (const block of blocks) {
    const lane = laneFromBlock(block);
    if (!lane) continue;
    lanes.push(lane);
    if (lane.id) byId.set(lane.id, lane);
  }
}

// Closes the lane a `task_notification` reports on, with the duration the host measured for it.
function closeLane(event, byId) {
  const lane = byId.get(event?.tool_use_id);
  if (!lane) return;
  byId.delete(event.tool_use_id);
  lane.durationS = durationS(event.usage?.duration_ms);
}

// Telemetry of every subagent lane of the LAST attempt, in the order they were launched: the phase each one belongs to, the model it ran and how long the host says it took.
// An attempt marker restarts the reading, as it does for the duration: the lanes of an attempt that was retried never speak for the run.
export function phaseTelemetry(log) {
  let lanes = [];
  let byId = new Map();
  for (const line of String(log ?? "").split("\n")) {
    if (parseAttemptMarker(line)) {
      lanes = [];
      byId = new Map();
      continue;
    }
    const event = parseEventLine(line);
    if (event?.type === "assistant") openLanes(event, lanes, byId);
    if (event?.type === "system" && event.subtype === "task_notification") closeLane(event, byId);
  }
  return lanes.map(({ phase, model, durationS: seconds }) => ({ phase, model, durationS: seconds }));
}
