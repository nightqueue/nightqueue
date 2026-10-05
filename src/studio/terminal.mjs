import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { UserError } from "../config/errors.mjs";
import { studioTerminalsDir } from "../config/paths.mjs";
import { packageRoot, spawnRoot } from "../host/paths.mjs";
import { jobRef, parseJobRef } from "../memory/refs.mjs";
import { refuseHomeWriteInsideJob } from "../queue/home-guard.mjs";
import { resolveJobSession } from "../queue/session.mjs";
import { withReadOnlyStore } from "../store/open.mjs";
import { loadPty } from "./pty.mjs";

export const TERMINAL_CAP = 6;
export const INSTRUCTION_MAX = 1000;
export const SESSION_STATUSES = Object.freeze(["gate", "failed", "done", "cancelled"]);
export const TERMINAL_ID = /^[0-9a-f]{16}$/;
export const TERMINAL_TIMING = Object.freeze({ killGraceMs: 2000, exitedTtlMs: 60_000 });
export const SPAWN_SELF_ENV = "NIGHTQUEUE_STUDIO_SPAWN_SELF";

const STUDIO_ENV_PREFIX = "NIGHTQUEUE_STUDIO_";

const REGISTRATION = /^\d+-[0-9a-f]{16}\.json$/;
const SCROLLBACK_BYTES = 256 * 1024;
const BODY_KEYS = new Set(["kind", "job", "project", "instruction"]);
const PS_TIMEOUT_MS = 5000;
const PTY_SIZE = { cols: 120, rows: 32 };
const RESIZE_LIMITS = { cols: [2, 500], rows: [1, 200] };
const PS_LINE = /^\s*(\S+\s+\S+\s+\d+\s+\d\d:\d\d:\d\d\s+\d{4})\s+(.+)$/;

// A create, delete or attach the studio refuses, carrying the HTTP status the API answers with.
export class TerminalRefusal extends Error {
  constructor(status, message) {
    super(message);
    this.name = "TerminalRefusal";
    this.status = status;
  }
}

// Reads one `ps -o lstart= -o command=` line into the start time and the command line, or null when it is not one.
export function parsePsLine(text) {
  const match = PS_LINE.exec(String(text ?? "").split("\n")[0]);
  return match ? { lstart: match[1].replace(/\s+/g, " "), command: match[2] } : null;
}

// The start time and command line of a live process, or null when ps does not know the pid.
function readProcess(pid) {
  const result = spawnSync("ps", ["-ww", "-p", String(pid), "-o", "lstart=", "-o", "command="], { encoding: "utf8", timeout: PS_TIMEOUT_MS });
  if (result.error || result.status !== 0) return null;
  return parsePsLine(result.stdout);
}

// Tells whether a pid is alive; a pid owned by another user counts as alive.
function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === "EPERM";
  }
}

// Root of the CLI a terminal runs: the studio's own tree when the dev loop asks for it, the current runtime otherwise.
function terminalCliRoot(env) {
  return env[SPAWN_SELF_ENV] === "1" ? packageRoot() : spawnRoot(env);
}

// The environment a pty child gets: the launcher's, without any `NIGHTQUEUE_STUDIO_*` setting (the studio's token above all).
function childEnv(env) {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith(STUDIO_ENV_PREFIX)));
}

// The launcher of the nightqueue CLI of the current runtime (resolved per terminal), which starts claude exactly as when typed.
function cliLauncher(env) {
  return (cliArgs) => {
    const entry = join(terminalCliRoot(env), "bin", "nightqueue.mjs");
    return { bin: process.execPath, entry, args: [entry, ...cliArgs], env: { ...env } };
  };
}

// The real reads, spawns and signals of a manager, each one overridable by a test.
function defaultDeps(env) {
  return {
    loadPty: () => loadPty(),
    readJob: (id) => withReadOnlyStore(env, (store) => store.jobs.getJob(id)),
    readProject: (key) => withReadOnlyStore(env, async (store) => (await store.projects.byId(key)) ?? (await store.projects.byName(key))),
    resolveSession: (job) => resolveJobSession(job, env),
    launch: cliLauncher(env),
    killImpl: (pid, signal) => process.kill(pid, signal),
    psImpl: readProcess,
    isAlive: processAlive,
    err: (line) => process.stderr.write(`${line}\n`),
    now: () => new Date().toISOString(),
  };
}

