import { NO_CHANGE_RESOLUTION, truncateByCodePoint } from "../memory/jobs.mjs";
import { isStateObject } from "./resume.mjs";
import { NO_CHANGE_OUTCOME, RUN_OUTCOME_STATUSES } from "./run-state.mjs";
import {
  extractResultText,
  isPrUrl,
  lastAttemptStream,
  lastProviderEvents,
  parseEventLine,
  publishedDelivery,
  runtimeKillFromStream,
} from "./stream.mjs";

const BACKOFF_BASE_MS = 5000;
const BACKOFF_FACTOR = 3;
const BACKOFF_CAP_MS = 60000;
const TRANSIENT_STATUS_CODES = new Set([429, 500, 502, 503, 529]);
const TRANSIENT_ERROR_RE = /^API Error: (429|500|502|503|529)\b/;
const KILLED_BASH_COMMAND_LIMIT = 120;
const ABANDONED_COMMAND_LIMIT = 120;
const RUN_IN_BACKGROUND_HINT =
  "background Bash is kept in the foreground from this version; if you see this, the hook did not run";
const AUTO_BACKGROUNDED_HINT = "the Bash tool had moved this foreground command to the background after its own timeout";

export const TRANSIENT_RESPAWNS = 2;
export const SILENT_STOP_NOTICE ="no outcome recorded: the session ended (exit 0) without recording an outcome. See the log.";
export const GATE_WITHOUT_NOTICE = "the run stopped at a gate but recorded no notice carrying the question. See the log.";
export const NOTHING_TO_CLOSE_LINE = "nothing to close: the run produced no pull request";
export const NO_CHANGE_NEXT_STEP_LINE = "Next step: close the job so where it came from is told it was resolved without a code change.";
export const IGNORED_RECORD_PREFIX = "ignored a record of attempt ";
export const IGNORED_RECORD_LINE = /^ignored a record of attempt \d+$/;

// The ending the process facts alone decide, whatever the run recorded, or null when the process ended cleanly.
function processEnding({ exitCode, timedOut, idleTimedOut, stopped }) {
  if (stopped) return { status: "cancelled", noticeMd: "stopped by the operator" };
  if (timedOut) return { status: "failed", noticeMd: "the run hit its time limit" };
  if (idleTimedOut) return { status: "failed", noticeMd: "the run went idle past its limit" };
  if (exitCode === 0) return null;
  return { status: "failed", noticeMd: Number.isInteger(exitCode) ? `the session exited with code ${exitCode}` : "the session ended with no exit code" };
}

// The ending of a clean exit, read only from what the run recorded: its outcome, then its termination, else a failure that says nothing was recorded.
function recordedEnding(record, state, prUrl) {
  if (record?.status === "done" && prUrl) return { status: "done", noticeMd: record.notice };
  if (record?.status === "gate" && record.notice) return { status: "gate", noticeMd: record.notice };
  if (record?.status === NO_CHANGE_OUTCOME && record.notice) {
    return { status: "done", prUrl: null, noticeMd: noChangeNotice(record.notice), resolution: NO_CHANGE_RESOLUTION };
  }
  const reason = terminationReason(state);
  if (reason) return { status: "cancelled", noticeMd: prUrl ? reason : `${reason}\n\n${NOTHING_TO_CLOSE_LINE}` };
  return { status: "failed", noticeMd: record?.status === "gate" ? GATE_WITHOUT_NOTICE : SILENT_STOP_NOTICE };
}

// Tells whether the run's own records already settled how it ended, by the same rows that decide a clean exit: a settled run never starts another session.
export function isRecordSettled(state, prUrl) {
  return recordedEnding(pipelineOutcome(state), state, prUrl).status !== "failed";
}

// The reason of the termination the run recorded, or null when it recorded none that says why.
function terminationReason(state) {
  const termination = isStateObject(state?.termination) ? state.termination : null;
  return typeof termination?.reason === "string" && termination.reason.trim() ? termination.reason.trim() : null;
}

// What the run recorded before it failed, in words a notice can carry, or null.
export function recordedConclusion(state) {
  const record = pipelineOutcome(state);
  if (record?.status === "gate" && record.notice) return `a gate: ${record.notice}`;
  const reason = terminationReason(state);
  return reason ? `a termination: ${reason}` : null;
}

// The notice of a failed ending, quoting what the same attempt had recorded so the question never stays only in state.json.
function failedNotice(noticeMd, state) {
  const conclusion = recordedConclusion(state);
  return conclusion ? `${noticeMd} after recording ${conclusion}` : noticeMd;
}

// One line per attempt whose record the view ignored, each with its own runtime prefix.
function ignoredRecordLines(state) {
  const attempts = Array.isArray(state?.ignoredAttempts) ? state.ignoredAttempts : [];
  return attempts.map((attempt) => `${IGNORED_RECORD_PREFIX}${attempt}`);
}

