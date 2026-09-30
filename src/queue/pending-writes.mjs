import { closeSync, existsSync, fsyncSync, openSync, readdirSync, readFileSync, renameSync, writeSync } from "node:fs";
import { join } from "node:path";
import { StoreUnavailableError } from "../config/errors.mjs";
import { withLockSync } from "../config/lock.mjs";
import { pendingWritesPath, runDir, runsDir } from "../config/paths.mjs";
import { isRunPath } from "./resume.mjs";

export const PENDING_WRITES_FILE = "pending-writes.jsonl";

// The key of every kind of record a run may queue: the identity a replay marks once it is applied.
export const PENDING_KEYS = Object.freeze({
  finish: (jobId, worker) => `finish:${jobId}:${worker}`,
  park: (jobId, worker) => `park:${jobId}:${worker}`,
  telemetry: (jobId, worker) => `telemetry:${jobId}:${worker}`,
  runFacts: (jobId) => `run_facts:${jobId}:branch`,
  session: (jobId, attempts) => `session:${jobId}:${attempts}`,
  pipelineLog: (projectId, slug, at) => `pipeline_log:${projectId}/${slug}:${at}`,
  indexSave: (projectId, at) => `index_save:${projectId}:${at}`,
});

// Replays a queued finish: the guarded finish first, then only the notice and pull request the row still lacks; a row further along is never demoted.
async function applyFinish(entry, store) {
  const payload = entry.payload;
  if (await store.jobs.finishJob(entry.jobId, payload)) return "applied";
  if (await store.jobs.fillFinishGaps(entry.jobId, { status: payload.status, noticeMd: payload.noticeMd, prUrl: payload.prUrl })) return "filled";
  return (await store.jobs.status(entry.jobId)) === null ? "refused: no row" : "superseded";
}

// Replays a queued park, which only moves a row the same worker still runs.
async function applyPark(entry, store) {
  return (await store.jobs.parkJob(entry.jobId, entry.payload)) ? "applied" : "superseded";
}

// Replays the measured telemetry, which only fills a run the agent recorded.
async function applyTelemetry(entry, store) {
  const written = await store.runs.updateRunTelemetry(entry.payload);
  return written?.runId === null ? "superseded" : "applied";
}

// Replays the branch of the run, which only lands while the same worker still holds the row.
async function applyRunFacts(entry, store) {
  return (await store.jobs.persistRunFacts(entry.jobId, entry.payload)) ? "applied" : "superseded";
}

// Replays the session facts of one attempt, which only land on the same claim and never rewind a later attempt's session.
async function applySession(entry, store) {
  return (await store.jobs.fillSessionFacts(entry.jobId, entry.payload)) ? "applied" : "superseded";
}

// Replays a pipeline run, skipped when a run of the same slug was recorded since it was queued.
async function applyPipelineLog(entry, store) {
  const logged = await store.runs.logPipelineRunOnce(entry.payload, { since: entry.at });
  return logged?.skipped ? "superseded" : "applied";
}

// Replays an index save onto the rows no save touched since it was queued, with the modification times measured then; a later save always wins.
async function applyIndexSave(entry, store) {
  const filled = await store.index.fillProjectIndex({ ...entry.payload, since: entry.at });
  return filled.files + filled.libs > 0 ? "applied" : "superseded";
}

const APPLIERS = Object.freeze({
  finish: applyFinish,
  park: applyPark,
  telemetry: applyTelemetry,
  run_facts: applyRunFacts,
  session: applySession,
  pipeline_log: applyPipelineLog,
  index_save: applyIndexSave,
});

// The lock that serializes every append, marker and rename of one run's pending-writes file.
function lockOf(path) {
  return `${path}.lock`;
}

