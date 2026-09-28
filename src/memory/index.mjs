import { statSync } from "node:fs";
import { join } from "node:path";
import { UserError } from "../config/errors.mjs";
import { openDb, withWriteRetry } from "./db.mjs";
import { projectIdOrNull } from "./registry.mjs";
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

// Persists the structural map of a project id, upserting by (project_id, path) and by (project_id, lib).
export function saveProjectIndex({ projectId, repoRoot, files = [], libs = [] }, env = process.env) {
  const owner = projectIdOrNull(projectId);
  if (!owner) {
    throw new UserError(`the index needs a registered project, and \`${repoRoot ?? ""}\` is not registered; run \`nightqueue init\` in the repository first`);
  }
  const db = openDb(env);
  const fileStmt = db.prepare(
    `INSERT INTO project_index (project_id, path, responsibility, mtime_ms) VALUES (?, ?, ?, ?)
     ON CONFLICT(project_id, path) DO UPDATE SET
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
    withWriteRetry(() => fileStmt.run(owner, relative, responsibility.slice(0, RESPONSIBILITY_MAX), mtime));
    savedFiles++;
  }
  const libStmt = db.prepare(
    `INSERT INTO project_libs (project_id, lib, version) VALUES (?, ?, ?)
     ON CONFLICT(project_id, lib) DO UPDATE SET version = excluded.version, updated_at = datetime('now')`,
  );
  let savedLibs = 0;
  for (const entry of asList(libs)) {
    const lib = String(entry?.lib ?? "").trim();
    const version = String(entry?.version ?? "").trim();
    if (!lib || !version) continue;
    withWriteRetry(() => libStmt.run(owner, lib, version));
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

// Known map of a project id with real per-file freshness against the current checkout; a global caller has none.
export function recallProjectIndex({ projectId, repoRoot, query, limit = 40 } = {}, env = process.env) {
  const owner = projectIdOrNull(projectId);
  if (!owner) return { files: [], libs: [] };
  const db = openDb(env);
  const tokens = queryTokens(query);
  const binds = [owner];
  let filter = "";
  if (tokens.length) {
    filter = ` AND (${tokens.map(() => "path LIKE ? OR responsibility LIKE ?").join(" OR ")})`;
    for (const token of tokens) binds.push(`%${token}%`, `%${token}%`);
  }
  binds.push(Number.isInteger(limit) && limit > 0 ? limit : 40);
  const rows = db
    .prepare(
      `SELECT path, responsibility, mtime_ms, updated_at FROM project_index
       WHERE project_id = ?${filter}
       ORDER BY updated_at DESC LIMIT ?`,
    )
    .all(...binds);
  const files = rows.map((row) => ({
    path: row.path,
    responsibility: row.responsibility,
    updated_at: row.updated_at,
    ...freshnessOf(row, repoRoot),
  }));
  const libs = db.prepare("SELECT lib, version, updated_at FROM project_libs WHERE project_id = ? ORDER BY lib").all(owner);
  return { files, libs };
}