// Tells whether anything of a process group (a pty child leads its own) still runs; a group owned by another user counts as alive.
function groupAlive(killImpl, pid) {
  try {
    killImpl(-pid, 0);
    return true;
  } catch (err) {
    return err?.code === "EPERM";
  }
}

// Signals a process group, falling back to the pid alone only when asked (never once the leader exited: its pid may be recycled); answers whether a signal was delivered.
function signalGroup(killImpl, pid, signal, { fallbackToPid }) {
  try {
    killImpl(-pid, signal);
    return true;
  } catch {
    if (!fallbackToPid) return false;
    try {
      killImpl(pid, signal);
      return true;
    } catch {
      return false;
    }
  }
}

// Removes a file, ignoring one that is already gone.
function removeFile(path) {
  rmSync(path, { force: true });
}

// The instruction of a create body, sanitized to one line, or null when the body carries none; refuses one over the cap, empty, or option-like.
export function sanitizeInstruction(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new TerminalRefusal(400, "`instruction` must be a string");
  if ([...value].length > INSTRUCTION_MAX) throw new TerminalRefusal(400, `the instruction is over ${INSTRUCTION_MAX} characters; it is never truncated`);
  const text = value.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ").replace(/\s+/g, " ").trim();
  if (!text) throw new TerminalRefusal(400, "the instruction is empty");
  if (text.startsWith("-")) throw new TerminalRefusal(400, "an instruction cannot start with `-`");
  return text;
}

// The CLI argument carrying an instruction, always one `--prompt=<text>` element so it can never be split nor read as an option.
function promptArg(text) {
  return text === null ? [] : [`--prompt=${text}`];
}

// Refuses a create body that is not an object or carries a key the studio does not read, `cwd` above all.
function checkBody(body) {
  if (body === null || typeof body !== "object" || Array.isArray(body)) throw new TerminalRefusal(400, "the body must be a JSON object");
  const extra = Object.keys(body).filter((key) => !BODY_KEYS.has(key));
  if (extra.length > 0) {
    throw new TerminalRefusal(400, `unknown key ${extra.map((key) => `\`${key}\``).join(", ")}: the terminal's directory comes from the job or the project registry, never the request`);
  }
  if (body.kind !== "session" && body.kind !== "operator") throw new TerminalRefusal(400, "`kind` must be `session` or `operator`");
}

// Refuses a create from inside a job against the runner's own home: a job never spawns claude there.
function refuseInsideJob(env) {
  try {
    refuseHomeWriteInsideJob(env);
  } catch (err) {
    if (err instanceof UserError) throw new TerminalRefusal(403, err.message);
    throw err;
  }
}

// Reads a resize text frame, answering `{ cols, rows }` within the limits or null for anything else.
export function parseResize(text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  const size = value?.resize;
  const inRange = (key) => Number.isInteger(size?.[key]) && size[key] >= RESIZE_LIMITS[key][0] && size[key] <= RESIZE_LIMITS[key][1];
  return inRange("cols") && inRange("rows") ? { cols: size.cols, rows: size.rows } : null;
}

// Appends output to a terminal's scrollback, dropping the oldest bytes past the cap.
function appendScrollback(record, chunk) {
  record.scrollback.push(chunk);
  record.scrollbackBytes += chunk.length;
  while (record.scrollbackBytes > SCROLLBACK_BYTES) {
    const excess = record.scrollbackBytes - SCROLLBACK_BYTES;
    const first = record.scrollback[0];
    if (first.length <= excess) {
      record.scrollback.shift();
      record.scrollbackBytes -= first.length;
    } else {
      record.scrollback[0] = first.subarray(excess);
      record.scrollbackBytes -= excess;
    }
  }
}

// The public view of a terminal the listing and the create answer carry.
function terminalInfo(record) {
  return {
    id: record.id,
    kind: record.kind,
    label: record.label,
    job_ref: record.jobId === null ? null : jobRef(record.jobId),
    project: record.project,
    cwd: record.cwd,
    note: record.note,
    created_at: record.createdAt,
    attached: record.client !== null,
    exited: record.exited ?? false,
    instruction: record.instruction,
  };
}

