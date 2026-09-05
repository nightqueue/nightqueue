import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import { UserError } from "./errors.mjs";
import { requireOrg } from "./orgs.mjs";
import { NAME_RE, assertName, normalizeName } from "./schema.mjs";

const REMOTE_RE = /^(?:[a-z][a-z0-9+.-]*:\/\/)?(?:[^/@]+@)?[^/:]+[/:]([^/]+)\/([^/]+)$/i;

// Resolve um path para a forma absoluta e canonica usada na config.
export function normalizePath(p) {
  const abs = resolve(p ?? ".");
  return existsSync(abs) ? realpathSync(abs) : abs;
}

// Devolve a entrada de projeto com o nome informado.
export function projectByName(config, name) {
  const entry = config?.projects?.[name];
  return entry ? { name, path: entry.path, org: entry.org } : null;
}

// Devolve a org de uma entrada de projeto.
export function orgOf(project) {
  return project?.org ?? null;
}

// Lista os projetos registrados, marcando se o path ainda existe.
export function listProjects(config) {
  return Object.entries(config.projects).map(([name, entry]) => ({
    name,
    path: entry.path,
    org: entry.org,
    exists: existsSync(entry.path),
  }));
}

// Deriva o nome do projeto a partir do basename do path.
function deriveName(abs) {
  const derived = normalizeName(basename(abs));
  if (!NAME_RE.test(derived)) throw new UserError(`cannot derive a valid project name from ${abs}; pass --name <name>`);
  return derived;
}

// Registra um repositorio git como projeto de uma org.
export function addProject(config, { path, name, org } = {}) {
  const abs = normalizePath(path ?? ".");
  if (!existsSync(abs)) throw new UserError(`path does not exist: ${abs}`);
  if (!existsSync(join(abs, ".git"))) throw new UserError(`not a git repository (no .git): ${abs}`);
  const orgName = org ?? config.defaultOrg;
  requireOrg(config, orgName);
  const projectName = name === undefined ? deriveName(abs) : assertName("project", name);
  const registered = Object.entries(config.projects).find(([, entry]) => entry.path === abs);
  if (registered) {
    const [existingName, entry] = registered;
    if (entry.org === orgName) {
      return { config, status: "unchanged", project: { name: existingName, path: entry.path, org: entry.org } };
    }
    throw new UserError(
      `${abs} is already registered as \`${existingName}\` in org \`${entry.org}\`; use \`shift project move ${existingName} ${orgName}\``,
    );
  }
  const taken = config.projects[projectName];
  if (taken) throw new UserError(`project name \`${projectName}\` is already registered for ${taken.path}`);
  config.projects[projectName] = { path: abs, org: orgName };
  return { config, status: "created", project: { name: projectName, path: abs, org: orgName } };
}

// Remove um projeto registrado.
export function removeProject(config, name) {
  if (!config.projects[name]) throw new UserError(`unknown project \`${name}\``);
  delete config.projects[name];
  return config;
}

// Move um projeto para outra org existente.
export function moveProject(config, name, org) {
  const entry = config.projects[name];
  if (!entry) throw new UserError(`unknown project \`${name}\``);
  requireOrg(config, org);
  if (entry.org === org) return { config, status: "unchanged" };
  entry.org = org;
  return { config, status: "moved" };
}

// Diz se um diretorio e o proprio path registrado ou esta dentro dele.
function contains(path, target) {
  if (target === path) return true;
  return target.startsWith(path.endsWith(sep) ? path : `${path}${sep}`);
}

// Resolve o projeto que contem o diretorio informado, escolhendo o maior prefixo.
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

// Extrai `owner/repo` em minusculo de uma URL de remote git.
export function slugFromRemote(url) {
  const trimmed = String(url ?? "")
    .trim()
    .replace(/\.git$/i, "")
    .replace(/\/+$/, "");
  if (!trimmed) return null;
  const match = REMOTE_RE.exec(trimmed);
  return match ? `${match[1].toLowerCase()}/${match[2].toLowerCase()}` : null;
}

// Le a URL do remote origin de um diretorio.
function defaultGitRemote(cwd) {
  return execFileSync("git", ["-C", cwd, "remote", "get-url", "origin"], {
    encoding: "utf8",
    timeout: 3000,
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

// Devolve `owner/repo` do projeto, ou null quando nao ha origin nem git utilizavel.
export function repoSlugOf(project, { gitRemoteImpl = defaultGitRemote } = {}) {
  if (!project?.path) return null;
  try {
    return slugFromRemote(gitRemoteImpl(project.path));
  } catch {
    return null;
  }
}
