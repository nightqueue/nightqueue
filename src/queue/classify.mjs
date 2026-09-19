import { readFileSync } from "node:fs";
import { truncateByCodePoint } from "../memory/jobs.mjs";
import { RUN_OUTCOME_STATUSES } from "./run-state.mjs";
import {
  confirmationSection,
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
const GATE_NOTICE_MARGIN_CP = 200;
const KILLED_BASH_COMMAND_LIMIT = 120;
const KILLED_BASH_HINT =
  "background Bash is kept in the foreground from this version; if you see this, the hook did not run";

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

// The fixed notice of a gate whose own notice does not carry the question it is supposed to ask.
function brokenGateNotice(planPath) {
  return `the run stopped at a gate but its notice does not carry the question - see ${planPath ?? "an unknown plan path"}`;
}

// The plan's own `## Requires user confirmation` section, or null when the plan is missing or unreadable.
function readPlanConfirmation(planPath) {
  if (!planPath) return null;
  try {
    return confirmationSection(readFileSync(planPath, "utf8"));
  } catch {
    return null;
  }
}

// Tells whether a gate's notice fails to carry its question: no confirmation heading, or far shorter than the plan's own section (a margin of reflow, never of dropped points).
function isBrokenGateNotice(reason, planPath) {
  if (!hasGateMarker(String(reason ?? ""))) return true;
  const planSection = readPlanConfirmation(planPath);
  if (!planSection) return false;
  return Array.from(String(reason)).length < Array.from(planSection).length - GATE_NOTICE_MARGIN_CP;
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

// Notice of a task the CLI killed after its wait ceiling: a Bash command is quoted truncated, with a hint the hook should have prevented it.
function runtimeKillNotice(kill) {
  const isBash = kill.taskType === "local_bash";
  const quoted = isBash ? truncateByCodePoint(kill.description, KILLED_BASH_COMMAND_LIMIT) : kill.description;
  const hint = isBash ? `; ${KILLED_BASH_HINT}` : "";
  return `runtime: the CLI killed the background task "${quoted}" after its wait ceiling; the run did not finish${hint}`;
}

// Classifies one attempt of a job from what the pipeline recorded, its stream, how the process ended and the run's plan.
export function classifyJobResult({ log, exitCode, timedOut = false, idleTimedOut = false, stopped = false, state = null, planPath = null } = {}) {
  const resultText = extractResultText(log) ?? "";
  const record = pipelineOutcome(state);
  const reported = record?.prUrl ?? extractPrUrlFromStream(log);
  const prUrl = extractPublishedPrUrl(log, { repo: prUrlRepo(reported) }) ?? reported;
  const kill = runtimeKillFromStream(log);
  if (kill) {
    return { status: "failed", prUrl, noticeMd: runtimeKillNotice(kill), resultText };
  }
  const gate = record?.status ? record.status === "gate" : hasGateMarker(resultText) || hasGateMarkerInStream(log);
  const reason = gateReason(log, resultText, record?.notice ?? null);
  const ending = { exitCode, timedOut, idleTimedOut, stopped };
  const status = decideStatus({ ...ending, prUrl, gate, reason });
  if (status === "gate" && isBrokenGateNotice(reason, planPath)) {
    return { status: "failed", prUrl, noticeMd: brokenGateNotice(planPath), resultText };
  }
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
