import { execFile, spawnSync } from "node:child_process";

const CALL_TIMEOUT_MS = 30000;
const ASYNC_MAX_BUFFER = 16 * 1024 * 1024;

// Runs a git command and never throws: a missing binary or a refusal is a result the caller decides about.
export function runGit({ args, cwd, env = process.env, timeoutMs = CALL_TIMEOUT_MS, spawnSyncImpl = spawnSync } = {}) {
  let result;
  try {
    result = spawnSyncImpl("git", args, { cwd, encoding: "utf8", timeout: timeoutMs, env });
  } catch (err) {
    return { ok: false, stdout: "", stderr: err?.message ?? String(err), missing: err?.code === "ENOENT" };
  }
  const failure = result?.error ?? null;
  return {
    ok: !failure && result?.status === 0,
    stdout: typeof result?.stdout === "string" ? result.stdout : "",
    stderr: typeof result?.stderr === "string" && result.stderr ? result.stderr : (failure?.message ?? ""),
    missing: failure?.code === "ENOENT",
  };
}

// The result shape of `runGit` for a finished asynchronous call, naming a timeout instead of the bare kill it caused.
function asyncResult(err, stdout, stderr, timeoutMs) {
  const timedOut = Boolean(err?.killed) && err?.signal !== null && err?.signal !== undefined;
  const reason = timedOut ? `git did not answer within ${timeoutMs} ms` : (err?.message ?? "");
  return {
    ok: !err,
    stdout: typeof stdout === "string" ? stdout : "",
    stderr: typeof stderr === "string" && stderr.trim() && !timedOut ? stderr : reason,
    missing: err?.code === "ENOENT",
  };
}

// Runs a git command without blocking the event loop and never rejects: a missing binary, a refusal or a timeout is a result.
export function runGitAsync({ args, cwd, env = process.env, timeoutMs = CALL_TIMEOUT_MS, execFileImpl = execFile } = {}) {
  return new Promise((done) => {
    try {
      execFileImpl("git", args, { cwd, env, encoding: "utf8", timeout: timeoutMs, maxBuffer: ASYNC_MAX_BUFFER }, (err, stdout, stderr) =>
        done(asyncResult(err, stdout, stderr, timeoutMs)),
      );
    } catch (err) {
      done({ ok: false, stdout: "", stderr: err?.message ?? String(err), missing: err?.code === "ENOENT" });
    }
  });
}
