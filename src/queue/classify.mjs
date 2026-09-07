import { extractNoticeFromStream, extractPrUrl, extractResultText, hasGateMarker, hasGateMarkerInStream } from "./stream.mjs";

const BACKOFF_BASE_MS = 5000;
const BACKOFF_FACTOR = 3;
const BACKOFF_CAP_MS = 60000;

// Explicit precedence of the outcome: a stop wins over a timeout, and a timeout is never a retryable failure.
function decideStatus({ exitCode, timedOut, idleTimedOut, stopped, prUrl, gate }) {
  if (stopped) return "cancelled";
  if (timedOut || idleTimedOut) return "failed";
  if (exitCode !== 0) return "failed";
  if (prUrl && !gate) return "done";
  return "gate";
}

// Classifies one attempt of a job from its stream and how the process ended.
export function classifyJobResult({ log, exitCode, timedOut = false, idleTimedOut = false, stopped = false } = {}) {
  const resultText = extractResultText(log) ?? "";
  const prUrl = extractPrUrl(resultText);
  const noticeMd = extractNoticeFromStream(log);
  const gate = hasGateMarker(resultText) || hasGateMarkerInStream(log);
  return { status: decideStatus({ exitCode, timedOut, idleTimedOut, stopped, prUrl, gate }), prUrl, noticeMd, resultText };
}

// Tells whether the failure was a transient network or provider overload, the only kind worth an automatic retry.
export function isTransientFailure(log) {
  const text = String(log ?? "");
  const httpCode =
    /\b(?:HTTP|status|error)\b\W{0,2}(?:429|500|502|503|529)\b/i.test(text) ||
    /\b(?:429|500|502|503|529)\b\s+(?:Too Many Requests|Bad Gateway|Service Unavailable|Overloaded)/i.test(text);
  return (
    httpCode ||
    /overloaded/i.test(text) ||
    /rate[_-]?limit/i.test(text) ||
    /connection error/i.test(text) ||
    /\bECONNRESET\b/.test(text) ||
    /\bETIMEDOUT\b/.test(text) ||
    /fetch failed/i.test(text)
  );
}

// Exponential backoff of the given attempt: 5s, 15s, 45s, capped at 60s.
export function backoffMs(attempt) {
  const spent = Number.isInteger(attempt) && attempt > 0 ? attempt : 1;
  return Math.min(BACKOFF_BASE_MS * BACKOFF_FACTOR ** (spent - 1), BACKOFF_CAP_MS);
}