// Reads one registration file, answering null for one that is unreadable or not a registration.
function readRegistration(path) {
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    const valid = [value?.pid, value?.port, value?.owner_pid].every((n) => Number.isInteger(n) && n >= 0) && value.pid > 0;
    const named = [value?.bin, value?.entry].every((text) => typeof text === "string" && text !== "");
    return valid && named ? value : null;
  } catch {
    return null;
  }
}

// Tells whether a pid still runs the CLI a registration recorded: a recorded start time that still matches, and the CLI entry on the command line.
function stillRecordedProcess(registration, psImpl) {
  if (typeof registration.lstart !== "string") return false;
  const seen = psImpl(registration.pid);
  return seen !== null && seen !== undefined && seen.lstart === registration.lstart && seen.command.includes(registration.entry);
}

// Creates the terminal manager of one studio server: spawns claude in a pty, lists, attaches, kills, and reaps what an earlier studio left.
export function createTerminalManager({ env = process.env, port, deps = {}, timing = {} } = {}) {
  const m = {
    env,
    port,
    deps: { ...defaultDeps(env), ...deps },
    timing: { ...TERMINAL_TIMING, ...timing },
    terminals: new Map(),
    ending: new Set(),
    queue: Promise.resolve(),
    ptyLoad: null,
    timers: new Set(),
    closed: false,
    onProcessExit: null,
  };
  m.onProcessExit = () => killAllSync(m);
  process.on("exit", m.onProcessExit);
  return {
    list: () => listTerminals(m),
    create: (body) => serialized(m, () => createTerminal(m, body)),
    attach: (id, client) => attachClient(m, id, client),
    isLive: (id) => liveRecord(m, id) !== null,
    remove: (id) => removeTerminal(m, id),
    reap: () => reapRegistrations(m),
    closeAll: () => closeAll(m),
    killAllSync: () => killAllSync(m),
  };
}

// Drops the process-exit net once the manager is closed and none of its children is still being ended.
function releaseExitHook(m) {
  if (m.closed && m.ending.size === 0) process.off("exit", m.onProcessExit);
}

// Runs creates one after the other, so a burst never passes the cap nor opens two sessions of one job.
function serialized(m, fn) {
  const run = m.queue.then(fn);
  m.queue = run.catch(() => {});
  return run;
}

// A timer the manager tracks, so closing it cancels what is still pending.
function later(m, ms, fn) {
  const timer = setTimeout(() => {
    m.timers.delete(timer);
    fn();
  }, ms);
  m.timers.add(timer);
  return timer;
}

// Cancels a tracked timer.
function cancel(m, timer) {
  if (!timer) return;
  clearTimeout(timer);
  m.timers.delete(timer);
}

// The node-pty load of this manager, asked once.
function ptyState(m) {
  m.ptyLoad ??= Promise.resolve()
    .then(() => m.deps.loadPty())
    .catch((err) => ({ available: false, reason: String(err?.message ?? err).split("\n")[0] }));
  return m.ptyLoad;
}

// The terminals still running, the ones the cap counts.
function liveTerminals(m) {
  return [...m.terminals.values()].filter((record) => !record.exited);
}

// Answers whether the studio can embed a terminal and every terminal it holds; the listing lives in memory only.
async function listTerminals(m) {
  const loaded = await ptyState(m);
  return {
    available: loaded.available === true,
    reason: loaded.available ? null : loaded.reason,
    cap: TERMINAL_CAP,
    instruction_max: INSTRUCTION_MAX,
    terminals: [...m.terminals.values()].map(terminalInfo),
  };
}