// The notice ending on what the claim ignored, so a record of another claim is never silently dropped; an empty notice leaves the lines on their own.
function withIgnoredRecords(noticeMd, state) {
  const lines = ignoredRecordLines(state);
  if (lines.length === 0) return noticeMd;
  return [...(noticeMd ? [noticeMd] : []), ...lines].join("\n\n");
}

// What an orphan's notice ends on, read from the claim the sweep is failing: what it had recorded and what it ignored, or null.
export function orphanNoticeTail(state) {
  const conclusion = recordedConclusion(state);
  const paragraphs = [...(conclusion ? [`it had recorded ${conclusion}`] : []), ...ignoredRecordLines(state)];
  return paragraphs.length > 0 ? paragraphs.join("\n\n") : null;
}

// Tells whether a paragraph is the one a marker names: a text it starts with, or a pattern of its exact shape.
function paragraphMatches(paragraph, marker) {
  return marker instanceof RegExp ? marker.test(paragraph) : paragraph.startsWith(marker);
}

// A notice with every trailing paragraph one of the markers names stripped off, trimmed at its end.
export function trailingStripped(notice, markers) {
  let text = typeof notice === "string" ? notice.trimEnd() : "";
  for (;;) {
    const cut = text.lastIndexOf("\n\n");
    const tail = cut < 0 ? text : text.slice(cut + 2);
    if (!markers.some((marker) => paragraphMatches(tail, marker))) return text;
    text = cut < 0 ? "" : text.slice(0, cut).trimEnd();
  }
}

