import { projectByName, resolveProject } from "../config/projects.mjs";
import { loadConfig } from "../config/store.mjs";

// Resolves a project reference (registered name or a path inside it) to the registered NAME, or null for global.
export function resolveProjectName(reference, env = process.env) {
  const raw = typeof reference === "string" ? reference.trim() : "";
  if (!raw) return null;
  const config = loadConfig(env, { warn: () => {} });
  const named = projectByName(config, raw);
  if (named) return named.name;
  return resolveProject(config, { cwd: raw })?.name ?? null;
}

// Resolves the project of a working directory, or null when the directory is not inside a registered project.
export function projectFromCwd(cwd, env = process.env) {
  const target = typeof cwd === "string" ? cwd.trim() : "";
  if (!target) return null;
  return resolveProject(loadConfig(env, { warn: () => {} }), { cwd: target });
}
