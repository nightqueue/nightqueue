import { join } from "node:path";
import { UserError } from "../config/errors.mjs";
import { openDb, withWriteRetry } from "./db.mjs";
import { indexedFileMtime, statMtime, toRelativePath } from "./index-paths.mjs";
import { projectIdOrNull } from "./registry.mjs";
import { isoToSqlite } from "./schema.mjs";
import { queryTokens } from "./search.mjs";

const RESPONSIBILITY_MAX = 200;

const FILE_UPSERT = `INSERT INTO project_index (project_id, path, responsibility, mtime_ms) VALUES (?, ?, ?, ?)
     ON CONFLICT(project_id, path) DO UPDATE SET
       responsibility = excluded.responsibility,
       mtime_ms = excluded.mtime_ms,
       updated_at = datetime('now')`;

const LIB_UPSERT = `INSERT INTO project_libs (project_id, lib, version) VALUES (?, ?, ?)
     ON CONFLICT(project_id, lib) DO UPDATE SET version = excluded.version, updated_at = datetime('now')`;

// Returns the array as given, treating anything else as an empty list.
function asList(value) {
  return Array.isArray(value) ? value : [];
}

// The registered owner of an index write, or a UserError naming the repository that is not registered.
function requireIndexOwner(projectId, repoRoot) {
  const owner = projectIdOrNull(projectId);
  if (owner) return owner;
  throw new UserError(`the index needs a registered project, and \`${repoRoot ?? ""}\` is not registered; run \`nightqueue init\` in the repository first`);
}

// The file rows an index write stores, each with the modification time `mtimeOf` gives it; an entry with no path or no responsibility is skipped.
function fileRows(files, repoRoot, mtimeOf) {
  const rows = [];
  for (const file of asList(files)) {
    const path = toRelativePath(file?.path, repoRoot);
    const responsibility = String(file?.responsibility ?? "").trim();
    if (path && responsibility) rows.push({ path, responsibility: responsibility.slice(0, RESPONSIBILITY_MAX), mtime: mtimeOf(file) });
  }
  return rows;
}

// The lib rows an index write stores; an entry with no lib or no version is skipped.
function libRows(libs) {
  const rows = [];
  for (const entry of asList(libs)) {
    const lib = String(entry?.lib ?? "").trim();
    const version = String(entry?.version ?? "").trim();
    if (lib && version) rows.push({ lib, version });
  }
  return rows;
}

// Persists the structural map of a project id, upserting by (project_id, path) and by (project_id, lib).
export function saveProjectIndex({ projectId, repoRoot, files = [], libs = [] }, env = process.env) {
  const owner = requireIndexOwner(projectId, repoRoot);
  const db = openDb(env);
  const fileStmt = db.prepare(FILE_UPSERT);
  const savedFiles = fileRows(files, repoRoot, (file) => indexedFileMtime(file?.path, repoRoot));
  for (const row of savedFiles) withWriteRetry(() => fileStmt.run(owner, row.path, row.responsibility, row.mtime));
  const libStmt = db.prepare(LIB_UPSERT);
  const savedLibs = libRows(libs);
  for (const row of savedLibs) withWriteRetry(() => libStmt.run(owner, row.lib, row.version));
  return { files: savedFiles.length, libs: savedLibs.length };
}

// Persists an index save queued while the database was unavailable, writing only the rows no save touched since `since`
// and the modification times measured when it was queued; answers the rows it actually wrote.
export function fillProjectIndex({ projectId, repoRoot, files = [], libs = [], since }, env = process.env) {
  const owner = requireIndexOwner(projectId, repoRoot);
  const from = isoToSqlite(since);
  if (!from) throw new UserError(`fillProjectIndex needs the instant the save was queued at; got \`${String(since)}\``);
  const db = openDb(env);
  const fileStmt = db.prepare(`${FILE_UPSERT} WHERE datetime(project_index.updated_at) < datetime(?)`);
  let filled = 0;
  for (const row of fileRows(files, repoRoot, (file) => (Number.isFinite(file?.mtimeMs) ? file.mtimeMs : null))) {
    filled += withWriteRetry(() => fileStmt.run(owner, row.path, row.responsibility, row.mtime, from)).changes;
  }
  const libStmt = db.prepare(`${LIB_UPSERT} WHERE datetime(project_libs.updated_at) < datetime(?)`);
  let filledLibs = 0;
  for (const row of libRows(libs)) filledLibs += withWriteRetry(() => libStmt.run(owner, row.lib, row.version, from)).changes;
  return { files: filled, libs: filledLibs };
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
