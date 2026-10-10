import { existsSync } from "node:fs";
import { open, readFile, stat } from "node:fs/promises";
import { UserError } from "../config/errors.mjs";
import { jobLogPath, queuePausedPath } from "../config/paths.mjs";
import { packageRoot } from "../host/paths.mjs";
import { EMBEDDING_MODEL_ID } from "../memory/embedding.mjs";
import { jobView } from "../memory/jobs.mjs";
import { jobRef, parseJobRef } from "../memory/refs.mjs";
import { RECALL_COS_CUT } from "../memory/search.mjs";
import { respond } from "../mcp/transports/http-gate.mjs";
import { listedProjects } from "../cli/project.mjs";
import { runtimeLabel } from "../cli/runtime-versions.mjs";
import { readVersion } from "../cli/version.mjs";
import { blockerLines } from "../queue/claim.mjs";
import { readLogTail } from "../queue/follow.mjs";
import { jobRecalls } from "../queue/recalls.mjs";
import { refuseHomeWriteInsideJob } from "../queue/home-guard.mjs";
import { pauseQueue, resumeQueue } from "../queue/pause.mjs";
import { WATCH_INTERVAL_DEFAULT_S } from "../queue/runner.mjs";
import { startQueueRunner } from "../queue/start.mjs";
import { parseWallClock } from "../queue/window.mjs";
import { withReadOnlyStore } from "../store/open.mjs";
import { listArtifacts, readArtifactFile } from "./artifacts.mjs";
import { connectLinear } from "./connect.mjs";
import { jobDiffstat } from "./diffstat.mjs";
import { jobFileDiff } from "./file-diff.mjs";
import { ApiRefusal, serveIntegrations } from "./integrations.mjs";
import { runDirOf } from "./job-extras.mjs";
import { appliedRefs, withApplied } from "./recall-applied.mjs";
import { TerminalRefusal } from "./terminal.mjs";

const MAX_BODY_BYTES = 16 * 1024;
const RAW_LOG_BYTES = 1024 * 1024;
const MAX_INTERVAL_S = 86400;
const JOB_LOG_PATH = /^\/api\/jobs\/([^/]+)\/log$/;
const JOB_DIFFSTAT_PATH = /^\/api\/jobs\/([^/]+)\/diffstat$/;
const JOB_DIFF_PATH = /^\/api\/jobs\/([^/]+)\/diff$/;
const JOB_RECALLS_PATH = /^\/api\/jobs\/([^/]+)\/recalls$/;
const JOB_ARTIFACTS_PATH = /^\/api\/jobs\/([^/]+)\/artifacts$/;
const JOB_ARTIFACT_PATH = /^\/api\/jobs\/([^/]+)\/artifacts\/([^/]+)$/;
const LOG_FROM_RE = /^\d+$/;
const TERMINAL_PATH = /^\/api\/terminals\/([0-9a-f]{16})$/;
const RECALLS_CACHE_LIMIT = 16;
const recallsCache = new Map();

// Answers a JSON body with a status code.
function sendJson(res, status, body) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

// Reads the JSON body of a POST, refusing another content type, a body over 16 KiB or a body that is not a JSON object.
async function readJsonBody(req) {
  const type = String(req.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
  if (type !== "application/json") throw new UserError("the body must be `application/json`");
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new UserError(`the body is over ${MAX_BODY_BYTES} bytes`);
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
  let body = null;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    throw new UserError("the body is not valid JSON");
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) throw new UserError("the body must be a JSON object");
  return body;
}

// The facts the page header shows: the version, the runtime it runs from, the MCP endpoint and whether the queue is paused.
function infoAnswer({ env, origin }) {
  return {
    version: readVersion(),
    runtime: runtimeLabel(packageRoot(), env),
    mcp: `${origin}/mcp`,
    queue_paused: existsSync(queuePausedPath(env)),
  };
}

