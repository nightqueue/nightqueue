import { existsSync } from "node:fs";
import { UserError } from "../config/errors.mjs";
import { jobLogPath } from "../config/paths.mjs";
import { jobView } from "../memory/jobs.mjs";
import { parseJobRef } from "../memory/refs.mjs";
import { respond } from "../mcp/transports/http-gate.mjs";
import { readQueueStatus, refreshAnsweredPrStates } from "../mcp/tools.mjs";
import { readAttemptTail } from "../queue/follow.mjs";
import { formatElapsed, GLYPHS } from "../queue/narrate.mjs";
import { narrateJob } from "../queue/narrated-tail.mjs";
import { createTimeline } from "../queue/timeline.mjs";
import { withReadOnlyStore } from "../store/open.mjs";
import { artifactSummary } from "./artifacts.mjs";
import { jobExtras, runDirOf, runTierOf } from "./job-extras.mjs";
import { decorateSnapshot } from "./rows.mjs";

export const QUEUE_POLL_MS = 1000;
const KEEPALIVE_MS = 15000;
const NARRATION_FLUSH_MS = 100;
const QUEUE_LIMIT = 50;

// Opens a server-sent events response, with the headers that keep every proxy from buffering it.
function openStream(res) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", "x-accel-buffering": "no" });
  res.flushHeaders?.();
}

// Writes one named event; a closed response swallows it instead of throwing at the poller.
function sendEvent(res, name, data) {
  if (res.writableEnded || res.destroyed) return;
  res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
}

// Keeps a stream alive through idle proxies with a comment line every 15 seconds; answers the function that stops it.
function keepAlive(res) {
  const timer = setInterval(() => {
    if (!res.writableEnded && !res.destroyed) res.write(": keepalive\n\n");
  }, KEEPALIVE_MS);
  timer.unref();
  return () => clearInterval(timer);
}

// The sections of an answer without their timings, the only part of them that changes on every read.
function withoutTimings(key, value) {
  return key === "sections" && Array.isArray(value) ? value.map(({ ms, ...rest }) => rest) : value;
}

// The top-level keys of the snapshot whose value changed since the previous one, `jobs` aside.
function changedKeys(previous, next) {
  const set = {};
  const keys = new Set([...Object.keys(previous), ...Object.keys(next)]);
  keys.delete("jobs");
  for (const key of keys) {
    if (JSON.stringify(withoutTimings(key, previous[key])) !== JSON.stringify(withoutTimings(key, next[key]))) set[key] = next[key] ?? null;
  }
  return set;
}

// The signature a row is compared by, without the durations a read derives from its own clock: the client ticks those itself.
function jobSignature(job) {
  return JSON.stringify({ ...job, active_s: undefined, wall_s: undefined });
}

// The rows that changed, appeared or left since the previous snapshot, plus the new order; null when nothing moved.
function changedJobs(previous, next) {
  const before = new Map((previous.jobs ?? []).map((job) => [job.id, jobSignature(job)]));
  const after = next.jobs ?? [];
  const upsert = after.filter((job) => before.get(job.id) !== jobSignature(job));
  const ids = new Set(after.map((job) => job.id));
  const remove = [...before.keys()].filter((id) => !ids.has(id));
  const order = after.map((job) => job.id);
  const sameOrder = JSON.stringify(order) === JSON.stringify([...before.keys()]);
  if (!upsert.length && !remove.length && sameOrder) return null;
  return { upsert, remove, order };
}

// The patch that turns one snapshot into the next, or null when nothing changed.
export function snapshotPatch(previous, next) {
  const set = changedKeys(previous, next);
  const jobs = changedJobs(previous, next);
  if (!Object.keys(set).length && !jobs) return null;
  return { set, ...(jobs ? { jobs } : {}) };
}

// One read of the queue: the `queue_status` answer decorated with the studio cells; the pull request cache is refreshed outside of it.
async function readSnapshot(env, itemRefs) {
  const snapshot = await readQueueStatus(env, { limit: QUEUE_LIMIT, decorate: (answer, store) => decorateSnapshot(answer, { env, store, itemRefs }) });
  Promise.resolve(refreshAnsweredPrStates(snapshot, env)).catch(() => {});
  return snapshot;
}

