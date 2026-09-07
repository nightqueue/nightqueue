import { spawn } from "node:child_process";
import { accessSync, appendFileSync, constants, createWriteStream, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import { homeDir } from "../config/paths.mjs";
import { isSessionIdSafe } from "./stream.mjs";

// Silence of the stream that means a dead process: no event at all for this long ends the attempt.
export const IDLE_TIMEOUT_S = 1200;
// Interval of the ownership poll inside the spawn: one lease renewal per tick, never per line.
export const STOP_POLL_MS = 5000;
export const SPAWN_STDIO = ["ignore", "pipe", "pipe"];
export const KILL_GRACE_MS = 10000;
export const CLAUDE_MISSING_MESSAGE =
  "`claude` CLI not found; install Claude Code or set NIGHTSHIFT_CLAUDE_BIN to its absolute path";

const MISSING_BIN = Object.freeze({ bin: null, via: "missing" });
const DEFAULT_TIMEOUT_S = 14400;

// Root of this package, the anchor of the plugin directory and of the MCP entrypoint.
export function packageRoot() {
  return fileURLToPath(new URL("../../", import.meta.url));
}

// Directory of the nightshift plugin handed to the child through --plugin-dir.
export function pluginDir() {
  return join(packageRoot(), "plugin");
}

// Entrypoint of this CLI, used to start the nightshift MCP server and the detached runner.
export function cliEntrypoint() {
  return join(packageRoot(), "bin", "shift.mjs");
}

// Inline --mcp-config value: one single argv string, no shell and no temporary file.
export function mcpConfigArg(env = process.env) {
  return JSON.stringify({
    mcpServers: {
      nightshift: {
        command: process.execPath,
        args: [cliEntrypoint(), "mcp"],
        env: { NIGHTSHIFT_HOME: homeDir(env) },
      },
    },
  });
}

// Common installation paths of the CLI, in order of preference, used when PATH does not resolve it.
function fixedCandidates(home) {
  return [join(home, ".local", "bin", "claude"), "/opt/homebrew/bin/claude", "/usr/local/bin/claude"];
}

// Paths to test, in order of precedence, each one with the source that produced it.
function candidateBins(env, home) {
  const candidates = [];
  const fromEnv = String(env?.NIGHTSHIFT_CLAUDE_BIN ?? "").trim();
  if (fromEnv && isAbsolute(fromEnv)) candidates.push({ bin: fromEnv, via: "env" });
  for (const dir of String(env?.PATH ?? "").split(delimiter)) {
    if (dir) candidates.push({ bin: join(dir, "claude"), via: "path" });
  }
  for (const bin of fixedCandidates(home)) candidates.push({ bin, via: "candidate" });
  return candidates;
}

// Tells whether the path exists and is executable by the current user.
function isRunnable(path) {
  try {
    accessSync(path, constants.X_OK);
    return existsSync(path);
  } catch {
    return false;
  }
}

// Resolves the `claude` binary (env, then PATH, then fixed candidates); absence never throws.
export function resolveClaudeBin(env = process.env) {
  try {
    const home = String(env?.HOME ?? "").trim() || homedir();
    const found = candidateBins(env, home).find(({ bin }) => isRunnable(bin));
    return found ? Object.freeze({ bin: found.bin, via: found.via }) : MISSING_BIN;
  } catch {
    return MISSING_BIN;
  }
}

// Extra block appended to the prompt when the operator left a decision on the job.
function operatorBlock(operatorNote) {
  const note = typeof operatorNote === "string" ? operatorNote.trim() : "";
  return note ? `\n\nOPERATOR DECISION: ${note}` : "";
}

// Extra block appended to the prompt when the previous run of this job can be resumed.
function resumeBlock(resume) {
  if (resume?.resume !== true) return "";
  return [
    "",
    "",
    `RESUME: a previous run of this job stopped after the \`${resume.lastPhase}\` phase.`,
    `Resume from the \`${resume.fromPhase}\` phase, reuse the registered worktree and read the existing`,
    "artifacts in the run directory instead of redoing them.",
    "Run `git status --short` in the worktree first.",
  ].join("\n");
}

// Builds the prompt of the unattended run; every marker is quoted inline, so the echo never looks like one.
export function buildPrompt({ job, resume } = {}) {
  const base = [
    `/nightshift:resolve ${String(job?.prompt ?? "").trim()}`,
    "",
    `Unattended run, job #${job?.id}, no operator available.`,
    "Print `QUEUE_SLUG: <slug>` alone on a line as soon as the slug exists.",
    "Open the pull request at the end.",
    "If you need a human decision, stop at the gate and print `## Requires user confirmation`.",
  ].join("\n");
  return `${base}${operatorBlock(job?.operator_note)}${resumeBlock(resume)}`;
}

// Builds the argv of the child: an array, never a shell, with --resume only behind the session id gate.
export function buildArgs({ prompt, resumeSessionId = null, env = process.env } = {}) {
  const args = [
    "-p",
    String(prompt ?? ""),
    "--permission-mode",
    "bypassPermissions",
    "--output-format",
    "stream-json",
    "--verbose",
    "--plugin-dir",
    pluginDir(),
    "--mcp-config",
    mcpConfigArg(env),
  ];
  if (isSessionIdSafe(resumeSessionId)) args.push("--resume", resumeSessionId);
  return args;
}

// Opens the accumulated log of the job in append mode, separating the attempt that is about to start.
export function openAttemptLog(logPath, attempt) {
  mkdirSync(dirname(logPath), { recursive: true });
  appendFileSync(logPath, `=== attempt ${attempt} @ ${new Date().toISOString()} ===\n`);
  return createWriteStream(logPath, { flags: "a" });
}

// Delivers one line to the consumer, which is never allowed to bring the spawn down.
function safeEmit(onLine, line) {
  try {
    onLine(line);
  } catch {
    return;
  }
}

// Emits every complete line of stdout through onLine; returns a flush of the remaining partial line.
function attachLineEmitter(child, onLine) {
  if (typeof onLine !== "function") return () => {};
  const decoder = new StringDecoder("utf8");
  let buffer = "";
  const emit = (line) => safeEmit(onLine, line);
  child.stdout.on("data", (chunk) => {
    buffer += decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), "utf8"));
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) emit(line);
  });
  return () => {
    buffer += decoder.end();
    if (buffer) emit(buffer);
    buffer = "";
  };
}