// The watch interval a start asked for, the runtime default when absent; anything but a positive integer is refused.
function intervalOf(body) {
  if (body.interval_s === undefined || body.interval_s === null) return WATCH_INTERVAL_DEFAULT_S;
  if (!Number.isInteger(body.interval_s) || body.interval_s <= 0 || body.interval_s > MAX_INTERVAL_S) {
    throw new UserError(`\`interval_s\` expects a positive integer up to ${MAX_INTERVAL_S}`);
  }
  return body.interval_s;
}

// The optional string field `name` of a body, null when absent; any other type is refused before it is parsed.
function optionalString(body, name) {
  const value = body[name] ?? null;
  if (value !== null && typeof value !== "string") throw new UserError(`\`${name}\` expects a string written HH:MM, got a ${Array.isArray(value) ? "list" : typeof value}`);
  return value;
}

// The `from`/`until` window of a start, checked the way `queue run --watch --from --until` checks them.
function windowOf(body) {
  const from = optionalString(body, "from");
  const until = optionalString(body, "until");
  if (from === null && until === null) return { from: null, until: null };
  if (until === null) throw new UserError("`from` requires `until`");
  if (from !== null && !parseWallClock(from)) throw new UserError(`\`from\` expects a time written HH:MM (00-23:00-59), got \`${from}\``);
  if (!parseWallClock(until)) throw new UserError(`\`until\` expects a time written HH:MM (00-23:00-59), got \`${until}\``);
  if (from !== null && from === until) throw new UserError("`from` and `until` cannot name the same time");
  return { from, until };
}

// Starts a detached watch runner (a loop, or a window with `from`/`until`), answering the same shape `queue_run` does.
async function startRunner(req, env) {
  const body = await readJsonBody(req);
  if (body.mode !== "watch") throw new UserError("only `mode: \"watch\"` starts here; drain and once go through the `queue_run` tool");
  const watchIntervalS = intervalOf(body);
  const { from, until } = windowOf(body);
  refuseHomeWriteInsideJob(env);
  const started = await startQueueRunner({ watchIntervalS, from, until, env });
  return {
    started: started.started,
    pid: started.pid,
    mode: started.mode,
    logPath: started.logPath,
    waiting: started.waiting ?? null,
    message: started.waiting ? blockerLines(started.waiting, env).join("; ") : null,
  };
}

// Sets or clears the queue-wide pause sentinel, answering whether the queue is paused now.
function setPaused(env, paused) {
  refuseHomeWriteInsideJob(env);
  if (paused) pauseQueue(env);
  else resumeQueue(env);
  return { queue_paused: paused };
}

// The `from` byte offset of a log request, null when absent; anything but a non-negative integer is refused.
function logFromOf(url) {
  const raw = new URL(url ?? "/", "http://x").searchParams.get("from");
  if (raw === null) return null;
  const from = LOG_FROM_RE.test(raw) ? Number(raw) : NaN;
  if (!Number.isSafeInteger(from)) throw new UserError(`\`from\` expects a non-negative integer byte offset, got \`${raw}\``);
  return from;
}

// Up to `limit` bytes of a file from a byte offset, empty past its end.
async function readFileRange(path, { from, limit }) {
  const file = await open(path, "r");
  try {
    const length = Math.min(limit, Math.max(0, (await file.stat()).size - from));
    if (length === 0) return "";
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await file.read(buffer, 0, length, from);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await file.close();
  }
}

// Answers a job's log as plain text, the last mebibyte or a mebibyte from `?from=`, 404 when the job has no log.
async function sendJobLog(req, res, { env, ref }) {
  const id = parseJobRef(ref);
  const from = logFromOf(req.url);
  const path = jobLogPath(id, env);
  if (!existsSync(path)) return respond(res, 404, `no log for job \`${id}\``);
  const text = from === null ? readLogTail(path, RAW_LOG_BYTES) : await readFileRange(path, { from, limit: RAW_LOG_BYTES });
  if (text === null) return respond(res, 404, `no log for job \`${id}\``);
  res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
  res.end(text);
}

// The run directory of a job by its ref, undefined when the job does not exist and null while it has none.
async function jobRunDir(ref, env) {
  const id = parseJobRef(ref);
  const row = await withReadOnlyStore(env, (store) => store.jobs.getJob(id));
  if (!row) return undefined;
  return runDirOf(jobView(row, { full: true }), env);
}

