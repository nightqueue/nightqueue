import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmdirSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { UserError } from "../config/errors.mjs";
import { idTime, isId, newId } from "../config/ids.mjs";
import { qaDir, qaWorktreePath } from "../config/paths.mjs";
import { killProcess } from "./registry.mjs";
import { WORKTREE_REMOVE_TIMEOUT_MS, canonicalPath, lockPid, lockState, parseWorktreeList } from "./worktree.mjs";

export const QA_WORKTREE_TTL_MS = 6 * 3600 * 1000;
export const QA_LOCK_PREFIX = "nightqueue qa";

const OWNER_STATES = { none: "none", live: "live", stale: "gone", manual: "manual" };

// The canonical form of a path whose tail may not exist yet: the existing part resolved, the rest appended as written.
function canonicalLoose(path) {
  const absolute = resolve(path);
  if (existsSync(absolute) || dirname(absolute) === absolute) return canonicalPath(absolute);
  return join(canonicalLoose(dirname(absolute)), basename(absolute));
}

// The `{ projectId, id, path }` of a path that is exactly a qa worktree root `<qa>/<project id>/<id>` of this home, or null.
export function qaWorktreeTarget(path, env = process.env) {
  if (typeof path !== "string" || !isAbsolute(path)) return null;
  const root = canonicalLoose(qaDir(env));
  const rest = relative(root, canonicalLoose(path));
  const parts = isAbsolute(rest) ? [] : rest.split(sep);
  if (parts.length !== 2 || !isId(parts[0]) || !isId(parts[1])) return null;
  return { projectId: parts[0], id: parts[1], path: join(root, parts[0], parts[1]) };
}