// Positive number of seconds, or the given fallback when the value is not usable.
function seconds(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

// Runs the headless claude CLI (prompt through argv, never a shell) and resolves with the outcome of the attempt.
export function spawnClaude({
  prompt,
  cwd,
  timeoutS,
  idleTimeoutS = IDLE_TIMEOUT_S,
  logPath,
  env = process.env,
  attempt = 1,
  jobId = null,
  spawnImpl = spawn,
  onLine,
  stopSignalImpl = null,
  stopPollMs = STOP_POLL_MS,
  resumeSessionId = null,
  resolveBinImpl = resolveClaudeBin,
} = {}) {
  return new Promise((settle) => {
    const stream = openAttemptLog(logPath, attempt);
    const resolved = resolveBinImpl(env);
    const args = buildArgs({ prompt, resumeSessionId, env });
    const childEnv = jobId === null ? { ...env } : { ...env, NIGHTSHIFT_JOB_ID: String(jobId) };
    const child = spawnImpl(resolved?.bin ?? "claude", args, { cwd, env: childEnv, stdio: SPAWN_STDIO });
    const chunks = [];
    let timedOut = false;
    let idleTimedOut = false;
    let stopped = false;
    let killed = false;
    let killTimer = null;
    let idleTimer = null;
    let stopTimer = null;
    const totalTimer = setTimeout(() => triggerKill("timeout"), seconds(timeoutS, DEFAULT_TIMEOUT_S) * 1000);
    function triggerKill(reason) {
      if (killed) return;
      killed = true;
      if (reason === "stop") stopped = true;
      else timedOut = true;
      if (reason === "idle") idleTimedOut = true;
      clearTimers();
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
    }
    function clearTimers() {
      clearTimeout(totalTimer);
      if (idleTimer) clearTimeout(idleTimer);
      if (stopTimer) clearInterval(stopTimer);
    }
    function armIdle() {
      if (killed) return;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => triggerKill("idle"), seconds(idleTimeoutS, IDLE_TIMEOUT_S) * 1000);
    }
    const capture = (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), "utf8"));
      armIdle();
    };
    child.stdout.on("data", capture);
    child.stderr.on("data", capture);
    child.stdout.pipe(stream, { end: false });
    child.stderr.pipe(stream, { end: false });
    const flushLines = attachLineEmitter(child, onLine);
    if (typeof stopSignalImpl === "function") {
      let checking = false;
      stopTimer = setInterval(async () => {
        if (checking || killed) return;
        checking = true;
        try {
          if (await stopSignalImpl()) triggerKill("stop");
        } catch {
          return;
        } finally {
          checking = false;
        }
      }, Math.max(500, Number(stopPollMs) || STOP_POLL_MS));
    }
    armIdle();
    const finish = (payload) => {
      clearTimers();
      if (killTimer) clearTimeout(killTimer);
      killed = true;
      flushLines();
      stream.end();
      settle(payload);
    };
    child.on("close", (code) => {
      finish({
        exitCode: code ?? -1,
        timedOut,
        idleTimedOut,
        stopped,
        spawnError: null,
        log: Buffer.concat(chunks).toString("utf8"),
      });
    });
    child.on("error", (err) => {
      const reason = err?.code === "ENOENT" ? CLAUDE_MISSING_MESSAGE : `spawn error: ${err?.message ?? String(err)}`;
      appendFileSync(logPath, `${reason}\n`);
      finish({ exitCode: -1, timedOut: false, idleTimedOut: false, stopped: false, spawnError: reason, log: reason });
    });
  });
}
