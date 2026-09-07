import { spawnSync } from "node:child_process";

const INSTALL_TIMEOUT_MS = 600000;

// Path of the npm CLI, injectable so a test never reaches the real package manager.
export function npmBin(env = process.env) {
  const raw = typeof env?.NIGHTSHIFT_NPM_BIN === "string" ? env.NIGHTSHIFT_NPM_BIN.trim() : "";
  return raw || "npm";
}

// Command line a human can copy and paste when a step has to be finished by hand.
export function npmCommandLine(args, env = process.env) {
  return [npmBin(env), ...args].join(" ");
}

// Runs the npm CLI and never throws: a missing binary or a failure is a result the caller decides about.
export function runNpm(args, { env = process.env, spawnSyncImpl = spawnSync, timeoutMs = INSTALL_TIMEOUT_MS } = {}) {
  let result;
  try {
    result = spawnSyncImpl(npmBin(env), args, { encoding: "utf8", timeout: timeoutMs, env });
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

// Arguments of an installation into an isolated prefix, quiet and without the audit npm would run on its own.
export function npmInstallArgs(prefix, spec) {
  return ["install", "--prefix", prefix, "--no-audit", "--no-fund", "--loglevel", "error", spec];
}

// Installs one package specifier into an isolated prefix, returning the result plus the command line to retry by hand.
export function npmInstall({ prefix, spec, env = process.env, spawnSyncImpl = spawnSync, timeoutMs } = {}) {
  const args = npmInstallArgs(prefix, spec);
  return { ...runNpm(args, { env, spawnSyncImpl, timeoutMs }), command: npmCommandLine(args, env) };
}