// The notice of a job resolved without change: the run's conclusion followed by exactly one next-step line the runtime owns.
export function noChangeNotice(reason) {
  const text = trailingStripped(reason, [NO_CHANGE_NEXT_STEP_LINE]);
  return text ? `${text}\n\n${NO_CHANGE_NEXT_STEP_LINE}` : NO_CHANGE_NEXT_STEP_LINE;
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

// Notice of a task the CLI killed AND that ended the run: each clause is said only when the stream itself proves it, never a fixed guess.
function runtimeKillNotice(kill) {
  const isBash = kill.taskType === "local_bash";
  const quoted = isBash ? truncateByCodePoint(kill.description, KILLED_BASH_COMMAND_LIMIT) : kill.description;
  const ceiling = kill.ceilingSeen ? " after its wait ceiling" : "";
  const notFinished = kill.noticeAfterKill ? "" : "; the run did not finish";
  const hint = !isBash ? "" : kill.runInBackground ? `; ${RUN_IN_BACKGROUND_HINT}` : kill.autoBackgrounded ? `; ${AUTO_BACKGROUNDED_HINT}` : "";
  return `runtime: the CLI killed the background task "${quoted}"${ceiling}${notFinished}${hint}`;
}

// A kill only fails the run when it ended it: the CLI's own ceiling line proves that (it literally says "terminating"), or no
// `result` event carrying a `## Notice` ever followed the kill AND state.json recorded no outcome of its own.
function isTerminalKill(kill, record) {
  return kill.ceilingSeen || (!kill.noticeAfterKill && !record?.status);
}

// Tells whether the stream's own kill, if any, ended the run - the only case a retry must never follow.
export function isTerminalRuntimeKill(log, state = null) {
  const kill = runtimeKillFromStream(log);
  return kill !== null && isTerminalKill(kill, pipelineOutcome(state));
}

// The prefix of the line appended to a non-terminal kill's notice, so an abandoned command is never hidden behind a run that otherwise finished.
export const ABANDONED_COMMAND_PREFIX = "⚠️ a command was abandoned mid-run: ";

// The line appended to a non-terminal kill's notice, so an abandoned command is never hidden behind a run that otherwise finished.
function abandonedCommandLine(description) {
  return `${ABANDONED_COMMAND_PREFIX}${truncateByCodePoint(description, ABANDONED_COMMAND_LIMIT)}`;
}

// Appends the abandoned-command line to a notice, never replacing it; an empty notice leaves the line on its own.
function withAbandonedCommand(noticeMd, description) {
  const line = abandonedCommandLine(description);
  return noticeMd ? `${noticeMd}\n\n${line}` : line;
}

// The notice with the abandoned-command line of the log's kill appended, or as it is when the log shows no kill.
export function noticeWithAbandonedCommand(noticeMd, log) {
  const kill = runtimeKillFromStream(log);
  return kill ? withAbandonedCommand(noticeMd, kill.description) : noticeMd;
}

// The prefix of the line that named a pull request not recorded as the run's delivery; it is no longer written, and rows finished before that still carry it.
export const STRAY_PR_PREFIX = "⚠️ another pull request was published during this run and was NOT recorded as its delivery: ";

// The pull request of the run: the runtime's record, then the host's publication on the run's own branch.
function resolvePrUrl(log, { state, record, provenEdits }) {
  if (record?.prUrl) return record.prUrl;
  const hints = { type: state?.type, slug: state?.slug };
  return publishedDelivery(log, { branch: state?.branch ?? null, hints, provenEdits }).url;
}

// Classifies one attempt of a job only from the run's records and how its process ended; the stream speaks only through its structured events.
export function classifyJobResult({ log, exitCode, timedOut = false, idleTimedOut = false, stopped = false, state = null, provenEdits = [] } = {}) {
  const resultText = extractResultText(log) ?? "";
  const record = pipelineOutcome(state);
  const prUrl = resolvePrUrl(log, { state, record, provenEdits });
  const kill = runtimeKillFromStream(log);
  if (kill && isTerminalKill(kill, record)) return { status: "failed", prUrl, noticeMd: withIgnoredRecords(failedNotice(runtimeKillNotice(kill), state), state), resultText };
  const ending = processEnding({ exitCode, timedOut, idleTimedOut, stopped }) ?? recordedEnding(record, state, prUrl);
  const quoted = ending.status === "failed" ? failedNotice(ending.noticeMd, state) : ending.noticeMd;
  const noticeMd = kill ? withAbandonedCommand(quoted, kill.description) : quoted;
  return { prUrl, ...ending, noticeMd: withIgnoredRecords(noticeMd, state), resultText };
}

// The provider failure a `result` event reports in its structured fields, as a short description, or null; its text is never read.
function providerFailureOfResult(result) {
  if (result?.is_error === true && TRANSIENT_STATUS_CODES.has(result.api_error_status)) return `result api_error_status ${result.api_error_status}`;
  if (result?.subtype !== "error_during_execution" || !Array.isArray(result.errors)) return null;
  const match = result.errors.map((error) => (typeof error === "string" ? TRANSIENT_ERROR_RE.exec(error) : null)).find(Boolean);
  return match ? `result error ${match[1]}` : null;
}

// What the structured events of the last spawn say about a transient provider failure, as a short description, or null when they say nothing.
export function transientFailureEvent(log) {
  const { result, rateLimit } = lastProviderEvents(lastAttemptStream(String(log ?? "")));
  const failure = providerFailureOfResult(result);
  if (failure) return failure;
  return rateLimit?.status === "rejected" ? "rate_limit_event rejected" : null;
}

const NIGHTQUEUE_MCP_SERVER = "nightqueue";
const NIGHTQUEUE_TOOL_PREFIX = "mcp__nightqueue__";
const CONNECTION_CLOSED_RESULT = /^(?:Error: )?(?:MCP error -?\d+: )?Connection closed\.?$/;

// Tells whether a `system`/`init` event lists the nightqueue MCP server as failed; a pending one does not count.
function initSaysNightqueueFailed(event) {
  const servers = Array.isArray(event?.mcp_servers) ? event.mcp_servers : [];
  return servers.some((server) => server?.name === NIGHTQUEUE_MCP_SERVER && server?.status === "failed");
}

// The blocks of a message content, whatever shape the event gave it.
function contentBlocks(event) {
  return Array.isArray(event?.message?.content) ? event.message.content : [];
}

// The text of a tool result, whether its content is a string or a list of text blocks.
function toolResultText(block) {
  if (typeof block?.content === "string") return block.content;
  if (!Array.isArray(block?.content)) return "";
  return block.content.map((part) => (typeof part?.text === "string" ? part.text : "")).join("\n");
}

// The first result a nightqueue tool call got in the events, as `{ isError, text }`, or null when no nightqueue call got one.
function firstNightqueueResult(events) {
  const calls = new Set();
  for (const event of events) {
    for (const block of contentBlocks(event)) {
      if (block?.type === "tool_use" && String(block.name ?? "").startsWith(NIGHTQUEUE_TOOL_PREFIX)) calls.add(block.id);
      if (block?.type === "tool_result" && calls.has(block.tool_use_id)) {
        return { isError: block.is_error === true, text: toolResultText(block) };
      }
    }
  }
  return null;
}

// Tells whether a tool result is the client's own "Connection closed" error, as a whole answer, never a text that merely quotes it.
function isConnectionClosedResult(result) {
  return result?.isError === true && CONNECTION_CLOSED_RESULT.test(result.text.trim());
}

// Tells whether the last attempt's session never reached the nightqueue MCP server: its init lists it as failed, or its first nightqueue call failed with exactly "Connection closed"; never throws.
export function nightqueueMcpUnreachable(log) {
  try {
    const events = lastAttemptStream(log).split("\n").map(parseEventLine).filter(Boolean);
    const init = events.find((event) => event.type === "system" && event.subtype === "init");
    if (initSaysNightqueueFailed(init)) return true;
    return isConnectionClosedResult(firstNightqueueResult(events));
  } catch {
    return false;
  }
}

// Exponential backoff of the given re-spawn: 5s, 15s, 45s, capped at 60s.
export function backoffMs(respawn) {
  const spent = Number.isInteger(respawn) && respawn > 0 ? respawn : 1;
  return Math.min(BACKOFF_BASE_MS * BACKOFF_FACTOR ** (spent - 1), BACKOFF_CAP_MS);
}
