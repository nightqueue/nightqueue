import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  RUNTIME_PACKAGE_TRAIL,
  SHIM_NAME,
  legacyShimPath,
  runtimePackageDir,
  shimNames,
  shimPath,
} from "../config/paths.mjs";
import { modeOf, writeFileAtomic } from "../config/store.mjs";
import { hostPackageRoot, packageRoot } from "./paths.mjs";

export const PACKAGE_NAME = "nightshift";

const SHIM_MODE = 0o755;

// Shape every shim this package ever wrote has: the CLI of a runtime prefix under some configuration home, the only proof that a file under the previous name is ours to delete.
const SHIM_SHAPE = new RegExp(
  `^#!/bin/sh\\nexec node "/.+/${RUNTIME_PACKAGE_TRAIL}/bin/(?:nightshift|shift)\\.mjs" "\\$@"\\n$`,
);

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
  return `#!/bin/sh\nexec node "${join(hostPackageRoot(env), "bin", "nightshift.mjs")}" "$@"\n`;
}

// Content of one file on disk, empty when it cannot be read.
function contentAt(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

// State of one shim on disk: whether it is there, whether it is the current one and whether it can be executed.
export function shimState(env = process.env, name = SHIM_NAME) {
  const path = shimPath(env, name);
  if (!existsSync(path)) return { path, name, present: false, current: false, executable: false };
  const mode = modeOf(path) ?? 0;
  return { path, name, present: true, current: contentAt(path) === shimContent(env), executable: (mode & 0o111) !== 0 };
}

// Writes one shim, executable, only when its content or its mode is not the wanted one.
export function writeShim(env = process.env, name = SHIM_NAME) {
  const state = shimState(env, name);
  if (state.present && state.current && state.executable) return { path: state.path, name, status: "already present" };
  mkdirSync(dirname(state.path), { recursive: true });
  writeFileAtomic(state.path, shimContent(env), { mode: SHIM_MODE });
  return { path: state.path, name, status: state.present ? "updated" : "created" };
}

// Deletes one shim, and only when the file on disk is the one this package wrote.
export function removeShim(env = process.env, name = SHIM_NAME) {
  const state = shimState(env, name);
  if (!state.present) return { path: state.path, name, status: "not present" };
  if (!state.current) return { path: state.path, name, status: "kept" };
  rmSync(state.path, { force: true });
  return { path: state.path, name, status: "removed" };
}

// Writes every shim the installation asks for, the canonical one first so no moment leaves the user without a command.
export function writeShims(env = process.env, { shortcuts } = {}) {
  return shimNames({ shortcuts }).map((name) => writeShim(env, name));
}

// Deletes every shim this package can write, whatever the installation once asked for.
export function removeShims(env = process.env) {
  return shimNames().map((name) => removeShim(env, name));
}

// State of the shim an older installation wrote under the previous command name; ownership is the shape, never the exact content.
export function legacyShimState(env = process.env) {
  const path = legacyShimPath(env);
  if (!existsSync(path)) return { path, present: false, own: false };
  return { path, present: true, own: SHIM_SHAPE.test(contentAt(path)) };
}

// Deletes the shim of the previous command name, and only when its shape proves this package wrote it.
export function removeLegacyShim(env = process.env) {
  const state = legacyShimState(env);
  if (!state.present) return { path: state.path, status: "not present" };
  if (!state.own) return { path: state.path, status: "kept" };
  rmSync(state.path, { force: true });
  return { path: state.path, status: "removed" };
}