// Validates a create body, resolves where claude runs from the job or the registry, and spawns it; answers `{ terminal, reused }`.
async function createTerminal(m, body) {
  checkBody(body);
  const instruction = sanitizeInstruction(body.instruction);
  refuseInsideJob(m.env);
  refuseWhenClosing(m);
  const loaded = await ptyState(m);
  refuseWhenClosing(m);
  if (!loaded.available) throw new TerminalRefusal(503, `terminal unavailable: ${loaded.reason}`);
  const plan = body.kind === "session" ? await sessionPlan(m, body, instruction) : await operatorPlan(m, body, instruction);
  refuseWhenClosing(m);
  if (plan.reused) return { terminal: terminalInfo(plan.reused), reused: true };
  if (liveTerminals(m).length >= TERMINAL_CAP) throw new TerminalRefusal(409, `${TERMINAL_CAP} terminals are open, the cap; close one first`);
  const record = spawnTerminal(m, { ...plan, instruction, pty: loaded.pty });
  return { terminal: terminalInfo(record), reused: false };
}

// Refuses a create once the studio started closing, so no child is born after closeAll.
function refuseWhenClosing(m) {
  if (m.closed) throw new TerminalRefusal(503, "the studio is closing");
}

// The job a session terminal resumes, read from the store by its ref.
async function readJobOf(m, ref) {
  let id;
  try {
    id = parseJobRef(ref);
  } catch (err) {
    throw new TerminalRefusal(400, err.message);
  }
  const job = await m.deps.readJob(id);
  if (!job) throw new TerminalRefusal(404, `unknown job \`${jobRef(id)}\``);
  return job;
}

// The launch of a session terminal: the job's last session, resumed in its worktree or checkout, or the live one already open.
async function sessionPlan(m, body, instruction) {
  const job = await readJobOf(m, body.job);
  const ref = jobRef(job.id);
  if (!SESSION_STATUSES.includes(job.status)) {
    throw new TerminalRefusal(409, `${ref} is ${job.status}; the studio resumes only ${SESSION_STATUSES.join(", ")} jobs`);
  }
  const open = liveTerminals(m).find((record) => record.kind === "session" && record.jobId === job.id);
  if (open && instruction !== null) throw new TerminalRefusal(409, `${ref} already has a live session; an instruction can only start a new one`);
  if (open) return { reused: open };
  const resolved = resolveOrRefuse(m, job);
  const note = resolved.worktreeReleased ? "the worktree was released; resumed in the project checkout" : null;
  const launch = m.deps.launch(["queue", "session", ref, ...promptArg(instruction)]);
  return { kind: "session", label: `${ref} session`, jobId: job.id, project: job.project ?? null, cwd: resolved.cwd, note, launch };
}

// The session and cwd of a job, a refusal naming why it cannot be resumed.
function resolveOrRefuse(m, job) {
  try {
    return m.deps.resolveSession(job);
  } catch (err) {
    if (err instanceof UserError) throw new TerminalRefusal(409, err.message);
    throw err;
  }
}

// The launch of an operator terminal: a fresh operator in the project's registered checkout.
async function operatorPlan(m, body, instruction) {
  if (typeof body.project !== "string" || body.project.trim() === "") throw new TerminalRefusal(400, "`project` must name a registered project");
  const project = await m.deps.readProject(body.project.trim());
  if (!project) throw new TerminalRefusal(404, `unknown project \`${body.project}\``);
  if (!project.path || !existsSync(project.path)) throw new TerminalRefusal(409, `the checkout of \`${project.name}\` is gone (${project.path ?? "none registered"})`);
  const launch = m.deps.launch(["open", project.name, ...promptArg(instruction)]);
  return { kind: "operator", label: `${project.name} operator`, jobId: null, project: project.name, cwd: project.path, note: null, launch };
}

// Path of the registration file of one terminal of this studio.
function registrationPath(m, id) {
  return join(studioTerminalsDir(m.env), `${m.port}-${id}.json`);
}

// Spawns the nightqueue CLI in a pty as a foreground child, records it for the reaper, and wires its output and exit.
function spawnTerminal(m, plan) {
  refuseWhenClosing(m);
  const { launch } = plan;
  let child;
  try {
    child = plan.pty.spawn(launch.bin, launch.args, {
      name: "xterm-256color",
      ...PTY_SIZE,
      cwd: plan.cwd,
      env: { ...childEnv(launch.env), TERM: "xterm-256color", COLORTERM: "truecolor" },
      encoding: null,
    });
  } catch (err) {
    throw new TerminalRefusal(500, `could not start \`${launch.bin}\` in ${plan.cwd}: ${err.message}`);
  }
  const record = newRecord(m, plan, child);
  m.terminals.set(record.id, record);
  writeRegistration(m, record, launch);
  child.onData((data) => onOutput(record, Buffer.isBuffer(data) ? data : Buffer.from(String(data))));
  child.onExit(({ exitCode, signal } = {}) => onChildExit(m, record, { code: exitCode ?? null, signal: signal || null }));
  return record;
}

