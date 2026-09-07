import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { runtimePackageDir, shimPath } from "../config/paths.mjs";
import { modeOf, writeFileAtomic } from "../config/store.mjs";
import { hostPackageRoot, packageRoot } from "./paths.mjs";

export const PACKAGE_NAME = "nightshift";

const SHIM_MODE = 0o755;

// Version declared by one package.json, or null when the file is missing or unreadable.
function versionAt(dir) {
  try {
    const data = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    return typeof data?.version === "string" ? data.version : null;
  } catch {
    return null;
  }
}

// Version of the package this process runs from.
export function packageVersion() {
  return versionAt(packageRoot());
}

// Version installed in the runtime prefix, or null when no runtime is there.
export function runtimeVersion(env = process.env) {
  return versionAt(runtimePackageDir(env));
}

// Tells whether the runtime prefix really holds the package, which is the only proof that an install worked.
export function runtimeReady(env = process.env) {
  return existsSync(join(runtimePackageDir(env), "package.json"));
}

// Specifier npm installs from: a local checkout when `--from` was given, the registry otherwise.
export function runtimeSpec({ from, version } = {}) {
  if (typeof from === "string" && from.trim()) return resolve(from.trim());
  return `${PACKAGE_NAME}@${version || "latest"}`;
}

// Content of the shim: a POSIX script that starts the CLI of the runtime, quoted so a space in the path survives.
export function shimContent(env = process.env) {
  return `#!/bin/sh\nexec node "${join(hostPackageRoot(env), "bin", "shift.mjs")}" "$@"\n`;
}

// State of the shim on disk: whether it is there, whether it is the current one and whether it can be executed.
export function shimState(env = process.env) {
  const path = shimPath(env);
  if (!existsSync(path)) return { path, present: false, current: false, executable: false };
  let content = "";
  try {
    content = readFileSync(path, "utf8");
  } catch {
    content = "";
  }
  const mode = modeOf(path) ?? 0;
  return { path, present: true, current: content === shimContent(env), executable: (mode & 0o111) !== 0 };
}

// Writes the shim, executable, only when its content or its mode is not the wanted one.
export function writeShim(env = process.env) {
  const state = shimState(env);
  if (state.present && state.current && state.executable) return { path: state.path, status: "already present" };
  mkdirSync(dirname(state.path), { recursive: true });
  writeFileAtomic(state.path, shimContent(env), { mode: SHIM_MODE });
  return { path: state.path, status: state.present ? "updated" : "created" };
}

// Deletes the shim, and only when the file on disk is the one this package wrote.
export function removeShim(env = process.env) {
  const state = shimState(env);
  if (!state.present) return { path: state.path, status: "not present" };
  if (!state.current) return { path: state.path, status: "kept" };
  rmSync(state.path, { force: true });
  return { path: state.path, status: "removed" };
}
