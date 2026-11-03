import { parseAttemptMarker, parseEventLine } from "./stream.mjs";

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
