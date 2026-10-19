import { spawn } from "node:child_process";

const CALL_TIMEOUT_MS = 60000;
const ACCOUNT_STATUS_TIMEOUT_MS = 15000;
const MAX_BUFFER = 16 * 1024 * 1024;
const MAX_TIMER_MS = 2 ** 31 - 1;
const OWN_ENV_PREFIX = "NIGHTQUEUE_";
const ANSI_RE = /\u001b\[[0-9;]*[A-Za-z]/g;
const TOKEN_SUFFIX_RE = /\s*\(authenticated using EXPO_TOKEN\)\s*$/i;
const FULL_NAME_RE = /@([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)/;

// Path of the Expo CLI (eas), the resolver every call of this module goes through.
export function easBin(env = process.env) {
  const raw = typeof env?.NIGHTQUEUE_EAS_BIN === "string" ? env.NIGHTQUEUE_EAS_BIN.trim() : "";
  return raw || "eas";
}

// A copy of an environment without any nightqueue variable, so eas never inherits the queue's own settings.
export function easEnv(env = process.env) {
  return Object.fromEntries(Object.entries(env ?? {}).filter(([key]) => !key.startsWith(OWN_ENV_PREFIX)));
}

// Tells whether an eas call was killed (timeout, abort or signal) before it could answer.
function killedBeforeAnswer(err) {
  if (!err) return false;
  return err.killed === true || Boolean(err.signal) || err.name === "AbortError" || err.code === "ETIMEDOUT";
}

// The result of one eas call, from what execFile answered.
function easResult(err, stdout, stderr) {
  return {
    ok: !err,
    stdout: typeof stdout === "string" ? stdout : "",
    stderr: typeof stderr === "string" && stderr ? stderr : (err?.message ?? ""),
    missing: err?.code === "ENOENT",
    unfinished: killedBeforeAnswer(err),
    code: Number.isInteger(err?.code) ? err.code : (err ? null : 0),
  };
}

// Tells whether a delay can be handed to setTimeout as is.
function isTimerDelay(ms) {
  return Number.isFinite(ms) && ms > 0 && ms <= MAX_TIMER_MS;
}

// Terminates every process an eas call started (its own process group), so no grandchild outlives a timeout or an abort.
function killProcessGroup(child) {
  if (!Number.isInteger(child?.pid) || child.pid <= 0) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    return;
  }
}

// The execFile-shaped error of a finished child: null on a clean exit, else its exit code, signal or the reason it was killed.
function exitError({ code, signal, killedBy }) {
  if (killedBy === "abort") return Object.assign(new Error("The operation was aborted"), { name: "AbortError", code: "ABORT_ERR" });
  if (killedBy === "maxBuffer") return Object.assign(new Error("stdout or stderr maxBuffer exceeded"), { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", killed: true });
  if (code === 0 && !signal && !killedBy) return null;
  return Object.assign(new Error(`eas exited ${code ?? signal}`), { code, signal, killed: Boolean(killedBy) });
}

// Runs a command in its own process group, execFile-style, killing the whole group on timeout, abort or an output past maxBuffer.
export function execFileDetached(file, args, options, callback) {
  const { cwd, env, timeout, signal, maxBuffer = MAX_BUFFER } = options ?? {};
  const child = spawn(file, args, { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  const state = { stdout: "", stderr: "", killedBy: null, finished: false, timer: null };
  const kill = (reason) => {
    state.killedBy ??= reason;
    killProcessGroup(child);
  };
  const onAbort = () => kill("abort");
  const finish = (err) => {
    if (state.finished) return;
    state.finished = true;
    clearTimeout(state.timer);
    signal?.removeEventListener("abort", onAbort);
    callback(err, state.stdout, state.stderr);
  };
  const collect = (key) => (chunk) => {
    state[key] += chunk;
    if (state.stdout.length + state.stderr.length > maxBuffer) kill("maxBuffer");
  };
  child.stdout?.setEncoding("utf8").on("data", collect("stdout"));
  child.stderr?.setEncoding("utf8").on("data", collect("stderr"));
  child.on("error", (err) => finish(err));
  child.on("close", (code, exitSignal) => finish(exitError({ code, signal: exitSignal, killedBy: state.killedBy })));
  if (isTimerDelay(timeout)) state.timer = setTimeout(() => kill("timeout"), timeout);
  if (signal?.aborted) onAbort();
  else signal?.addEventListener("abort", onAbort, { once: true });
  return child;
}

// Runs the Expo CLI without blocking the event loop and without ever rejecting: a missing binary, a failure and a timeout are results.
export function runEasAsync(args, { cwd, env = process.env, execFileImpl = execFileDetached, timeoutMs = CALL_TIMEOUT_MS, signal } = {}) {
  return new Promise((done) => {
    const answer = (err, stdout, stderr) => done(easResult(err, stdout, stderr));
    try {
      const options = { cwd, encoding: "utf8", timeout: timeoutMs, maxBuffer: MAX_BUFFER, env: easEnv(env), signal };
      execFileImpl(easBin(env), args, options, answer);
    } catch (err) {
      answer(err, "", "");
    }
  });
}

// The account name `eas whoami` printed, or null when the text carries none.
export function parseEasWhoami(text) {
  const line = String(text ?? "")
    .replace(ANSI_RE, "")
    .split("\n")
    .map((entry) => entry.trim())
    .find(Boolean);
  if (!line) return null;
  return line.replace(TOKEN_SUFFIX_RE, "").trim() || null;
}

// Tells, without blocking the event loop, whether eas is installed and logged in (null when it did not answer in time), and as whom; never answers raw output.
export async function easAccountStatus({ env = process.env, execFileImpl = execFileDetached, timeoutMs = ACCOUNT_STATUS_TIMEOUT_MS, signal } = {}) {
  const result = await runEasAsync(["whoami"], { env, execFileImpl, timeoutMs, signal });
  return {
    installed: !result.missing,
    authenticated: result.unfinished ? null : result.ok,
    login: result.ok ? parseEasWhoami(result.stdout) : null,
    host: null,
  };
}

// The owner and slug of the `@owner/slug` full name `eas project:info` prints, or null.
export function parseEasProjectFullName(text) {
  const match = FULL_NAME_RE.exec(String(text ?? "").replace(ANSI_RE, ""));
  return match ? { owner: match[1], slug: match[2] } : null;
}

// The expo.dev dashboard URL of one update group.
export function easUpdateGroupUrl(owner, slug, group) {
  const enc = (value) => encodeURIComponent(String(value ?? ""));
  return `https://expo.dev/accounts/${enc(owner)}/projects/${enc(slug)}/updates/${enc(group)}`;
}