// Answers the markdown artifacts of a job's run directory, an empty list while it has none, 404 when the job does not exist.
async function sendJobArtifacts(res, { env, ref }) {
  const dir = await jobRunDir(ref, env);
  if (dir === undefined) return respond(res, 404, `no job \`${ref}\``);
  return sendJson(res, 200, { artifacts: dir ? listArtifacts(dir) : [] });
}

// The artifact name of a request path segment, decoded; a malformed escape is refused.
function artifactNameOf(segment) {
  try {
    return decodeURIComponent(segment);
  } catch {
    throw new UserError(`unreadable artifact name \`${segment}\``);
  }
}

// Answers one artifact of a job as markdown, the first mebibyte when larger, 404 unless the name is a listed artifact.
async function sendJobArtifact(res, { env, ref, segment }) {
  const name = artifactNameOf(segment);
  const dir = await jobRunDir(ref, env);
  if (dir === undefined) return respond(res, 404, `no job \`${ref}\``);
  const artifact = dir ? readArtifactFile(dir, name) : null;
  if (!artifact) return respond(res, 404, `no artifact \`${name}\` for job \`${ref}\``);
  const headers = { "content-type": "text/markdown; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" };
  if (artifact.truncated) headers["x-nightqueue-truncated"] = "1";
  res.writeHead(200, headers);
  res.end(artifact.text);
}

// Answers the files a job touched with their line counts, 404 when the job does not exist.
async function sendJobDiffstat(res, { env, ref }) {
  const id = parseJobRef(ref);
  const row = await withReadOnlyStore(env, (store) => store.jobs.getJob(id));
  if (!row) return respond(res, 404, `no job \`${id}\``);
  return sendJson(res, 200, await jobDiffstat(jobView(row, { full: true }), env));
}

// Answers the hunks of one file a job changed, named by `?path=`; 404 when the job does not exist, 400 when the path is not one of its files.
async function sendJobDiff(req, res, { env, ref }) {
  const id = parseJobRef(ref);
  const path = new URL(req.url ?? "/", "http://x").searchParams.get("path");
  if (!path) throw new UserError("`path` expects the repo-relative path of a file the job changed");
  const row = await withReadOnlyStore(env, (store) => store.jobs.getJob(id));
  if (!row) return respond(res, 404, `no job \`${id}\``);
  const answer = await jobFileDiff(jobView(row, { full: true }), path, env);
  if (!answer) return respond(res, 400, `\`${path}\` is not one of the files of job ${jobRef(id)}`);
  return sendJson(res, 200, answer);
}

// The recalls of a job with where each hit was cited, the distinct applied total and the embedding they were ranked with.
async function recallsAnswer(job, recalls, env) {
  const applied = await appliedRefs({ job, recalls, env });
  return {
    ...withApplied(recalls, applied),
    embedding: { model: EMBEDDING_MODEL_ID, threshold: RECALL_COS_CUT },
  };
}

// Answers every memory recall of a job's whole log in run order, 404 when the job does not exist.
async function sendJobRecalls(res, { env, ref }) {
  const id = parseJobRef(ref);
  const row = await withReadOnlyStore(env, (store) => store.jobs.getJob(id));
  if (!row) return respond(res, 404, `no job \`${id}\``);
  const path = jobLogPath(id, env);
  const recalls = existsSync(path) ? await cachedRecalls(path) : [];
  return sendJson(res, 200, await recallsAnswer(jobView(row, { full: true }), recalls, env));
}

// The recalls of a log, scanned again only when the log's size or mtime changed since the last poll.
async function cachedRecalls(path) {
  const { size, mtimeMs } = await stat(path);
  const key = `${size}:${mtimeMs}`;
  const cached = recallsCache.get(path);
  if (cached?.key === key) return cached.recalls;
  const recalls = await jobRecalls(await readFile(path, "utf8"));
  recallsCache.delete(path);
  recallsCache.set(path, { key, recalls });
  if (recallsCache.size > RECALLS_CACHE_LIMIT) recallsCache.delete(recallsCache.keys().next().value);
  return recalls;
}