// The pid of the operator session this process belongs to, or null when none is recorded.
function operatorPid(env) {
  const pid = Number(env?.NIGHTQUEUE_OPERATOR_PID);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

// A git runner bound to an environment and a spawn seam: `(args, cwd) => { ok, stdout, stderr }`, never throwing.
function gitRunner({ env, spawnSyncImpl = spawnSync }) {
  return (args, cwd) => {
    try {
      const result = spawnSyncImpl("git", args, { cwd, env, encoding: "utf8", timeout: WORKTREE_REMOVE_TIMEOUT_MS });
      const stderr = typeof result?.stderr === "string" ? result.stderr : "";
      return { ok: !result?.error && result?.status === 0, stdout: typeof result?.stdout === "string" ? result.stdout : "", stderr: stderr || result?.error?.message || "" };
    } catch (err) {
      return { ok: false, stdout: "", stderr: err?.message ?? String(err) };
    }
  };
}

// First line of a git message, short enough for an error or a report line.
function firstLine(text, fallback) {
  return String(text ?? "").trim().split("\n")[0].slice(0, 200) || fallback;
}

// The linked worktree entries of a checkout as git lists them; throws a UserError when git cannot list them.
function linkedEntries(git, checkout) {
  const listed = git(["worktree", "list", "--porcelain"], checkout);
  if (!listed.ok) throw new UserError(`git could not list the worktrees of ${checkout}: ${firstLine(listed.stderr, "git worktree list failed")}`);
  return parseWorktreeList(listed.stdout).slice(1);
}

// The entry git registers for a path among the linked worktrees of a checkout, or null.
function entryAt(entries, path) {
  const target = canonicalLoose(path);
  return entries.find((entry) => canonicalLoose(entry.path) === target) ?? null;
}

// The git entry of a qa worktree in its checkout, or null when git does not register it; throws when git cannot list.
export function qaWorktreeEntry({ path, checkout, env = process.env, spawnSyncImpl = spawnSync }) {
  return entryAt(linkedEntries(gitRunner({ env, spawnSyncImpl }), checkout), path);
}

// Throws when a live operator session other than this one holds the qa worktree's lock, so one session never drops another's.
export function refuseForeignOwner({ path, checkout, env = process.env, spawnSyncImpl = spawnSync, killImpl = killProcess }) {
  const entry = qaWorktreeEntry({ path, checkout, env, spawnSyncImpl });
  if (!entry || lockState(entry, killImpl) !== "live") return;
  const owner = lockPid(entry.locked);
  if (owner === operatorPid(env)) return;
  throw new UserError(
    `refused: ${path} is locked by the live operator session pid ${owner}; that session drops it, or \`nightqueue doctor --fix\` does once it ended`,
  );
}

// Removes a directory only when it holds nothing, never throwing.
function removeIfEmpty(dir) {
  try {
    if (readdirSync(dir).length === 0) rmdirSync(dir);
  } catch {
    return;
  }
}

// Removes what a failed creation left: the worktree git may have registered, its admin entry, and an empty directory.
function discardCreated(git, { path, checkout }) {
  git(["worktree", "remove", "--force", path], checkout);
  git(["worktree", "prune"], checkout);
  removeIfEmpty(path);
}

// Creates a detached QA worktree of the project's HEAD under `<qa>/<project id>/<id>`, locked to the operator session when one is recorded; returns its path.
export function createQaWorktree({ project, env = process.env, spawnSyncImpl = spawnSync, now = Date.now() }) {
  if (!project?.id || typeof project.path !== "string" || !existsSync(project.path)) {
    throw new UserError(`the checkout of \`${project?.name ?? "?"}\` is not on disk; a qa worktree needs it`);
  }
  const git = gitRunner({ env, spawnSyncImpl });
  const path = qaWorktreePath(project.id, newId(now), env);
  mkdirSync(dirname(path), { recursive: true });
  const added = git(["worktree", "add", "--detach", path, "HEAD"], project.path);
  if (!added.ok) {
    discardCreated(git, { path, checkout: project.path });
    throw new UserError(`git worktree add failed in ${project.path}: ${firstLine(added.stderr, "no reason given")}`);
  }
  lockToSession(git, { path, checkout: project.path, pid: operatorPid(env) });
  return path;
}

// Locks a new worktree with the operator session's pid as its owner; a failed lock discards the worktree and throws.
function lockToSession(git, { path, checkout, pid }) {
  if (pid === null) return;
  const locked = git(["worktree", "lock", "--reason", `${QA_LOCK_PREFIX} (pid ${pid})`, path], checkout);
  if (locked.ok) return;
  discardCreated(git, { path, checkout });
  throw new UserError(`git worktree lock failed in ${checkout}: ${firstLine(locked.stderr, "no reason given")}`);
}

// Drops a qa worktree from its checkout (unlock, forced remove, prune) and an empty leftover directory; `gone` when there was nothing to drop.
export function dropQaWorktree({ path, checkout, env = process.env, spawnSyncImpl = spawnSync }) {
  const target = qaWorktreeTarget(path, env);
  if (!target) throw new UserError(`refused: ${path} is not a qa worktree of this home (${join(qaDir(env), "<project id>", "<id>")})`);
  const git = gitRunner({ env, spawnSyncImpl });
  const entry = entryAt(linkedEntries(git, checkout), target.path);
  if (!entry && !existsSync(target.path)) return { dropped: false, reason: "gone" };
  if (entry) removeRegistered(git, { path: entry.path, checkout });
  if (existsSync(target.path)) removeUnregistered(target.path);
  return { dropped: true, reason: null };
}

// Unlocks, force-removes and prunes one registered worktree; throws when its directory is still there afterwards.
function removeRegistered(git, { path, checkout }) {
  git(["worktree", "unlock", path], checkout);
  const removed = existsSync(path) ? git(["worktree", "remove", "--force", path], checkout) : { ok: true };
  git(["worktree", "prune"], checkout);
  if (!removed.ok && existsSync(path)) throw new UserError(`git worktree remove failed for ${path}: ${firstLine(removed.stderr, "no reason given")}`);
}

// Removes a directory git does not register only when it is empty; throws otherwise, so nothing unknown is ever deleted.
function removeUnregistered(dir) {
  removeIfEmpty(dir);
  if (existsSync(dir)) throw new UserError(`${dir} is not a registered worktree and is not empty; inspect it by hand`);
}

// The directory entries of a directory as `{ name, path, isDir }`, or none when it cannot be read.
function childrenOf(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true }).map((dirent) => ({ name: dirent.name, path: join(dir, dirent.name), isDir: dirent.isDirectory() }));
  } catch {
    return [];
  }
}

// The age, owner and staleness of one registered qa worktree entry.
function judgeEntry(entry, { id, now, killImpl }) {
  const born = idTime(id);
  const ageMs = Number.isFinite(born) ? Math.max(0, now - born) : 0;
  const ownerState = OWNER_STATES[lockState(entry, killImpl)] ?? "manual";
  const stale = ownerState !== "manual" && (ageMs > QA_WORKTREE_TTL_MS || ownerState === "gone");
  return { ageMs, owner: lockPid(entry.locked), ownerState, locked: entry.locked, stale };
}