// The in-memory state of a freshly spawned terminal.
function newRecord(m, plan, child) {
  const id = randomBytes(8).toString("hex");
  return {
    id,
    kind: plan.kind,
    label: plan.label,
    jobId: plan.jobId,
    project: plan.project,
    cwd: plan.cwd,
    note: plan.note,
    createdAt: m.deps.now(),
    child,
    pid: child.pid,
    client: null,
    paused: false,
    exited: null,
    scrollback: [],
    scrollbackBytes: 0,
    instruction: plan.instruction === null ? null : "given",
    killTimer: null,
    file: registrationPath(m, id),
  };
}

// Writes the registration the next studio's reaper reads; a failure only warns, the terminal keeps running.
function writeRegistration(m, record, launch) {
  const lstart = m.deps.psImpl(record.pid)?.lstart ?? null;
  if (lstart === null) m.deps.err(`studio: warning: no start time for terminal ${record.id}; a later studio will not end it if this one dies`);
  const registration = { id: record.id, port: m.port, owner_pid: process.pid, pid: record.pid, lstart, bin: launch.bin, entry: launch.entry ?? null, kind: record.kind, job_id: record.jobId, project: record.project, created_at: record.createdAt };
  try {
    mkdirSync(studioTerminalsDir(m.env), { recursive: true });
    writeFileSync(record.file, `${JSON.stringify(registration)}\n`);
  } catch (err) {
    m.deps.err(`studio: warning: could not record terminal ${record.id} at ${record.file}: ${err.message}`);
  }
}

// Keeps a chunk of output for a later attach and streams it to the attached client, pausing the pty while the socket is full.
function onOutput(record, chunk) {
  appendScrollback(record, chunk);
  const client = record.client;
  if (!client || client.sendBinary(chunk) !== false || record.paused) return;
  record.paused = true;
  record.child.pause();
  client.socket?.once?.("drain", () => {
    if (record.client === client) resumeOutput(record);
  });
}

// Resumes a paused pty once its client drained, or left.
function resumeOutput(record) {
  if (!record.paused) return;
  record.paused = false;
  if (!record.exited) record.child.resume();
}

// Records a child's exit: its registration goes, its client closes, the tab lingers a while as exited, and a group that outlives it is ended.
function onChildExit(m, record, exit) {
  record.exited = exit;
  removeFile(record.file);
  if (!groupAlive(m.deps.killImpl, record.pid)) {
    cancel(m, record.killTimer);
    m.ending.delete(record);
    releaseExitHook(m);
  } else if (!m.ending.has(record)) {
    hangUp(m, record);
  }
  const client = record.client;
  record.client = null;
  client?.close(1000, `exited ${exit.code ?? exit.signal ?? ""}`.trim());
  const ttl = later(m, m.timing.exitedTtlMs, () => {
    if (m.terminals.get(record.id) === record) m.terminals.delete(record.id);
  });
  ttl.unref?.();
}

// The terminal of that id while its child still runs, null otherwise.
function liveRecord(m, id) {
  const record = TERMINAL_ID.test(String(id)) ? m.terminals.get(id) : null;
  return record && !record.exited ? record : null;
}

// Attaches a websocket client to a live terminal: the newest attach wins, the scrollback replays, then input and resizes flow to the pty.
function attachClient(m, id, client) {
  const record = liveRecord(m, id);
  if (!record) throw new TerminalRefusal(404, `no live terminal \`${id}\``);
  const previous = record.client;
  record.client = client;
  previous?.close(4001, "attached elsewhere");
  if (record.paused) resumeOutput(record);
  if (record.scrollbackBytes > 0) client.sendBinary(Buffer.concat(record.scrollback));
  client.onMessage((payload, binary) => onClientMessage(record, payload, binary));
  client.onClose(() => {
    if (record.client !== client) return;
    record.client = null;
    resumeOutput(record);
  });
  return terminalInfo(record);
}

