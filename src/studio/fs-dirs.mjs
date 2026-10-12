// The studio's folder browser: the directories under the operator's home, never a file's contents, never a step out of the home.
import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { UserError } from "../config/errors.mjs";
import { mainCheckoutOf, slugFromRemote, suggestName } from "../config/projects.mjs";
import { gitOutput } from "./git-read.mjs";
import { ApiRefusal } from "./integrations.mjs";

export const MAX_ENTRIES = 1000;

// The real path of the home the browser is bounded to.
export function userHome(env) {
  const raw = env?.HOME || homedir();
  try {
    return realpathSync(raw);
  } catch {
    throw new UserError(`the home directory ${raw} cannot be read`);
  }
}

// A requested path made absolute: `~` and `~/x` start at the home; anything else must already be absolute.
export function expandPath(raw, home) {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!text || text === "~") return home;
  const expanded = text.startsWith("~/") ? join(home, text.slice(2)) : text;
  if (!isAbsolute(expanded)) throw new UserError(`\`${text}\` is not an absolute path; start it with / or ~/`);
  return resolve(expanded);
}

// Tells whether a real path is the home or lies inside it.
function insideHome(real, home) {
  return real === home || real.startsWith(home.endsWith(sep) ? home : `${home}${sep}`);
}

// The real path of a requested directory inside the home: 403 outside it, 404 when missing, 422 when it is not a directory.
export function containedReal(raw, env) {
  const home = userHome(env);
  const asked = expandPath(raw, home);
  let real;
  try {
    real = realpathSync(asked);
  } catch {
    throw new ApiRefusal(404, `${asked} does not exist`, { code: "not-found" });
  }
  if (!insideHome(real, home)) throw new ApiRefusal(403, `${asked} is outside your home directory ${home}`, { code: "outside-home" });
  if (!statSync(real).isDirectory()) throw new ApiRefusal(422, `${asked} is not a directory`, { code: "not-a-directory" });
  return { home, real };
}

// The real directory a listed entry stands for, following a symlink only when it lands on a directory inside the home; null otherwise.
function entryDir(dir, dirent, home) {
  const path = join(dir, dirent.name);
  if (dirent.isDirectory()) return path;
  if (!dirent.isSymbolicLink()) return null;
  try {
    const real = realpathSync(path);
    return insideHome(real, home) && statSync(real).isDirectory() ? real : null;
  } catch {
    return null;
  }
}

// The registered project whose checkout is that path, as `{ id, name }`, or null.
function registeredAt(projects, path) {
  const found = projects.find((project) => project.path === path);
  return found ? { id: found.id, name: found.name } : null;
}

// Tells whether a path's `.git` is a file, the mark of a linked worktree.
function hasGitFile(path) {
  try {
    return statSync(join(path, ".git")).isFile();
  } catch {
    return false;
  }
}

// The main checkout a linked worktree belongs to, with its registered name, or null when the path is not a linked worktree.
function worktreeFacts(path, projects) {
  if (!hasGitFile(path)) return null;
  const main = mainCheckoutOf(path);
  if (main === path) return null;
  return { path: main, project: registeredAt(projects, main)?.name ?? null };
}

// One entry of a listing: its name and real path, whether it is a repository, and what the registry knows of it.
function entryOf(name, path, projects) {
  const entry = { name, path, git: existsSync(join(path, ".git")) };
  const registeredAs = registeredAt(projects, path);
  if (registeredAs) entry.registeredAs = registeredAs;
  const worktreeOf = entry.git ? worktreeFacts(path, projects) : null;
  if (worktreeOf) entry.worktreeOf = worktreeOf;
  return entry;
}

// The visible directories of a real directory, dotfolders and unreadable entries skipped, sorted without regard to case.
function visibleDirs(real, home) {
  const found = [];
  for (const dirent of readdirSync(real, { withFileTypes: true })) {
    if (dirent.name.startsWith(".")) continue;
    const path = entryDir(real, dirent, home);
    if (path) found.push({ name: dirent.name, path });
  }
  return found.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
}

// Lists the directories of one folder inside the home, at most 1000, with the git and registry facts of each.
export function listDirs({ path, env, projects = [] }) {
  const { home, real } = containedReal(path, env);
  let dirs;
  try {
    dirs = visibleDirs(real, home);
  } catch (err) {
    throw new ApiRefusal(403, `${real} cannot be read: ${err?.code ?? "unreadable"}`, { code: "unreadable" });
  }
  const known = Array.isArray(projects) ? projects : [];
  return {
    path: real,
    home,
    parent: real === home ? null : dirname(real),
    entries: dirs.slice(0, MAX_ENTRIES).map((dir) => entryOf(dir.name, dir.path, known)),
    truncated: dirs.length > MAX_ENTRIES,
  };
}

// The stdout of a git read trimmed, or null on any failure.
async function gitLine(cwd, args, env) {
  try {
    return (await gitOutput(cwd, args, env)).trim() || null;
  } catch {
    return null;
  }
}

// The origin `owner/repo` of a checkout, or null when it has none or git cannot tell.
export async function originOf(path, env) {
  const url = await gitLine(path, ["remote", "get-url", "origin"], env);
  return url ? slugFromRemote(url) : null;
}

// What registering a folder inside the home would do: its main checkout, registry facts, origin, branch and suggested name and key.
export async function repoFacts({ path, env, store }) {
  const { real } = containedReal(path, env);
  if (!existsSync(join(real, ".git"))) throw new ApiRefusal(422, `not a git repository (no .git): ${real}`, { code: "not-a-git-repo" });
  const projects = store ? await store.projects.list() : [];
  const mainCheckout = mainCheckoutOf(real);
  const name = suggestName(projects.map((project) => project.name), mainCheckout);
  return {
    path: real,
    mainCheckout,
    worktreeOf: mainCheckout === real ? null : { path: mainCheckout, project: registeredAt(projects, mainCheckout)?.name ?? null },
    registeredAs: registeredAt(projects, mainCheckout),
    origin: await originOf(mainCheckout, env),
    branch: await gitLine(mainCheckout, ["rev-parse", "--abbrev-ref", "HEAD"], env),
    suggested: { name, key: name && store ? await store.projects.suggestKey(name) : null },
  };
}
