import { closeSync, openSync, readSync, statSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";

export const FOLLOW_POLL_MS = 500;
export const FOLLOW_QUIET_MS = 30000;
const MAX_READ_ERRORS = 5;
export const TAIL_LIMIT_BYTES = 64 * 1024;

// Waits the given number of milliseconds.
function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms));
}

// Reads the bytes of a file between two offsets, closing the descriptor whatever happens.
function readChunkSync(path, from, length) {
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(length);
    const read = readSync(fd, buffer, 0, length, from);
    return buffer.subarray(0, read);
  } finally {
    closeSync(fd);
  }
}

// Drops the partial first line of a tail, which starts in the middle of whatever was written there.
function afterFirstLine(text) {
  const cut = text.indexOf("\n");
  return cut === -1 ? "" : text.slice(cut + 1);
}

// Last bytes of a log file, or null when nothing could be read; a reader of a tail never throws at its caller.
export function readLogTail(path, limitBytes = TAIL_LIMIT_BYTES) {
  try {
    const size = statSync(path)?.size;
    if (!Number.isFinite(size) || size <= 0) return "";
    const from = size > limitBytes ? size - limitBytes : 0;
    const text = readChunkSync(path, from, size - from).toString("utf8");
    return from > 0 ? afterFirstLine(text) : text;
  } catch {
    return null;
  }
}

// The poll of a file that could not be read at all: the failing side of the tri-state.
function readFailure(error) {
  return { ok: false, message: error?.message ?? String(error), size: null, lines: [], truncated: false };
}

// Incremental reader of a growing file: it keeps the offset, the partial line and the decoder between polls.
function createReader({ path, offset, statFn, readChunk }) {
  let position = Number.isFinite(offset) && offset > 0 ? offset : 0;
  let pending = "";
  let decoder = new StringDecoder("utf8");
  const restart = () => {
    position = 0;
    pending = "";
    decoder = new StringDecoder("utf8");
  };
  const read = () => {
    let size = null;
    try {
      size = statFn(path)?.size;
    } catch (err) {
      return readFailure(err);
    }
    if (!Number.isFinite(size)) return readFailure(new Error(`stat of ${path} reported no size`));
    const truncated = size < position;
    if (truncated) restart();
    if (size <= position) return { ok: true, message: null, size, lines: [], truncated };
    let chunk = null;
    try {
      chunk = readChunk(path, position, size - position);
    } catch (err) {
      return readFailure(err);
    }
    position += chunk.length;
    const parts = (pending + decoder.write(chunk)).split("\n");
    pending = parts.pop() ?? "";
    return { ok: true, message: null, size, lines: parts, truncated };
  };
  const flush = () => {
    const rest = pending + decoder.end();
    pending = "";
    decoder = new StringDecoder("utf8");
    return rest ? [rest] : [];
  };
  return { read, flush, offsetNow: () => position };
}

// Reads the status of the job as a tri-state: a status, no job at all, or a read that failed.
function readStatusSafely(readStatus) {
  try {
    const status = typeof readStatus === "function" ? readStatus() : null;
    return { ok: true, status: typeof status === "string" && status ? status : null };
  } catch (err) {
    return { ok: false, message: err?.message ?? String(err) };
  }
}

// Counts the consecutive failed reads of the log file and tells the operator about the first one of a streak.
function trackLogRead(batch, state, notify) {
  if (batch.ok) {
    state.logErrors = 0;
    return;
  }
  state.logErrors += 1;
  if (state.logErrors === 1) notify({ kind: "error", message: `log read failed: ${batch.message}` });
}

// Decides whether this poll ends the follow: a job that stopped running, a source nobody can read, a closed output.
function stopOutcome({ snapshot, batch, state }, { maxReadErrors, stopReason }) {
  const stopped = typeof stopReason === "function" ? stopReason() : null;
  if (stopped) return { reason: String(stopped), status: null, logError: null };
  const logError = batch.ok ? null : `log unreadable: ${batch.message}`;
  if (logError && state.logErrors >= maxReadErrors) return { reason: logError, status: null, logError };
  if (!snapshot.ok) {
    state.statusErrors += 1;
    if (state.statusErrors < maxReadErrors) return null;
    return { reason: `status unreadable: ${snapshot.message}`, status: null, logError };
  }
  state.statusErrors = 0;
  if (snapshot.status === null) return { reason: "unknown job", status: null, logError };
  if (snapshot.status === "running") return null;
  if (logError) return { reason: `job ${snapshot.status}, ${logError}`, status: snapshot.status, logError };
  return { reason: `job ${snapshot.status}`, status: snapshot.status, logError: null };
}

// Signals that the job is alive while the stream has nothing to say, so a long silence is never mute.
function tickQuiet(state, { now, quietMs, notify }) {
  if (!Number.isFinite(quietMs) || quietMs <= 0) return;
  const silentMs = now() - state.lastLineAt;
  if (silentMs < quietMs) return;
  state.lastLineAt = now();
  notify({ kind: "quiet", silentMs });
}

// Follows the log of a job until the job leaves `running`, delivering every complete line as it lands.
export async function followLog({ path, offset = 0, readStatus, onLine, onNotice, stopReason }, deps = {}) {
  const {
    pollMs = FOLLOW_POLL_MS,
    quietMs = FOLLOW_QUIET_MS,
    maxReadErrors = MAX_READ_ERRORS,
    sleep: wait = sleep,
    statFn = statSync,
    readChunk = readChunkSync,
    now = Date.now,
  } = deps;
  const reader = createReader({ path, offset, statFn, readChunk });
  const notify = (notice) => {
    if (typeof onNotice === "function") onNotice(notice);
  };
  const state = { lines: 0, polls: 0, statusErrors: 0, logErrors: 0, lastLineAt: now() };
  const deliver = (lines) => {
    for (const line of lines) {
      state.lines += 1;
      if (typeof onLine === "function") onLine(line);
    }
    if (lines.length) state.lastLineAt = now();
  };
  let outcome = null;
  while (!outcome) {
    state.polls += 1;
    const snapshot = readStatusSafely(readStatus);
    const batch = reader.read();
    trackLogRead(batch, state, notify);
    if (batch.truncated) notify({ kind: "truncated" });
    deliver(batch.lines);
    notify({ kind: "poll", at: new Date(now()).toISOString(), size: batch.size, offset: reader.offsetNow(), lines: batch.lines.length, polls: state.polls });
    outcome = stopOutcome({ snapshot, batch, state }, { maxReadErrors, stopReason });
    if (outcome) break;
    tickQuiet(state, { now, quietMs, notify });
    await wait(pollMs);
  }
  deliver(reader.flush());
  return { reason: outcome.reason, status: outcome.status, logError: outcome.logError, lines: state.lines, polls: state.polls, offset: reader.offsetNow() };
}
