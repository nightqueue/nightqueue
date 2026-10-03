import { existsSync } from "node:fs";
import { UserError } from "../config/errors.mjs";
import { jobLogPath, queuePausedPath } from "../config/paths.mjs";
import { packageRoot } from "../host/paths.mjs";
import { parseJobRef } from "../memory/refs.mjs";
import { respond } from "../mcp/transports/http-gate.mjs";
import { listedProjects } from "../cli/project.mjs";
import { runtimeLabel } from "../cli/runtime-versions.mjs";
import { readVersion } from "../cli/version.mjs";
import { blockerLines } from "../queue/claim.mjs";
import { readLogTail } from "../queue/follow.mjs";
import { refuseHomeWriteInsideJob } from "../queue/home-guard.mjs";
import { pauseQueue, resumeQueue } from "../queue/pause.mjs";
import { WATCH_INTERVAL_DEFAULT_S } from "../queue/runner.mjs";
import { startQueueRunner } from "../queue/start.mjs";
import { parseWallClock } from "../queue/window.mjs";

const MAX_BODY_BYTES = 16 * 1024;
const RAW_LOG_BYTES = 1024 * 1024;
const MAX_INTERVAL_S = 86400;
const JOB_LOG_PATH = /^\/api\/jobs\/([^/]+)\/log$/;

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

// Answers the last mebibyte of a job's log as plain text, 404 when the job has no log.
function sendJobLog(res, { env, ref }) {
  const id = parseJobRef(ref);
  const path = jobLogPath(id, env);
  const text = existsSync(path) ? readLogTail(path, RAW_LOG_BYTES) : null;
  if (text === null) return respond(res, 404, `no log for job \`${id}\``);
  res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
  res.end(text);
}

// Routes one `/api` request to its handler, or answers 404/405 for a path or method this API does not have.
async function routeApi(req, res, { env, origin, path }) {
  const isGet = req.method === "GET";
  const isPost = req.method === "POST";
  if (path === "/api/info" && isGet) return sendJson(res, 200, infoAnswer({ env, origin }));
  if (path === "/api/projects" && isGet) return sendJson(res, 200, { projects: await listedProjects({ env }) });
  if (path === "/api/runners/start" && isPost) return sendJson(res, 200, await startRunner(req, env));
  if (path === "/api/queue/pause" && isPost) return sendJson(res, 200, setPaused(env, true));
  if (path === "/api/queue/resume" && isPost) return sendJson(res, 200, setPaused(env, false));
  const log = JOB_LOG_PATH.exec(path);
  if (log && isGet) return sendJobLog(res, { env, ref: log[1] });
  return respond(res, 404, `unknown studio API route \`${req.method} ${path}\``);
}

// Serves one `/api` request: a user error is a 400 with its message, anything else a 500 without a stack.
export async function serveApi(req, res, context) {
  try {
    await routeApi(req, res, context);
  } catch (err) {
    if (res.headersSent) return res.destroy();
    if (err instanceof UserError) return respond(res, 400, err.message);
    process.stderr.write(`studio api ${req.method} ${context.path} failed: ${err?.stack ?? String(err)}\n`);
    return respond(res, 500, "the studio API failed; see the server output");
  }
}
