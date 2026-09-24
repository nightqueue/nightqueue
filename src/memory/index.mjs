import { statSync } from "node:fs";
import { join } from "node:path";
import { UserError } from "../config/errors.mjs";
import { openDb, resolveProjectName, withWriteRetry } from "./db.mjs";
import { queryTokens } from "./search.mjs";

const RESPONSIBILITY_MAX = 200;

// Normalizes an indexed path to a path relative to the repository root, so worktrees share the same rows.
function toRelativePath(path, repoRoot) {
  const raw = String(path ?? "").trim();
  if (!repoRoot || !raw.startsWith("/")) return raw.replace(/^\.\//, "");
  const root = repoRoot.endsWith("/") ? repoRoot : `${repoRoot}/`;
  return raw.startsWith(root) ? raw.slice(root.length) : raw;
}

// Modification time of a file in milliseconds, or null when it is not there.
function statMtime(absPath) {
  try {
    return Math.round(statSync(absPath).mtimeMs);
  } catch {
    return null;
  }
}

// Returns the array as given, treating anything else as an empty list.
function asList(value) {
  return Array.isArray(value) ? value : [];
}

// Persists the structural map of a project, upserting by (project, path) and by (project, lib).
export function saveProjectIndex({ project, repoRoot, files = [], libs = [] }, env = process.env) {
  const projectName = resolveProjectName(project, env);
  if (!projectName) {
    throw new UserError(`project \`${project}\` is not registered; run \`nightqueue init\` in the repository first`);
  }
  const db = openDb(env);
  const fileStmt = db.prepare(
    `INSERT INTO project_index (project, path, responsibility, mtime_ms) VALUES (?, ?, ?, ?)
     ON CONFLICT(project, path) DO UPDATE SET
       responsibility = excluded.responsibility,
       mtime_ms = excluded.mtime_ms,
       updated_at = datetime('now')`,
  );
  let savedFiles = 0;
  for (const file of asList(files)) {
    const relative = toRelativePath(file?.path, repoRoot);
    const responsibility = String(file?.responsibility ?? "").trim();
    if (!relative || !responsibility) continue;
    const mtime = repoRoot ? statMtime(join(repoRoot, relative)) : null;
    withWriteRetry(() => fileStmt.run(projectName, relative, responsibility.slice(0, RESPONSIBILITY_MAX), mtime));
    savedFiles++;
  }
  const libStmt = db.prepare(
    `INSERT INTO project_libs (project, lib, version) VALUES (?, ?, ?)
     ON CONFLICT(project, lib) DO UPDATE SET version = excluded.version, updated_at = datetime('now')`,
  );
  let savedLibs = 0;
  for (const entry of asList(libs)) {
    const lib = String(entry?.lib ?? "").trim();
    const version = String(entry?.version ?? "").trim();
    if (!lib || !version) continue;
    withWriteRetry(() => libStmt.run(projectName, lib, version));
    savedLibs++;
  }
  return { files: savedFiles, libs: savedLibs };
}

// Freshness of an indexed file against the current checkout.
function freshnessOf(row, repoRoot) {
  const current = repoRoot ? statMtime(join(repoRoot, row.path)) : null;
  const missing = repoRoot ? current === null : false;
  return { missing, stale: missing || (current !== null && row.mtime_ms !== null && current > row.mtime_ms) };
}

// Known map of a project with real per-file freshness against the current checkout.
export function recallProjectIndex({ project, repoRoot, query, limit = 40 } = {}, env = process.env) {
  const projectName = resolveProjectName(project, env);
  if (!projectName) return { files: [], libs: [] };
  const db = openDb(env);
  const tokens = queryTokens(query);
  const binds = [projectName];
  let filter = "";
  if (tokens.length) {
    filter = ` AND (${tokens.map(() => "path LIKE ? OR responsibility LIKE ?").join(" OR ")})`;
    for (const token of tokens) binds.push(`%${token}%`, `%${token}%`);
  }
  binds.push(Number.isInteger(limit) && limit > 0 ? limit : 40);
  const rows = db
    .prepare(
      `SELECT path, responsibility, mtime_ms, updated_at FROM project_index
       WHERE project = ?${filter}
       ORDER BY updated_at DESC LIMIT ?`,
    )
    .all(...binds);
  const files = rows.map((row) => ({
    path: row.path,
    responsibility: row.responsibility,
    updated_at: row.updated_at,
    ...freshnessOf(row, repoRoot),
  }));
  const libs = db.prepare("SELECT lib, version, updated_at FROM project_libs WHERE project = ? ORDER BY lib").all(projectName);
  return { files, libs };
}