// Sends a client's bytes to the pty; a text frame is only ever a resize, anything else is ignored.
function onClientMessage(record, payload, binary) {
  if (record.exited) return;
  if (binary) {
    record.child.write(Buffer.isBuffer(payload) ? payload : Buffer.from(payload));
    return;
  }
  const size = parseResize(Buffer.isBuffer(payload) ? payload.toString("utf8") : String(payload));
  if (size) record.child.resize(size.cols, size.rows);
}

// Hangs up a terminal's process group and escalates to SIGKILL after the grace period when anything of it still runs.
function hangUp(m, record) {
  cancel(m, record.killTimer);
  m.ending.add(record);
  signalGroup(m.deps.killImpl, record.pid, "SIGHUP", { fallbackToPid: !record.exited });
  record.killTimer = later(m, m.timing.killGraceMs, () => {
    if (groupAlive(m.deps.killImpl, record.pid)) signalGroup(m.deps.killImpl, record.pid, "SIGKILL", { fallbackToPid: !record.exited });
    removeFile(record.file);
    m.ending.delete(record);
    releaseExitHook(m);
  });
}

// Ends a terminal the user closed: SIGHUP to its group then SIGKILL, and it leaves the listing at once.
function removeTerminal(m, id) {
  const record = TERMINAL_ID.test(String(id)) ? m.terminals.get(id) : null;
  if (!record) throw new TerminalRefusal(404, `no terminal \`${id}\``);
  m.terminals.delete(id);
  if (record.exited) return { id, ended: false };
  hangUp(m, record);
  return { id, ended: true };
}

// Ends every terminal when the server closes: SIGHUP then SIGKILL to each group, and a going-away close to each client.
function closeAll(m) {
  for (const record of liveTerminals(m)) {
    const client = record.client;
    record.client = null;
    client?.close(1001, "studio closing");
    hangUp(m, record);
  }
  m.terminals.clear();
  m.closed = true;
  releaseExitHook(m);
}

// Kills every terminal still running or being ended at once when the process exits, removing their registrations synchronously.
function killAllSync(m) {
  for (const record of new Set([...liveTerminals(m), ...m.ending])) {
    signalGroup(m.deps.killImpl, record.pid, "SIGKILL", { fallbackToPid: !record.exited });
    removeFile(record.file);
  }
}

// The registration files of the home, an empty list when the directory does not exist.
function registrationFiles(m) {
  try {
    return readdirSync(studioTerminalsDir(m.env)).filter((name) => REGISTRATION.test(name));
  } catch (err) {
    if (err?.code === "ENOENT") return [];
    throw err;
  }
}

// Reaps one registration: kept when another live studio owns it, else its CLI group is ended when it is still the one recorded, and the file goes.
function reapOne(m, path) {
  const registration = readRegistration(path);
  if (registration && registration.port !== m.port && m.deps.isAlive(registration.owner_pid)) return false;
  const killed = registration !== null && stillRecordedProcess(registration, m.deps.psImpl);
  if (killed) {
    signalGroup(m.deps.killImpl, registration.pid, "SIGHUP", { fallbackToPid: true });
    later(m, m.timing.killGraceMs, () => {
      if (groupAlive(m.deps.killImpl, registration.pid)) signalGroup(m.deps.killImpl, registration.pid, "SIGKILL", { fallbackToPid: false });
    });
  }
  removeFile(path);
  return killed;
}

// Ends the terminals an earlier studio left (its port, or a dead owner's), answering how many claude processes it ended.
function reapRegistrations(m) {
  const dir = studioTerminalsDir(m.env);
  let reaped = 0;
  for (const name of registrationFiles(m)) {
    if (reapOne(m, join(dir, name))) reaped += 1;
  }
  if (reaped > 0) m.deps.err(`studio: reaped ${reaped} terminal(s) left by an earlier studio`);
  return reaped;
}
