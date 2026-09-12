import { mkdirSync, readdirSync, realpathSync, renameSync, rmSync, statSync, symlinkSync } from "node:fs";
import { basename, dirname, join, sep } from "node:path";
import { resolvedRuntimeDir, runtimeCurrentLink, runtimeDir, runtimeVersionsDir } from "../config/paths.mjs";
import { liveRunnersReport } from "../queue/registry.mjs";

const STAGING_PREFIX = ".staging-";
const KEEP_VERSIONS = 2;
const MAX_NAME_TRIES = 50;

// Compact UTC stamp that makes the directory of one install unique, the same shape the runner log stamps carry.
export function versionStamp(now = new Date()) {
  return now.toISOString().replaceAll("-", "").replaceAll(":", "").replace(/\.\d+Z$/, "Z");
}

// Creates the empty npm prefix one install writes into, a sibling of the version directories it is about to become.
export function stageInstall(env, stamp) {
  const dir = join(runtimeVersionsDir(env), `${STAGING_PREFIX}${stamp}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  return dir;
}

// Name no version directory holds yet, so a second install inside the same second never overwrites a tree a process may be running.
function freeVersionDir(versions, base) {
  for (let attempt = 0; attempt < MAX_NAME_TRIES; attempt += 1) {
    const dir = join(versions, attempt === 0 ? base : `${base}.${attempt}`);
    if (!statSync(dir, { throwIfNoEntry: false })) return dir;
  }
  throw new Error(`no free version directory for \`${base}\` in ${versions}; remove the old ones by hand`);
}

// Turns the finished staging prefix into the version directory the `current` link will name, a rename inside one directory.
export function finishVersion(stagingDir, version, stamp) {
  const dir = freeVersionDir(dirname(stagingDir), `${version}-${stamp}`);
  renameSync(stagingDir, dir);
  return dir;
}

// Points `current` at one version directory in a single rename, so no instant leaves the host without a runtime.
export function switchCurrent(versionDir, env) {
  const link = runtimeCurrentLink(env);
  const pending = `${link}.tmp-${basename(versionDir)}`;
  rmSync(pending, { recursive: true, force: true });
  symlinkSync(join("versions", basename(versionDir)), pending);
  renameSync(pending, link);
  return link;
}

// Real path of one directory, or null when it is not there: the only way two paths of the same tree compare equal.
function realOrNull(path) {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

// Every runtime directory a live runner recorded it loaded from, or `unknown` when the registry could not be read at all: an install may delete none of them.
function liveRunnerRuntimeDirs(env) {
  try {
    const { runners, error } = liveRunnersReport(env);
    if (error !== null) return { dirs: new Set(), unknown: error };
    const dirs = runners
      .map((runner) => (typeof runner.runtimeDir === "string" && runner.runtimeDir ? realOrNull(runner.runtimeDir) : null))
      .filter(Boolean);
    return { dirs: new Set(dirs), unknown: null };
  } catch (err) {
    return { dirs: new Set(), unknown: err?.message ?? String(err) };
  }
}

// Version directories on disk, newest first, staging prefixes left out.
function versionDirs(env) {
  const versions = runtimeVersionsDir(env);
  return readdirSync(versions, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith(STAGING_PREFIX))
    .map((entry) => join(versions, entry.name))
    .map((dir) => ({ dir, mtimeMs: statSync(dir, { throwIfNoEntry: false })?.mtimeMs ?? 0 }))
    .sort((left, right) => right.mtimeMs - left.mtimeMs)
    .map((entry) => entry.dir);
}

// Deletes the version directories nobody needs any more, never the one `current` names nor any one a live runner runs from;
// a registry that could not be read proves nothing unprotected, so it deletes nothing at all.
export function pruneVersions(env, { keep = KEEP_VERSIONS } = {}) {
  const live = liveRunnerRuntimeDirs(env);
  if (live.unknown !== null) return [];
  const protectedDirs = new Set([resolvedRuntimeDir(env), ...live.dirs].filter(Boolean));
  const removed = [];
  let kept = 0;
  for (const dir of versionDirs(env)) {
    if (kept < keep || protectedDirs.has(realOrNull(dir))) {
      kept += 1;
      continue;
    }
    rmSync(dir, { recursive: true, force: true });
    removed.push(dir);
  }
  return removed;
}

// How the tree a runner loaded from is named in a report: the version directory alone when it is one of this home's, the whole path otherwise.
export function runtimeLabel(dir, env = process.env) {
  if (typeof dir !== "string" || !dir) return null;
  const versions = `${runtimeVersionsDir(env)}${sep}`;
  return dir.startsWith(versions) ? dir.slice(versions.length).split(sep)[0] : dir;
}

// How the installed runtime is named in a report: the link and the version directory it resolves to, or the prefix alone while nothing is linked.
export function runtimeLocation(env = process.env) {
  const resolved = resolvedRuntimeDir(env);
  return resolved ? `${runtimeCurrentLink(env)} -> ${resolved}` : runtimeDir(env);
}
