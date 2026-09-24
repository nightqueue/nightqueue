import { spawnSync } from "node:child_process";

const CALL_TIMEOUT_MS = 20000;

// Path of the claude CLI, the same resolver the reflection uses.
export function claudeBin(env = process.env) {
  const raw = typeof env?.NIGHTQUEUE_CLAUDE_BIN === "string" ? env.NIGHTQUEUE_CLAUDE_BIN.trim() : "";
  return raw || "claude";
}

// Command line a human can copy and paste when a step has to be finished by hand.
export function claudeCommandLine(args, env = process.env) {
  return [claudeBin(env), ...args].join(" ");
}

// Runs the claude CLI and never throws: a missing binary or a failure is a result the caller decides about.
export function runClaude(args, { env = process.env, spawnSyncImpl = spawnSync } = {}) {
  let result;
  try {
    result = spawnSyncImpl(claudeBin(env), args, { encoding: "utf8", timeout: CALL_TIMEOUT_MS, env });
  } catch (err) {
    return { ok: false, status: null, stdout: "", stderr: err?.message ?? String(err), missing: err?.code === "ENOENT" };
  }
  const failure = result?.error ?? null;
  return {
    ok: !failure && result?.status === 0,
    status: typeof result?.status === "number" ? result.status : null,
    stdout: typeof result?.stdout === "string" ? result.stdout : "",
    stderr: typeof result?.stderr === "string" && result.stderr ? result.stderr : (failure?.message ?? ""),
    missing: failure?.code === "ENOENT",
  };
}
