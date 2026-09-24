import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { UserError } from "./errors.mjs";
import { requireOrg } from "./orgs.mjs";
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

// Returns the project entry with the given name.
export function projectByName(config, name) {
  const entry = config?.projects?.[name];
  return entry ? { name, path: entry.path, org: entry.org } : null;
}

// Returns the org of a project entry.
export function orgOf(project) {
  return project?.org ?? null;
}

// Names of the projects registered under an org, in config order.
export function projectsOfOrg(config, org) {
  return Object.entries(config?.projects ?? {})
    .filter(([, entry]) => entry.org === org)
    .map(([name]) => name);
}

// Lists the registered projects, marking whether the path still exists.
export function listProjects(config) {
  return Object.entries(config.projects).map(([name, entry]) => ({
    name,
    path: entry.path,
    org: entry.org,
    exists: existsSync(entry.path),
  }));
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

// First project name free in the config for this path: the derived basename, then `-2`, `-3` ...; null when none is valid and free.
export function suggestName(config, path) {
  const base = deriveNameOrNull(normalizePath(path));
  if (base === null) return null;
  for (let suffix = 1; suffix <= NAME_SUGGESTION_LIMIT; suffix += 1) {
    const candidate = suffix === 1 ? base : `${base}-${suffix}`;
    if (config.projects[candidate] === undefined && NAME_RE.test(candidate) && candidate !== ALL_PROJECTS) return candidate;
  }
  return null;
}

// Repository the directory belongs to, with the free name and the org it would be registered under; null when the directory is inside no repository.
export function registrationOffer(config, cwd) {
  const root = gitRootOrNull(cwd);
  if (root === null) return null;
  const name = suggestName(config, root);
  if (name === null) {
    throw new UserError(`cannot derive a free project name for ${root}; register it with \`nightshift project add ${root} --name <name>\``);
  }
  return { path: root, name, org: config.defaultOrg };
}

// Registers a git repository as a project of an org.
export function addProject(config, { path, name, org } = {}) {
  const abs = requireGitPath(path);
  const orgName = org ?? config.defaultOrg;
  requireOrg(config, orgName);
  const projectName = requireUnreservedName(name === undefined ? deriveName(abs) : assertName("project", name));
  const registered = Object.entries(config.projects).find(([, entry]) => entry.path === abs);
  if (registered) {
    const [existingName, entry] = registered;
    if (entry.org === orgName) {
      return { config, status: "unchanged", project: { name: existingName, path: entry.path, org: entry.org } };
    }
    throw new UserError(
      `${abs} is already registered as \`${existingName}\` in org \`${entry.org}\`; use \`nightshift project move ${existingName} ${orgName}\``,
    );
  }
  const taken = config.projects[projectName];
  if (taken) throw new UserError(`project name \`${projectName}\` is already registered for ${taken.path}`);
  config.projects[projectName] = { path: abs, org: orgName };
  return { config, status: "created", project: { name: projectName, path: abs, org: orgName } };
}

// Removes a registered project.
export function removeProject(config, name) {
  if (!config.projects[name]) throw new UserError(`unknown project \`${name}\``);
  delete config.projects[name];
  return config;
}

// Moves a project to another existing org.
export function moveProject(config, name, org) {
  const entry = config.projects[name];
  if (!entry) throw new UserError(`unknown project \`${name}\``);
  requireOrg(config, org);
  if (entry.org === org) return { config, status: "unchanged" };
  entry.org = org;
  return { config, status: "moved" };
}

// Tells whether a directory is the registered path itself or lies inside it.
function contains(path, target) {
  if (target === path) return true;
  return target.startsWith(path.endsWith(sep) ? path : `${path}${sep}`);
}

// Resolves the project containing the given directory, choosing the longest prefix.
export function resolveProject(config, { cwd } = {}) {
  const target = normalizePath(cwd ?? ".");
  let best = null;
  let bestLength = -1;
  for (const [name, entry] of Object.entries(config.projects)) {
    const path = normalizePath(entry.path);
    if (!contains(path, target) || path.length <= bestLength) continue;
    best = { name, path: entry.path, org: entry.org };
    bestLength = path.length;
  }
  return best;
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