// One shared poller of the queue for every `/events` subscriber of a server: started with the first, stopped with the last.
export function createQueueStream({ env, pollMs = QUEUE_POLL_MS }) {
  const clients = new Set();
  const itemRefs = new Map();
  let last = null;
  let timer = null;
  let polling = false;

  const deliver = (snapshot) => {
    const patch = last ? snapshotPatch(last, snapshot) : null;
    for (const client of clients) {
      if (!client.ready) sendEvent(client.res, "snapshot", snapshot);
      else if (patch) sendEvent(client.res, "patch", patch);
      client.ready = true;
    }
    last = snapshot;
  };

  const tick = async () => {
    try {
      deliver(await readSnapshot(env, itemRefs));
    } catch (err) {
      for (const client of clients) sendEvent(client.res, "error", { message: err?.message ?? String(err) });
    }
  };

  const loop = async () => {
    timer = null;
    polling = true;
    await tick();
    polling = false;
    if (clients.size) timer = setTimeout(loop, pollMs);
  };

  const stop = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    last = null;
  };

  const subscribe = (req, res) => {
    openStream(res);
    const client = { res, ready: false };
    clients.add(client);
    if (last) {
      sendEvent(res, "snapshot", last);
      client.ready = true;
    }
    const stopKeepAlive = keepAlive(res);
    req.on("close", () => {
      stopKeepAlive();
      clients.delete(client);
      if (!clients.size) stop();
    });
    if (!timer && !polling) void loop();
  };

  const close = () => {
    stop();
    for (const client of clients) client.res.end();
    clients.clear();
  };

  return { subscribe, close, subscriberCount: () => clients.size };
}

// The wire shape of one narration event: what it says plus every structured field a renderer needs, never a line to parse.
function narrationWire(event) {
  return {
    kind: event.kind,
    glyph: GLYPHS[event.kind] ?? GLYPHS.tool,
    clock: formatElapsed(event.elapsedMs),
    text: event.text ?? "",
    dim: event.dim ?? "",
    indent: event.indent === true,
    lane: event.lane ?? null,
    tool: event.tool ?? null,
    agent: event.agent ?? null,
    phase: Number.isInteger(event.phase) ? event.phase : null,
    model: event.model ?? null,
    durationMs: Number.isFinite(event.durationMs) ? event.durationMs : null,
    elapsedMs: Number.isFinite(event.elapsedMs) ? event.elapsedMs : null,
    file: event.file ?? null,
    laneId: event.laneId ?? null,
    body: typeof event.body === "string" ? event.body : null,
    body_truncated: event.body_truncated === true,
    body_offset: Number.isInteger(event.body_offset) ? event.body_offset : null,
    at: event.at ?? null,
    artifact: event.artifact ?? null,
    title: event.title ?? null,
    bytes: Number.isFinite(event.bytes) ? event.bytes : null,
  };
}

// The answer of the report reader while the run directory is unknown: a report whose `bytes` is not a finite number is a deferred one, resolved at flush.
const PENDING_REPORT = Object.freeze({ title: null, bytes: null });

// The title and size of one artifact of the job's run directory as the stream knows it now, a pending answer while it knows none.
function readStreamArtifact(state, name) {
  return state.runDir ? artifactSummary(state.runDir, name) : PENDING_REPORT;
}

// Whether a narration event is a report whose artifact was not read yet.
function isPendingReport(event) {
  return event.kind === "report" && !Number.isFinite(event.bytes);
}

// Re-reads the job's row once for its run directory, kept on the state when found; null when the row is gone, has no slug or the read fails.
async function resolveRunDir(state) {
  try {
    const row = await withReadOnlyStore(state.env, (store) => store.jobs.getJob(state.job.id));
    const dir = row ? runDirOf(jobView(row, { full: true }), state.env) : null;
    if (dir) state.runDir = dir;
    return dir;
  } catch {
    return null;
  }
}

// A pending report completed with its artifact's title and size, null while the directory or the file is missing.
function completedReport(state, event) {
  const summary = state.runDir ? artifactSummary(state.runDir, event.artifact) : null;
  return summary ? { ...event, title: summary.title ?? null, bytes: summary.bytes } : null;
}

// One event of a batch through the stream's report pass: a phase resets the reported artifacts, a report shows once per artifact per phase.
function completedEvent(state, event) {
  if (event.kind === "phase") state.reported.clear();
  if (event.kind !== "report") return event;
  if (state.reported.has(event.artifact)) return null;
  const report = isPendingReport(event) ? completedReport(state, event) : event;
  if (report) state.reported.add(event.artifact);
  return report;
}

// The batch with its pending reports resolved in place and its unresolvable or repeated ones dropped; the row is re-read at most once per batch.
async function completeReports(state, batch) {
  if (!state.runDir && batch.some(isPendingReport)) await resolveRunDir(state);
  const out = [];
  for (const event of batch) {
    const placed = completedEvent(state, event);
    if (placed) out.push(placed);
  }
  return out;
}

// Reads the job a stream is about with its studio extras, on a store opened read-only for that read alone; null when the row is gone.
async function readJobWithExtras(id, env) {
  return await withReadOnlyStore(env, async (store) => {
    const row = await store.jobs.getJob(id);
    if (!row) return null;
    const job = jobView(row, { full: true });
    return { job, extras: await jobExtras(job, { env, store }) };
  });
}