// A row for something under the qa root that is not a qa worktree; it is only ever reported.
function foreignRow(path, project, reason) {
  return { path, project, id: null, foreign: true, registered: false, missing: false, stale: false, reason };
}

// The row of one directory under a project's qa directory.
function directoryRow(child, { project, entries, now, killImpl }) {
  if (!child.isDir || !isId(child.name)) return foreignRow(child.path, project, "not a qa worktree (not an id-named directory)");
  const entry = entryAt(entries, child.path);
  if (!entry) return foreignRow(child.path, project, "not a qa worktree (git does not register it)");
  return { path: child.path, project, id: child.name, foreign: false, registered: true, missing: false, reason: null, ...judgeEntry(entry, { id: child.name, now, killImpl }) };
}

// The rows of the entries git registers under a project's qa directory whose directory is gone.
function missingRows(entries, { project, env }) {
  return entries
    .filter((entry) => !existsSync(entry.path))
    .map((entry) => ({ entry, target: qaWorktreeTarget(entry.path, env) }))
    .filter(({ target }) => target?.projectId === project.id)
    .map(({ entry, target }) => ({ path: entry.path, project, id: target.id, foreign: false, registered: true, missing: true, stale: true, reason: "its directory is gone", owner: lockPid(entry.locked), ownerState: "none", locked: entry.locked, ageMs: null }));
}

// The rows of one project's qa directory, or one foreign row when git cannot list the checkout's worktrees.
function projectRows({ root, project, env, git, now, killImpl }) {
  let entries;
  try {
    entries = linkedEntries(git, project.path);
  } catch (err) {
    return [foreignRow(root, project, err.message)];
  }
  const rows = childrenOf(root).map((child) => directoryRow(child, { project, entries, now, killImpl }));
  return [...rows, ...missingRows(entries, { project, env })];
}

// One row per entry under `<qa>/<project id>/`: the qa worktrees with age, owner and staleness, and what is not one, never throwing.
export function listQaWorktrees({ env = process.env, projects = [], spawnSyncImpl = spawnSync, killImpl = killProcess, now = Date.now() } = {}) {
  const git = gitRunner({ env, spawnSyncImpl });
  const byId = new Map((Array.isArray(projects) ? projects : []).filter((project) => project?.path && existsSync(project.path)).map((project) => [project.id, project]));
  return childrenOf(qaDir(env)).flatMap((child) => {
    const project = byId.get(child.name) ?? null;
    if (!project || !child.isDir) return [foreignRow(child.path, null, "no registered project with a checkout has this id")];
    return projectRows({ root: child.path, project, env, git, now, killImpl });
  });
}

// Tells whether a stale row is still stale against its git entry read again, so a drop acts only on the exact state it judged.
function stillStale(row, entry, { now, killImpl }) {
  if (entry.locked !== row.locked) return false;
  return row.missing ? !existsSync(row.path) : judgeEntry(entry, { id: row.id, now, killImpl }).stale;
}

// Drops one stale row after reading its entry again: `dropped` (a missing one an earlier prune already took counts), `kept` (its state changed) or `failed` with the reason.
function sweepRow(row, options) {
  try {
    const entry = qaWorktreeEntry({ path: row.path, checkout: row.project.path, env: options.env, spawnSyncImpl: options.spawnSyncImpl });
    if (!entry) return { outcome: row.missing ? "dropped" : "kept" };
    if (!stillStale(row, entry, options)) return { outcome: "kept" };
    dropQaWorktree({ path: row.path, checkout: row.project.path, env: options.env, spawnSyncImpl: options.spawnSyncImpl });
    return { outcome: "dropped" };
  } catch (err) {
    return { outcome: "failed", reason: err?.message ?? String(err) };
  }
}

// Drops the stale qa worktrees (older than the TTL or whose session is gone) and the entries whose directory is gone; never throws.
export function sweepQaWorktrees({ env = process.env, projects = [], spawnSyncImpl = spawnSync, killImpl = killProcess, now = Date.now() } = {}) {
  const result = { dropped: [], kept: [], failed: [] };
  const options = { env, spawnSyncImpl, killImpl, now };
  try {
    for (const row of listQaWorktrees({ ...options, projects })) {
      const swept = row.stale ? sweepRow(row, options) : { outcome: "kept" };
      if (swept.outcome === "failed") result.failed.push({ row, reason: swept.reason });
      else result[swept.outcome].push(row);
    }
  } catch (err) {
    result.failed.push({ row: null, reason: err?.message ?? String(err) });
  }
  return result;
}
