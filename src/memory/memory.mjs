import { UserError } from "../config/errors.mjs";
import { openDb, resolveProjectName, sqliteToIso, withWriteRetry } from "./db.mjs";
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

// Inserts a project fact into the shared memory.
export function saveMemory({ project, key, value, model }, env = process.env) {
  const projectName = resolveProjectName(project, env);
  const values = [
    projectName,
    requireText("key", key),
    requireText("value", typeof value === "string" ? value : String(value ?? "")),
    typeof model === "string" && model ? model : null,
  ];
  const statement = openDb(env).prepare("INSERT INTO memory (project, key, value, model) VALUES (?, ?, ?, ?)");
  const result = withWriteRetry(() => statement.run(...values));
  return { id: Number(result.lastInsertRowid), project: projectName };
}

// Recent memories of a project plus the globals, most recent first.
export function recentMemories({ project, limit = 8 } = {}, env = process.env) {
  const db = openDb(env);
  const projectName = resolveProjectName(project, env);
  const size = safeLimit(limit, 8);
  if (!projectName) return db.prepare("SELECT * FROM memory ORDER BY created_at DESC, id DESC LIMIT ?").all(size);
  return db
    .prepare(
      `SELECT * FROM memory WHERE project = ? OR project IS NULL
       ORDER BY CASE WHEN project = ? THEN 0 ELSE 1 END, created_at DESC, id DESC
       LIMIT ?`,
    )
    .all(projectName, projectName, size);
}

// Memories matching a query through the FTS index, with a boost for the current project.
export function searchMemories({ query, project, limit = 8 } = {}, env = process.env) {
  const match = ftsMatch(query);
  if (!match) return recentMemories({ project, limit }, env);
  const projectName = resolveProjectName(project, env);
  return openDb(env)
    .prepare(
      `SELECT m.* FROM memory_fts JOIN memory m ON m.id = memory_fts.rowid
       WHERE memory_fts MATCH ? AND (? = 0 OR m.project = ? OR m.project IS NULL)
       ORDER BY bm25(memory_fts)
         + CASE WHEN m.project = ? THEN -1.5 WHEN m.project IS NULL THEN -0.5 ELSE 0 END
       LIMIT ?`,
    )
    .all(match, projectName ? 1 : 0, projectName, projectName, safeLimit(limit, 8));
}

// Returns the memory of a project with the given key, or null.
export function memoryByKey({ project, key } = {}, env = process.env) {
  const wanted = typeof key === "string" ? key.trim() : "";
  if (!wanted) return null;
  return (
    openDb(env)
      .prepare("SELECT * FROM memory WHERE project IS ? AND key = ? ORDER BY id LIMIT 1")
      .get(resolveProjectName(project, env), wanted) ?? null
  );
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