// The byte offset where the current attempt of a job's log starts, so the stream narrates that attempt alone.
function attemptOffset(id, env) {
  return readAttemptTail(jobLogPath(id, env))?.offset ?? 0;
}

// The state of one job stream: the timeline of every attempt, the touched files and the batch waiting to be flushed.
function createJobState({ res, env, job, extras }) {
  return { res, env, job, tier: extras.tier ?? job.tier ?? null, runDir: extras.run_dir ?? null, reported: new Set(), timeline: createTimeline(), timelineDirty: false, recordedFiles: extras.files, files: new Set(), pending: [], timer: null, flushChain: Promise.resolve(), status: job.status };
}

// Sends the timeline as it stands, re-reading the run tier while it is still unknown.
function sendTimeline(state) {
  if (!state.tier) state.tier = runTierOf(state.job, state.env);
  sendEvent(state.res, "timeline", state.timeline.snapshot({ tier: state.tier, status: state.status }));
}

// Sends one narration batch, then the files it touched when the run recorded none.
function sendNarration(state, batch) {
  if (batch.length) sendEvent(state.res, "narration", batch.map(narrationWire));
  const before = state.files.size;
  for (const event of batch) if (event.file) state.files.add(event.file);
  if (state.recordedFiles === null && state.files.size !== before) sendEvent(state.res, "files", [...state.files].sort());
}

// Sends the waiting narration batch with its reports resolved and the files it touched, then the timeline when anything moved it.
async function flushJobState(state) {
  const batch = state.pending;
  state.pending = [];
  if (batch.length) sendNarration(state, await completeReports(state, batch));
  if (!state.timelineDirty) return;
  state.timelineDirty = false;
  sendTimeline(state);
}

// Queues one flush after the ones already running, so batches leave in order; a failed flush is reported on the stream and never stops the next.
function chainFlush(state) {
  state.flushChain = state.flushChain
    .then(() => flushJobState(state))
    .catch((err) => sendEvent(state.res, "error", { message: `narration flush failed: ${err?.message ?? String(err)}` }));
  return state.flushChain;
}

// Arms the next flush unless one is already waiting.
function scheduleFlush(state) {
  if (state.timer) return;
  state.timer = setTimeout(() => {
    state.timer = null;
    chainFlush(state);
  }, NARRATION_FLUSH_MS);
}

// Folds one event into the timeline alone: an earlier attempt's event or a usage report, never a narration line.
function pushTimelineEvent(state, event) {
  state.timeline.push(event);
  state.timelineDirty = true;
  scheduleFlush(state);
}

// Queues one narration event of the current attempt for the next flush, and folds it into the timeline.
function pushJobEvent(state, event) {
  state.pending.push(event);
  pushTimelineEvent(state, event);
}

// Ends a job stream once the follow ended: the last batch, the final timeline and the status it ended on; the response stays open for the client.
async function endJobState(state, result) {
  if (state.timer) clearTimeout(state.timer);
  state.timer = null;
  await state.flushChain;
  state.status = result?.status ?? state.status;
  state.timelineDirty = false;
  await chainFlush(state);
  sendTimeline(state);
  sendEvent(state.res, "end", { status: state.status, reason: result?.reason ?? null });
}

// Streams the narrated current attempt of one job, following it while it runs; the client closing the stream ends the follow.
export async function streamJob(req, res, { env, ref }) {
  let id = null;
  try {
    id = parseJobRef(ref);
  } catch (err) {
    return respond(res, 400, err instanceof UserError ? err.message : "invalid job ref");
  }
  let closed = false;
  let stopKeepAlive = () => {};
  req.on("close", () => {
    closed = true;
    stopKeepAlive();
  });
  const found = await readJobWithExtras(id, env);
  if (!found) return respond(res, 404, `unknown job \`${ref}\``);
  if (closed) return;
  openStream(res);
  stopKeepAlive = keepAlive(res);
  const state = createJobState({ res, env, ...found });
  sendEvent(res, "meta", found.extras);
  sendTimeline(state);
  if (found.extras.files !== null) sendEvent(res, "files", found.extras.files);
  if (!existsSync(jobLogPath(id, env))) return await endJobState(state, { status: found.job.status, reason: "the job has no log yet" });
  const result = await narrateJob({
    id,
    env,
    follow: true,
    rich: true,
    readArtifact: (name) => readStreamArtifact(state, name),
    fromOffset: attemptOffset(id, env),
    historyFrom: 0,
    onHistory: (event) => pushTimelineEvent(state, event),
    onUsage: (event) => pushTimelineEvent(state, event),
    onEvent: (event) => pushJobEvent(state, event),
    stopReason: () => (closed ? "client closed" : null),
    readJob: async (jobId) => await withReadOnlyStore(env, (store) => store.jobs.getJob(jobId)),
  });
  if (!closed) await endJobState(state, result);
  else if (state.timer) clearTimeout(state.timer);
}
