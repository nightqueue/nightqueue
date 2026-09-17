import { truncateByCodePoint } from "../memory/jobs.mjs";
import { RUN_OUTCOME_STATUSES } from "./run-state.mjs";
import {
  extractNoticeFromStream,
  extractPrUrlFromStream,
  extractPublishedPrUrl,
  extractResultText,
  hasGateMarker,
  hasGateMarkerInStream,
  isPrUrl,
  prUrlRepo,
  runtimeKillFromStream,
} from "./stream.mjs";

const BACKOFF_BASE_MS = 5000;
const BACKOFF_FACTOR = 3;
const BACKOFF_CAP_MS = 60000;
const NOTICE_FALLBACK_LIMIT = 8000;

export const SILENT_STOP_NOTICE = "Pipeline stopped without a PR and without explanation (exit 0). See the log.";

// Explicit precedence of the outcome: a stop wins over a timeout, a timeout is never a retryable failure, and a clean exit only
// waits at the gate when the run itself asked for a decision (the `gate` boolean) AND said why (a `reason`) — either missing is a failure.
function decideStatus({ exitCode, timedOut, idleTimedOut, stopped, prUrl, gate, reason }) {
  if (stopped) return "cancelled";
  if (timedOut || idleTimedOut) return "failed";
  if (exitCode !== 0) return "failed";
  if (prUrl && !gate) return "done";
  return gate && reason ? "gate" : "failed";
}

// Why the run stopped: state.json is the machine record of the outcome and the `## Notice` is the explanation for the operator — the pipeline had been summarizing the second inside the first, so the notice the run wrote wins, the summary the pipeline recorded is the fallback, and the whole final text is the last resort.
function gateReason(log, resultText, recorded) {
  const notice = extractNoticeFromStream(log);
  if (notice) return notice;
  if (recorded) return recorded;
  const text = String(resultText ?? "").trim();
  return text ? truncateByCodePoint(text, NOTICE_FALLBACK_LIMIT) : null;
}

// Tells whether the process ended cleanly, the only case where a missing reason is a silent stop instead of a real failure.
function endedCleanly({ exitCode, timedOut, idleTimedOut, stopped }) {
  return exitCode === 0 && !timedOut && !idleTimedOut && !stopped;
}

// The `outcome` the pipeline recorded in state.json, field by field; anything outside the contract simply does not participate.
function pipelineOutcome(state) {
  const record = state?.outcome;
  if (!record || typeof record !== "object" || Array.isArray(record)) return null;
  const status = RUN_OUTCOME_STATUSES.includes(record.status) ? record.status : null;
  const prUrl = isPrUrl(record.prUrl) ? record.prUrl : null;
  const notice = typeof record.notice === "string" && record.notice.trim() ? record.notice.trim() : null;
  return status || prUrl || notice ? { status, prUrl, notice } : null;
}

// Classifies one attempt of a job from what the pipeline recorded, its stream and how the process ended.
export function classifyJobResult({ log, exitCode, timedOut = false, idleTimedOut = false, stopped = false, state = null } = {}) {
  const resultText = extractResultText(log) ?? "";
  const record = pipelineOutcome(state);
  const reported = record?.prUrl ?? extractPrUrlFromStream(log);
  const prUrl = extractPublishedPrUrl(log, { repo: prUrlRepo(reported) }) ?? reported;
  const kill = runtimeKillFromStream(log);
  if (kill) {
    return {
      status: "failed",
      prUrl,
      noticeMd: `runtime: the CLI killed the background task "${kill.description}" after its wait ceiling; the run did not finish`,
      resultText,
    };
  }
  const gate = record?.status ? record.status === "gate" : hasGateMarker(resultText) || hasGateMarkerInStream(log);
  const reason = gateReason(log, resultText, record?.notice ?? null);
  const ending = { exitCode, timedOut, idleTimedOut, stopped };
  const status = decideStatus({ ...ending, prUrl, gate, reason });
  const silentStop = status === "failed" && !reason && endedCleanly(ending);
  return { status, prUrl, noticeMd: silentStop ? SILENT_STOP_NOTICE : reason, resultText };
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
