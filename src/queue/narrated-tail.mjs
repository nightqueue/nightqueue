import { closeSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { open } from "node:fs/promises";
import { UserError } from "../config/errors.mjs";
import { jobLogPath } from "../config/paths.mjs";
import { jobView } from "../memory/jobs.mjs";
import { jobRef } from "../memory/refs.mjs";
import { openStore, withReadOnlyStore } from "../store/open.mjs";
import { FOLLOW_QUIET_MS, followLog } from "./follow.mjs";
import { createNarrator, noticeNarration } from "./narrate.mjs";
import { eachLineYielding } from "./yielding-lines.mjs";

// Runs a read of the log file, turning an I/O failure into a message for the operator instead of a stack.
export function readingLog(path, read) {
  try {
    return read();
  } catch (err) {
    throw new UserError(`could not read the log at ${path}: ${err?.message ?? String(err)}`);
  }
}

// Reads the status of a job for the follow loop, on a connection opened for that poll alone; a job whose row is gone has no status at all.
export function jobStatusReader(id, env) {
  return async () => await withReadOnlyStore(env, (store) => store.jobs.status(id));
}

// The row of a job as the CLI has always read it, on the writable store of the process.
function storeJobReader(env) {
  return async (id) => await openStore(env).jobs.getJob(id);
}

// The whole log from a byte offset on, decoded as text; offset 0 reads the file exactly as `queue log` always did.
function readLogFrom(path, offset) {
  if (!(offset > 0)) return readFileSync(path, "utf8");
  const size = statSync(path).size;
  if (size <= offset) return "";
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(size - offset);
    const read = readSync(fd, buffer, 0, buffer.length, offset);
    return buffer.subarray(0, read).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

// The bytes of the log between two offsets, decoded as text and read without blocking; an empty range reads nothing.
async function readLogRange(path, from, to) {
  try {
    const file = await open(path, "r");
    try {
      const length = Math.min(to, (await file.stat()).size) - from;
      if (!(length > 0)) return "";
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await file.read(buffer, 0, length, from);
      return buffer.subarray(0, bytesRead).toString("utf8");
    } finally {
      await file.close();
    }
  } catch (err) {
    throw new UserError(`could not read the log at ${path}: ${err?.message ?? String(err)}`);
  }
}

// Pushes the earlier attempts of the log through the same narrator, so the lanes it opened stay known, and hands every event to `onHistory` alone.
async function replayHistory({ path, from, to, narrator, onHistory }) {
  const text = await readLogRange(path, from, to);
  await eachLineYielding(text, (line) => {
    for (const event of narrator.push(line)) onHistory?.(event);
  });
}

// Turns a notice of the follow loop into a narration line, a warning, or the debug trace of one poll.
function narrateNotice(notice, { narrator, emit, trace, warn }) {
  if (notice.kind === "poll") trace?.(notice);
  if (notice.kind === "error") warn(notice.message);
  if (notice.kind === "truncated") emit(narrator.note("truncated", "log truncated; narration restarted"));
  if (notice.kind === "quiet") emit(narrator.note("quiet", `still running (${Math.round(notice.silentMs / 1000)}s quiet)`));
}

// Emits the reason the job is stopped when the stream itself never carried one, so a gate is never narrated in silence.
async function emitJobNotice(id, { narrator, emit, sawNotice, readJob }) {
  if (sawNotice()) return;
  const notice = jobView(await readJob(id), { full: true })?.notice_md;
  if (!notice) return;
  emit(narrator.note("notice", noticeNarration(notice, { jobId: id })));
}

// Narrates the log of a job once, from a byte offset: every event already written, then the notice of the row when the stream had none.
async function narrateOnce({ id, path, fromOffset, tail }) {
  const text = readingLog(path, () => readLogFrom(path, fromOffset));
  const running = (await tail.readJob(id))?.status === "running";
  await eachLineYielding(text, (line) => {
    for (const event of tail.narrator.push(line)) tail.emit(event);
  });
  for (const event of tail.narrator.finish({ running })) tail.emit(event);
  await emitJobNotice(id, tail);
  return null;
}

// Narrates the log of a job while following it until the job leaves `running`, and answers the result of the follow.
async function narrateFollowing({ id, env, path, fromOffset, stopReason, quietMs, trace, warn, tail }) {
  const { narrator, emit } = tail;
  const result = await followLog(
    {
      path,
      offset: fromOffset,
      readStatus: jobStatusReader(id, env),
      stopReason,
      onLine: (line) => {
        for (const event of narrator.push(line)) emit(event);
      },
      onNotice: (notice) => narrateNotice(notice, { narrator, emit, trace, warn }),
    },
    { quietMs },
  );
  for (const event of narrator.finish()) emit(event);
  if (result.logError) emit(narrator.note("toolError", `${result.logError}; this narration is missing the tail of the log`));
  await emitJobNotice(id, tail);
  if (result.status) emit(narrator.note("resultEnd", `${jobRef(id)} ${result.status}`));
  return result;
}

// Narrates the log of one job to `onEvent`, the one narrated tail `queue log` prints and the studio streams; answers the follow result, or null without follow.
// With `historyFrom` below `fromOffset`, the earlier bytes are replayed first to `onHistory` only; usage events go to `onUsage`, never to `onEvent`.
export async function narrateJob({ id, env = process.env, follow = false, all = false, fromOffset = 0, historyFrom = null, onHistory = null, onUsage = null, onEvent, stopReason, quietMs = FOLLOW_QUIET_MS, trace = null, warn = () => {}, readJob = storeJobReader(env) }) {
  const path = jobLogPath(id, env);
  let seen = false;
  const emit = (event) => {
    if (event.kind === "usage") return onUsage?.(event);
    if (event.kind === "notice") seen = true;
    onEvent(event);
  };
  const narrator = createNarrator({ all, jobId: id, usage: Boolean(onUsage || onHistory) });
  if (Number.isFinite(historyFrom) && historyFrom < fromOffset) await replayHistory({ path, from: historyFrom, to: fromOffset, narrator, onHistory });
  const tail = { narrator, emit, sawNotice: () => seen, readJob };
  if (!follow) return await narrateOnce({ id, path, fromOffset, tail });
  return await narrateFollowing({ id, env, path, fromOffset, stopReason, quietMs, trace, warn, tail });
}
