import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { UserError } from "./errors.mjs";
import { defaultOrg, requireOrg } from "./orgs.mjs";
import { NAME_RE, assertName, normalizeName } from "./schema.mjs";

const REMOTE_RE = /^(?:[a-z][a-z0-9+.-]*:\/\/)?(?:[^/@]+@)?[^/:]+[/:]([^/]+)\/([^/]+)$/i;
const NAME_SUGGESTION_LIMIT = 99;

export const ALL_PROJECTS = "all";

// Refuses the name that targets every project of an org, so `all` never means a single project.
function requireUnreservedName(name) {
  if (name === ALL_PROJECTS) {
    throw new UserError(`project name \`${ALL_PROJECTS}\` is reserved: it targets every project of an org; pass --name <name>`);
  }
  return name;
}

// Resolves a path to the absolute, canonical form used in the config.
export function normalizePath(p) {
  const abs = resolve(p ?? ".");
  return existsSync(abs) ? realpathSync(abs) : abs;
}

// Derives the project name from the basename of the path, or null when the basename carries no valid name.
function deriveNameOrNull(abs) {
  const derived = normalizeName(basename(abs));
  return NAME_RE.test(derived) ? derived : null;
}

// Derives the project name from the basename of the path.
function deriveName(abs) {
  const derived = deriveNameOrNull(abs);
  if (derived === null) throw new UserError(`cannot derive a valid project name from ${abs}; pass --name <name>`);
  return derived;
}

// Resolves a path and requires it to be an existing git repository, the only gate a project has to pass.
export function requireGitPath(path) {
  const abs = normalizePath(path ?? ".");
  if (!existsSync(abs)) throw new UserError(`path does not exist: ${abs}`);
  if (!existsSync(join(abs, ".git"))) throw new UserError(`not a git repository (no .git): ${abs}`);
  return abs;
}

// Resolves a path only when it is an existing git repository, answering null instead of throwing when it is not.
export function gitPathOrNull(path) {
  const abs = normalizePath(path ?? ".");
  return existsSync(join(abs, ".git")) ? abs : null;
}

