import { spawnSync } from "node:child_process";
import { join } from "node:path";

const INSTALL_TIMEOUT_MS = 600000;
const REGISTRY_TIMEOUT_MS = 15000;

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

// Arguments of an installation into an isolated prefix, quiet, without development dependencies and without the audit npm would run on its own.
export function npmInstallArgs(prefix, spec) {
  return ["install", "--prefix", prefix, "--omit=dev", "--no-audit", "--no-fund", "--loglevel", "error", spec];
}

// Installs one package specifier into an isolated prefix, returning the result plus the command line to retry by hand.
export function npmInstall({ prefix, spec, env = process.env, spawnSyncImpl = spawnSync, timeoutMs } = {}) {
  const args = npmInstallArgs(prefix, spec);
  return { ...runNpm(args, { env, spawnSyncImpl, timeoutMs }), command: npmCommandLine(args, env) };
}

// Arguments of a read of one field of one specifier in the registry.
export function npmViewArgs(spec) {
  return ["view", spec, "version", "--json"];
}

// Version one `npm view ... --json` call reported, or null when its output is neither the string nor the array npm documents.
function viewedVersion(stdout) {
  try {
    const data = JSON.parse(stdout);
    const version = Array.isArray(data) ? data.at(-1) : data;
    return typeof version === "string" && version ? version : null;
  } catch {
    return null;
  }
}

// Reads the published version of one specifier, the only call in this package that asks the registry a question; unreadable output is a declared failure, never a silent fallback.
export function npmView({ spec, env = process.env, spawnSyncImpl = spawnSync, timeoutMs = REGISTRY_TIMEOUT_MS } = {}) {
  const args = npmViewArgs(spec);
  const result = runNpm(args, { env, spawnSyncImpl, timeoutMs });
  const command = npmCommandLine(args, env);
  if (!result.ok) return { ...result, version: null, command };
  const version = viewedVersion(result.stdout);
  if (!version) return { ...result, ok: false, version: null, command, stderr: `npm view printed no version for ${spec}` };
  return { ...result, version, command };
}

// Arguments of a pack of one directory into a chosen destination, never running the lifecycle scripts of the packed package.
export function npmPackArgs(dir, destDir) {
  return ["pack", "--json", "--pack-destination", destDir, "--ignore-scripts", dir];
}

// Name of the tarball one `npm pack --json` call reported, or null when its output is not the array npm documents.
function packedFilename(stdout) {
  try {
    const filename = JSON.parse(stdout)?.[0]?.filename;
    return typeof filename === "string" && filename ? filename : null;
  } catch {
    return null;
  }
}

// Packs one directory into a tarball, returning its path plus the command line to retry by hand; unreadable output is a declared failure, never a silent fallback.
export function npmPack({ dir, destDir, env = process.env, spawnSyncImpl = spawnSync, timeoutMs } = {}) {
  const args = npmPackArgs(dir, destDir);
  const result = runNpm(args, { env, spawnSyncImpl, timeoutMs });
  const command = npmCommandLine(args, env);
  if (!result.ok) return { ...result, file: null, command };
  const filename = packedFilename(result.stdout);
  if (!filename) return { ...result, ok: false, file: null, command, stderr: `npm pack printed no tarball name for ${dir}` };
  return { ...result, file: join(destDir, filename), command };
}