// Opens a terminal from a JSON body: 201 for a fresh one, 200 when the job's live session is reused.
async function createTerminal(req, res, terminals) {
  const body = await readJsonBody(req);
  const created = await terminals.create(body);
  return sendJson(res, created.reused ? 200 : 201, created);
}

// Routes one `/api/terminals` request (the listing, a create, or a close by id), answering whether it was one.
async function routeTerminals(req, res, { path, terminals }) {
  const one = TERMINAL_PATH.exec(path);
  if (path === "/api/terminals" && req.method === "GET") sendJson(res, 200, await terminals.list());
  else if (path === "/api/terminals" && req.method === "POST") await createTerminal(req, res, terminals);
  else if (one && req.method === "DELETE") sendJson(res, 200, terminals.remove(one[1]));
  else return false;
  return true;
}

// Routes one `/api` request to its handler, or answers 404/405 for a path or method this API does not have.
async function routeApi(req, res, { env, origin, path, terminals, fetchImpl }) {
  if (terminals && (await routeTerminals(req, res, { path, terminals }))) return;
  const isGet = req.method === "GET";
  const isPost = req.method === "POST";
  if (path === "/api/info" && isGet) return sendJson(res, 200, infoAnswer({ env, origin }));
  if (path === "/api/projects" && isGet) return sendJson(res, 200, { projects: await listedProjects({ env }) });
  if (path === "/api/runners/start" && isPost) return sendJson(res, 200, await startRunner(req, env));
  if (path === "/api/queue/pause" && isPost) return sendJson(res, 200, setPaused(env, true));
  if (path === "/api/queue/resume" && isPost) return sendJson(res, 200, setPaused(env, false));
  if (path === "/api/connections/linear" && isPost) {
    return sendJson(res, 200, await connectLinear({ body: await readJsonBody(req), env, fetchImpl: fetchImpl ?? globalThis.fetch }));
  }
  const integrations = await serveIntegrations(req, { path, env, fetchImpl, readBody: readJsonBody });
  if (integrations) return sendJson(res, integrations.status, integrations.body);
  const log = JOB_LOG_PATH.exec(path);
  if (log && isGet) return await sendJobLog(req, res, { env, ref: log[1] });
  const diffstat = JOB_DIFFSTAT_PATH.exec(path);
  if (diffstat && isGet) return await sendJobDiffstat(res, { env, ref: diffstat[1] });
  const diff = JOB_DIFF_PATH.exec(path);
  if (diff && isGet) return await sendJobDiff(req, res, { env, ref: diff[1] });
  const recalls = JOB_RECALLS_PATH.exec(path);
  if (recalls && isGet) return await sendJobRecalls(res, { env, ref: recalls[1] });
  const artifacts = JOB_ARTIFACTS_PATH.exec(path);
  if (artifacts && isGet) return await sendJobArtifacts(res, { env, ref: artifacts[1] });
  const artifact = JOB_ARTIFACT_PATH.exec(path);
  if (artifact && isGet) return await sendJobArtifact(res, { env, ref: artifact[1], segment: artifact[2] });
  return respond(res, 404, `unknown studio API route \`${req.method} ${path}\``);
}

// Serves one `/api` request: a user error is a 400 with its message, anything else a 500 without a stack.
export async function serveApi(req, res, context) {
  try {
    await routeApi(req, res, context);
  } catch (err) {
    if (res.headersSent) return res.destroy();
    if (err instanceof TerminalRefusal) return respond(res, err.status, err.message);
    if (err instanceof ApiRefusal) return sendJson(res, err.status, { error: err.message, code: err.code, ...err.details });
    if (err instanceof UserError) return respond(res, 400, err.message);
    process.stderr.write(`studio api ${req.method} ${context.path} failed: ${err?.stack ?? String(err)}\n`);
    return respond(res, 500, "the studio API failed; see the server output");
  }
}