// Walks up from a directory to the root of the git repository containing it, answering null when there is none.
export function gitRootOrNull(path) {
  let current = normalizePath(path ?? ".");
  if (!existsSync(current)) return null;
  for (;;) {
    if (existsSync(join(current, ".git"))) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

// Tells whether a directory is the registered path itself or lies inside it.
function contains(path, target) {
  if (target === path) return true;
  return target.startsWith(path.endsWith(sep) ? path : `${path}${sep}`);
}

// The project whose checkout contains the directory, the longest path winning; a project without a path contains nothing.
export function projectContaining(projects, cwd) {
  const target = normalizePath(cwd ?? ".");
  let best = null;
  let bestLength = -1;
  for (const project of Array.isArray(projects) ? projects : []) {
    if (typeof project?.path !== "string" || !project.path) continue;
    const path = normalizePath(project.path);
    if (!contains(path, target) || path.length <= bestLength) continue;
    best = project;
    bestLength = path.length;
  }
  return best;
}

// First project name free for this path: the derived basename, then `-2`, `-3` ...; null when none is valid and free.
export function suggestName(takenNames, path) {
  const taken = new Set(takenNames);
  const base = deriveNameOrNull(normalizePath(path));
  if (base === null) return null;
  for (let suffix = 1; suffix <= NAME_SUGGESTION_LIMIT; suffix += 1) {
    const candidate = suffix === 1 ? base : `${base}-${suffix}`;
    if (!taken.has(candidate) && NAME_RE.test(candidate) && candidate !== ALL_PROJECTS) return candidate;
  }
  return null;
}

// The names of the registered projects, for a refusal that lists them.
async function knownProjects(store) {
  const names = (await store.projects.list()).map((project) => project.name);
  return names.length ? names.join(", ") : "(none)";
}

// The registered project with that name; an unknown one is refused, naming the known projects.
export async function requireProject(store, name) {
  const found = typeof name === "string" && name ? await store.projects.byName(name) : null;
  if (found) return found;
  throw new UserError(`unknown project \`${name ?? ""}\`; known projects: ${await knownProjects(store)}`);
}

// The project a roadmap-built job names, resolved at the edge: none, `all` (every project of an org item's org), or a registered NAME.
export async function roadmapQueueTarget(store, project) {
  const named = typeof project === "string" ? project.trim() : "";
  if (!named) return { projectId: null, allProjects: false };
  if (named === ALL_PROJECTS) return { projectId: null, allProjects: true };
  return { projectId: (await requireProject(store, named)).id, allProjects: false };
}

// Resolves a project reference: a registered name, or an absolute path inside a checkout, null (global) when it is inside none.
export async function resolveProjectRef(store, ref) {
  const raw = typeof ref === "string" ? ref.trim() : "";
  if (!raw) return null;
  const named = await store.projects.byName(raw);
  if (named) return named;
  if (isAbsolute(raw)) return await store.projects.at(raw);
  return await requireProject(store, raw);
}

// Repository the directory belongs to, with the free name and the org it would be registered under; null when the directory is inside no repository.
export async function registrationOffer(store, config, cwd) {
  const root = gitRootOrNull(cwd);
  if (root === null) return null;
  const name = suggestName((await store.projects.list()).map((project) => project.name), root);
  if (name === null) {
    throw new UserError(`cannot derive a free project name for ${root}; register it with \`nightqueue project add ${root} --name <name>\``);
  }
  return { path: root, name, org: (await defaultOrg(store, config)).name };
}

// The refusal of a name another project already holds, pointing a path-less one at `project move --path`.
function takenNameError(taken, abs) {
  if (taken.path) return new UserError(`project name \`${taken.name}\` is already registered for ${taken.path}`);
  return new UserError(
    `project name \`${taken.name}\` is already known without a checkout; give it this one with \`nightqueue project move ${taken.name} --path ${abs}\``,
  );
}

// Registers a git repository as a project of an org (the default org when none is named) and answers what happened.
export async function registerProject(store, config, { path, name, org } = {}) {
  const abs = requireGitPath(path);
  const target = typeof org === "string" && org ? await requireOrg(store, org) : await defaultOrg(store, config);
  const projectName = requireUnreservedName(name === undefined ? deriveName(abs) : assertName("project", name));
  const registered = (await store.projects.list()).find((project) => project.path === abs);
  if (registered) {
    if (registered.org_id === target.id) return { status: "unchanged", project: registered };
    throw new UserError(
      `${abs} is already registered as \`${registered.name}\` in org \`${registered.org}\`; use \`nightqueue project move ${registered.name} ${target.name}\``,
    );
  }
  const taken = await store.projects.byName(projectName);
  if (taken) throw takenNameError(taken, abs);
  return { status: "created", project: await store.projects.add({ name: projectName, path: abs, orgId: target.id }) };
}

// Renames a project: one registry row, so every job, decision, roadmap item and memory keyed by its id follows it.
export async function renameProject(store, oldName, newName) {
  const project = await requireProject(store, oldName);
  assertName("project", newName);
  if (newName === ALL_PROJECTS) throw new UserError(`project name \`${ALL_PROJECTS}\` is reserved: it targets every project of an org`);
  if (oldName === newName) throw new UserError(`project \`${oldName}\` already has that name`);
  return await store.projects.rename(project.id, newName);
}

// Extracts lowercase `owner/repo` from a git remote URL.
export function slugFromRemote(url) {
  const trimmed = String(url ?? "")
    .trim()
    .replace(/\.git$/i, "")
    .replace(/\/+$/, "");
  if (!trimmed) return null;
  const match = REMOTE_RE.exec(trimmed);
  return match ? `${match[1].toLowerCase()}/${match[2].toLowerCase()}` : null;
}

// Reads the origin remote URL of a directory.
function defaultGitRemote(cwd) {
  return execFileSync("git", ["-C", cwd, "remote", "get-url", "origin"], {
    encoding: "utf8",
    timeout: 3000,
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

// Returns `owner/repo` of the project, or null when there is no origin nor usable git.
export function repoSlugOf(project, { gitRemoteImpl = defaultGitRemote } = {}) {
  if (!project?.path) return null;
  try {
    return slugFromRemote(gitRemoteImpl(project.path));
  } catch {
    return null;
  }
}
