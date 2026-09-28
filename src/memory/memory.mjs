import { UserError } from "../config/errors.mjs";
import { openDb, sqliteToIso, withWriteRetry } from "./db.mjs";
import { attachNames, projectIdOrNull } from "./registry.mjs";
import { ftsMatch } from "./search.mjs";

// Requires a non-empty text field, because the column is NOT NULL and a raw SQLite error helps nobody.
function requireText(field, value) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new UserError(`memory field \`${field}\` is required and cannot be empty`);
  return text;
}

// Caps a limit to a positive integer.
function safeLimit(limit, fallback) {
  return Number.isInteger(limit) && limit > 0 ? limit : fallback;
}

// Inserts a fact of a project id (null for a global one) into the shared memory.
export function saveMemory({ projectId, key, value, model }, env = process.env) {
  const owner = projectIdOrNull(projectId);
  const values = [
    owner,
    requireText("key", key),
    requireText("value", typeof value === "string" ? value : String(value ?? "")),
    typeof model === "string" && model ? model : null,
  ];
  const statement = openDb(env).prepare("INSERT INTO memory (project_id, key, value, model) VALUES (?, ?, ?, ?)");
  const result = withWriteRetry(() => statement.run(...values));
  return { id: Number(result.lastInsertRowid), projectId: owner };
}

// Recent memories of a project id plus the globals, most recent first, each with its project's current name.
export function recentMemories({ projectId, limit = 8 } = {}, env = process.env) {
  const db = openDb(env);
  const owner = projectIdOrNull(projectId);
  const size = safeLimit(limit, 8);
  if (!owner) return attachNames(db, db.prepare("SELECT * FROM memory ORDER BY created_at DESC, id DESC LIMIT ?").all(size));
  const rows = db
    .prepare(
      `SELECT * FROM memory WHERE project_id = ? OR project_id IS NULL
       ORDER BY CASE WHEN project_id = ? THEN 0 ELSE 1 END, created_at DESC, id DESC
       LIMIT ?`,
    )
    .all(owner, owner, size);
  return attachNames(db, rows);
}

// Memories matching a query through the FTS index, with a boost for the current project id.
export function searchMemories({ query, projectId, limit = 8 } = {}, env = process.env) {
  const match = ftsMatch(query);
  if (!match) return recentMemories({ projectId, limit }, env);
  const owner = projectIdOrNull(projectId);
  const db = openDb(env);
  const rows = db
    .prepare(
      `SELECT m.* FROM memory_fts JOIN memory m ON m.id = memory_fts.rowid
       WHERE memory_fts MATCH ? AND (? = 0 OR m.project_id = ? OR m.project_id IS NULL)
       ORDER BY bm25(memory_fts)
         + CASE WHEN m.project_id = ? THEN -1.5 WHEN m.project_id IS NULL THEN -0.5 ELSE 0 END
       LIMIT ?`,
    )
    .all(match, owner ? 1 : 0, owner, owner, safeLimit(limit, 8));
  return attachNames(db, rows);
}

// Returns the memory of a project id (null for the globals) with the given key, or null.
export function memoryByKey({ projectId, key } = {}, env = process.env) {
  const wanted = typeof key === "string" ? key.trim() : "";
  if (!wanted) return null;
  const db = openDb(env);
  const row = db.prepare("SELECT * FROM memory WHERE project_id IS ? AND key = ? ORDER BY id LIMIT 1").get(projectIdOrNull(projectId), wanted);
  return row ? attachNames(db, [row])[0] : null;
}

// Public shape of a memory row.
export function memoryView(row) {
  return {
    id: row.id,
    project: row.project ?? null,
    key: row.key,
    value: row.value,
    created_at: sqliteToIso(row.created_at),
  };
}
