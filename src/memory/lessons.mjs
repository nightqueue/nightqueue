import { UserError } from "../config/errors.mjs";
import { openDb, resolveProjectName, sqliteToIso, vectorToBlob, withWriteRetry } from "./db.mjs";
import { normalizeExcludeIds as normalizeIds } from "./search.mjs";

export const LESSON_TARGETS = ["triager", "architect", "coder", "qa", "verifier"];

const STAT_TABLES = [
  ["lessons", "lessons", "WHERE archived = 0"],
  ["memory", "memory", ""],
  ["index", "project_index", ""],
  ["libs", "project_libs", ""],
  ["runs", "pipeline_runs", ""],
];

// Normalizes the target of a lesson to one of the valid phases, or null.
function normalizeTarget(target) {
  return LESSON_TARGETS.includes(target) ? target : null;
}

// Requires a non-empty text field, because the column is NOT NULL and a raw SQLite error helps nobody.
function requireText(field, value) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new UserError(`lesson field \`${field}\` is required and cannot be empty`);
  return text;
}

// Requires an integer id, so a malformed reference never reaches the database.
function requireId(id) {
  if (!Number.isInteger(id)) throw new UserError(`expected an integer lesson id, got \`${String(id)}\``);
  return id;
}

// Inserts a lesson and returns its id.
export function saveLesson({ project, title, root_cause, solution, prevention, attempts, target, model }, env = process.env) {
  const projectName = resolveProjectName(project, env);
  const values = [
    projectName,
    requireText("title", title),
    requireText("root_cause", root_cause),
    requireText("solution", solution),
    requireText("prevention", prevention),
    Number.isInteger(attempts) ? attempts : null,
    normalizeTarget(target),
    typeof model === "string" && model ? model : null,
  ];
  const statement = openDb(env).prepare(
    `INSERT INTO lessons (project, title, root_cause, solution, prevention, attempts, target, model)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const result = withWriteRetry(() => statement.run(...values));
  return { id: Number(result.lastInsertRowid), project: projectName };
}

// Returns the lesson with the given id, or null.
export function getLesson(id, env = process.env) {
  return openDb(env).prepare("SELECT * FROM lessons WHERE id = ?").get(requireId(id)) ?? null;
}

// Increments the recurrence counter of an existing lesson and stamps when it recurred.
export function bumpAttempts(id, env = process.env) {
  const db = openDb(env);
  const statement = db.prepare(
    "UPDATE lessons SET attempts = COALESCE(attempts, 1) + 1, last_recurred_at = datetime('now') WHERE id = ?",
  );
  withWriteRetry(() => statement.run(requireId(id)));
  const row = db.prepare("SELECT id, attempts FROM lessons WHERE id = ?").get(id);
  if (!row) throw new UserError(`unknown lesson \`${id}\``);
  return { id: row.id, attempts: row.attempts };
}

// Increments the violation counter of a lesson that was injected and broken in the same session.
export function bumpViolation(id, env = process.env) {
  const db = openDb(env);
  const statement = db.prepare(
    "UPDATE lessons SET violated = violated + 1, last_violated_at = datetime('now') WHERE id = ?",
  );
  withWriteRetry(() => statement.run(requireId(id)));
  const row = db.prepare("SELECT id, violated FROM lessons WHERE id = ?").get(id);
  if (!row) throw new UserError(`unknown lesson \`${id}\``);
  return { id: row.id, violated: row.violated };
}

// Marks the lessons injected into a session, so the corpus knows what was actually delivered.
export function markInjected(ids, env = process.env) {
  const wanted = normalizeIds(ids);
  if (!wanted.length) return { injected: 0 };
  const placeholders = wanted.map(() => "?").join(",");
  const statement = openDb(env).prepare(
    `UPDATE lessons SET injected = injected + 1, last_injected_at = datetime('now') WHERE id IN (${placeholders})`,
  );
  const result = withWriteRetry(() => statement.run(...wanted));
  return { injected: Number(result.changes) };
}

// Stores the embedding vector and the model tag of a lesson in a single update.
export function setLessonEmbedding({ id, vector, model }, env = process.env) {
  const tag = requireText("embedding_model", model);
  const values = [vectorToBlob(vector), tag, requireId(id)];
  const statement = openDb(env).prepare("UPDATE lessons SET embedding = ?, embedding_model = ? WHERE id = ?");
  const result = withWriteRetry(() => statement.run(...values));
  return { id, updated: Number(result.changes) };
}

// Lessons that still have no vector of the current model.
export function lessonsMissingEmbedding({ model, limit = 100 } = {}, env = process.env) {
  const tag = requireText("embedding_model", model);
  const size = Number.isInteger(limit) && limit > 0 ? limit : 100;
  return openDb(env)
    .prepare(
      `SELECT id, title, prevention FROM lessons
       WHERE embedding IS NULL OR embedding_model IS NOT ?
       ORDER BY id LIMIT ?`,
    )
    .all(tag, size);
}

// Normalizes a title for the cheap dedup: lowercase, no punctuation, collapsed spaces.
export function normalizeTitle(title) {
  return String(title ?? "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Finds a lesson of the same project whose normalized title is identical.
export function findByNormalizedTitle({ project, title }, env = process.env) {
  const wanted = normalizeTitle(title);
  if (!wanted) return null;
  const rows = openDb(env)
    .prepare("SELECT id, title, attempts FROM lessons WHERE project IS ? ORDER BY id")
    .all(project ?? null);
  return rows.find((row) => normalizeTitle(row.title) === wanted) ?? null;
}

// Counts of every memory table grouped by project, for `shift memory stats`.
export function memoryStats(env = process.env) {
  const db = openDb(env);
  const totals = new Map();
  for (const [kind, table, where] of STAT_TABLES) {
    for (const row of db.prepare(`SELECT project, COUNT(*) AS total FROM ${table} ${where} GROUP BY project`).all()) {
      const key = row.project ?? null;
      if (!totals.has(key)) totals.set(key, { project: key, lessons: 0, memory: 0, index: 0, libs: 0, runs: 0 });
      totals.get(key)[kind] = row.total;
    }
  }
  return [...totals.values()].sort((a, b) => String(a.project ?? "").localeCompare(String(b.project ?? "")));
}

// Public shape of a lesson: an explicit allowlist, because the row carries the embedding BLOB.
export function lessonView(row) {
  return {
    id: row.id,
    project: row.project ?? null,
    title: row.title,
    root_cause: row.root_cause,
    solution: row.solution,
    prevention: row.prevention,
    target: row.target ?? null,
    attempts: row.attempts ?? null,
    violated: row.violated ?? 0,
    created_at: sqliteToIso(row.created_at),
    ...(row.via ? { via: row.via } : {}),
    ...(Number.isFinite(row.cosine) ? { cosine: Number(row.cosine.toFixed(4)) } : {}),
  };
}
