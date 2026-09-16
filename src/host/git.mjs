import { spawnSync } from "node:child_process";

const CALL_TIMEOUT_MS = 30000;

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