// Appends lines to the file and flushes them to disk before answering; a run directory that is gone is an error, never recreated.
function appendDurably(path, lines) {
  const fd = openSync(path, "a");
  try {
    writeSync(fd, lines.map((line) => `${JSON.stringify(line)}\n`).join(""));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

// Parses one line of the file into an entry, a marker, or null when it is neither.
function parseLine(text) {
  try {
    const line = JSON.parse(text);
    if (line && typeof line.applied === "string") return { marker: line };
    if (line && typeof line.key === "string" && typeof line.kind === "string") return { entry: line };
    return null;
  } catch {
    return null;
  }
}

// Reads the entries, in file order, the applied keys and the count of malformed lines; a missing file has none.
function readPending(path) {
  const text = existsSync(path) ? readFileSync(path, "utf8") : "";
  const read = { entries: [], applied: new Set(), malformed: 0 };
  for (const raw of text.split("\n")) {
    if (raw.trim() === "") continue;
    const parsed = parseLine(raw);
    if (parsed?.entry) read.entries.push(parsed.entry);
    else if (parsed?.marker) read.applied.add(parsed.marker.applied);
    else read.malformed += 1;
  }
  return read;
}

// The entries still waiting, one per key, in file order.
function unappliedEntries(read) {
  const seen = new Set(read.applied);
  return read.entries.filter((entry) => {
    if (seen.has(entry.key)) return false;
    seen.add(entry.key);
    return true;
  });
}

// A millisecond stamp for the name of a finished file, one path segment.
function doneStamp() {
  return new Date().toISOString().replace(/[-:.]/g, "");
}

// Moves a file whose every entry is marked aside, so the next append starts a live file of its own.
function retireDoneFile(path) {
  const base = path.replace(/\.jsonl$/, "");
  let target = `${base}.${doneStamp()}.done.jsonl`;
  for (let n = 1; existsSync(target); n += 1) target = `${base}.${doneStamp()}-${n}.done.jsonl`;
  renameSync(path, target);
  return target;
}

// Validates what a caller asks to queue, answering the reason it cannot be, or null.
function entryProblem(projectId, slug, entry) {
  if (!isRunPath(projectId, slug)) return `\`${projectId}/${slug}\` is not a run directory`;
  if (typeof entry?.key !== "string" || entry.key === "") return "the entry has no key";
  if (!Object.hasOwn(APPLIERS, entry.kind)) return `unknown kind \`${String(entry.kind)}\``;
  return null;
}

// Queues one record the database refused into the run's pending-writes file, once per key; it never throws and answers `kept` with the reason when nothing was queued.
export function appendPendingWrite({ projectId, slug, entry, env = process.env } = {}) {
  const problem = entryProblem(projectId, slug, entry);
  if (problem) return { status: "kept", reason: problem };
  const path = pendingWritesPath(projectId, slug, env);
  const line = { v: 1, key: entry.key, kind: entry.kind, at: entry.at ?? new Date().toISOString(), jobId: entry.jobId ?? null, projectId, slug, payload: entry.payload ?? {} };
  try {
    withLockSync(lockOf(path), () => {
      if (readPending(path).entries.some((queued) => queued.key === entry.key)) return;
      appendDurably(path, [line]);
    });
    return { status: "queued", path };
  } catch (err) {
    return { status: "kept", reason: `${path}: ${err?.message ?? String(err)}` };
  }
}

// Applies one entry, turning an unknown kind or a failure of its own into a refusal; an unavailable store stops the replay.
async function applyEntry(entry, store) {
  const apply = APPLIERS[entry.kind];
  if (!apply) return "refused: unknown kind";
  try {
    return await apply(entry, store);
  } catch (err) {
    if (err instanceof StoreUnavailableError) throw err;
    return `refused: ${String(err?.message ?? err).split("\n")[0]}`;
  }
}

// Appends the markers of the keys still in the file and retires the file once every key carries one, all under the lock.
function writeMarkers(path, markers) {
  return withLockSync(lockOf(path), () => {
    if (!existsSync(path)) return null;
    const read = readPending(path);
    const present = new Set(read.entries.map((entry) => entry.key));
    const fresh = markers.filter((marker) => present.has(marker.applied) && !read.applied.has(marker.applied));
    if (fresh.length > 0) appendDurably(path, fresh);
    const marked = new Set([...read.applied, ...fresh.map((marker) => marker.applied)]);
    return read.entries.every((entry) => marked.has(entry.key)) ? retireDoneFile(path) : null;
  });
}

// Counts the results of one replay by their outcome.
function tally(markers, malformed) {
  const counts = { applied: 0, filled: 0, superseded: 0, refused: 0, malformed };
  for (const marker of markers) {
    const outcome = marker.result.startsWith("refused") ? "refused" : marker.result;
    counts[outcome] += 1;
  }
  return counts;
}

// Replays one run's pending writes in file order through the store, marking each applied key; an unavailable store is rethrown and leaves every unapplied line in place.
export async function replayPendingWrites({ projectId, slug, env = process.env, store } = {}) {
  const path = pendingWritesPath(projectId, slug, env);
  const read = withLockSync(lockOf(path), () => readPending(path));
  const markers = [];
  let done = null;
  try {
    for (const entry of unappliedEntries(read)) {
      markers.push({ v: 1, applied: entry.key, at: new Date().toISOString(), result: await applyEntry(entry, store) });
    }
  } finally {
    if (read.entries.length > 0) done = writeMarkers(path, markers);
  }
  return { projectId, slug, path, done, ...tally(markers, read.malformed) };
}

// The run directories that hold a live pending-writes file, read from disk; an unreadable directory holds none.
function pendingRuns(env) {
  const runs = [];
  for (const projectId of listDir(runsDir(env))) {
    for (const slug of listDir(join(runsDir(env), projectId))) {
      if (isRunPath(projectId, slug) && existsSync(join(runDir(projectId, slug, env), PENDING_WRITES_FILE))) runs.push({ projectId, slug });
    }
  }
  return runs;
}

// The sub-directory names of a directory, or none when it cannot be read.
function listDir(path) {
  try {
    return readdirSync(path, { withFileTypes: true }).filter((dirent) => dirent.isDirectory()).map((dirent) => dirent.name);
  } catch {
    return [];
  }
}

// Replays every run's pending writes; it never throws, stops at the first unavailable store and answers it as `error`, and reports any other failure per run.
export async function replayAllPendingWrites({ env = process.env, store } = {}) {
  const results = [];
  for (const run of pendingRuns(env)) {
    try {
      results.push(await replayPendingWrites({ ...run, env, store }));
    } catch (err) {
      if (err instanceof StoreUnavailableError) return { runs: results, error: err };
      results.push({ ...run, failed: String(err?.message ?? err).split("\n")[0] });
    }
  }
  return { runs: results, error: null };
}
