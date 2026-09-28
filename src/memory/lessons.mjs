import { UserError } from "../config/errors.mjs";
import { openDb, sqliteToIso, vectorToBlob, withWriteRetry } from "./db.mjs";
import { attachNames, projectIdOrNull } from "./registry.mjs";
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

// Reduces a raw lesson payload to its storable shape: missing text becomes "", an invalid target becomes null.
export function sanitizeLesson(item) {
  return {
    title: String(item?.title ?? ""),
    root_cause: String(item?.root_cause ?? ""),
    solution: String(item?.solution ?? ""),
    prevention: String(item?.prevention ?? ""),
    target: normalizeTarget(item?.target),
  };
}

// Field names, in the tool's declared order, whose text is still empty after sanitizing.
export function emptyLessonFields({ root_cause, solution, prevention }) {
  const sanitized = sanitizeLesson({ root_cause, solution, prevention });
  return ["root_cause", "solution", "prevention"].filter((field) => !sanitized[field]);
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

// Inserts a lesson of a project id (null for a global one) and returns its id.
export function saveLesson({ projectId, title, root_cause, solution, prevention, attempts, target, model }, env = process.env) {
  const owner = projectIdOrNull(projectId);
  const sanitized = sanitizeLesson({ title, root_cause, solution, prevention, target });
  const values = [
    owner,
    requireText("title", sanitized.title),
    sanitized.root_cause,
    sanitized.solution,
    sanitized.prevention,
    Number.isInteger(attempts) ? attempts : null,
    sanitized.target,
    typeof model === "string" && model ? model : null,
  ];
  const statement = openDb(env).prepare(
    `INSERT INTO lessons (project_id, title, root_cause, solution, prevention, attempts, target, model)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const result = withWriteRetry(() => statement.run(...values));
  return { id: Number(result.lastInsertRowid), projectId: owner };
}

// Returns the lesson with the given id and its project's current name, or null.
export function getLesson(id, env = process.env) {
  const db = openDb(env);
  const row = db.prepare("SELECT * FROM lessons WHERE id = ?").get(requireId(id));
  return row ? attachNames(db, [row])[0] : null;
}

// Fills only the currently empty text columns of a lesson from a follow-up payload, never overwriting one that already has text.
export function backfillEmptyLessonFields(id, { root_cause, solution, prevention }, env = process.env) {
  const row = getLesson(id, env);
  if (!row) throw new UserError(`unknown lesson \`${id}\``);
  const candidates = { root_cause, solution, prevention };
  const columns = [];
  const values = [];
  for (const [field, value] of Object.entries(candidates)) {
    const current = typeof row[field] === "string" ? row[field].trim() : "";
    const incoming = typeof value === "string" ? value.trim() : "";
    if (current || !incoming) continue;
    columns.push(`${field} = ?`);
    values.push(incoming);
  }
  if (!columns.length) return row;
  const statement = openDb(env).prepare(`UPDATE lessons SET ${columns.join(", ")} WHERE id = ? RETURNING *`);
  return withWriteRetry(() => statement.get(...values, requireId(id)));
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

// Finds a lesson of the same project id (null for the globals) whose normalized title is identical.
export function findByNormalizedTitle({ projectId, title }, env = process.env) {
  const wanted = normalizeTitle(title);
  if (!wanted) return null;
  const rows = openDb(env)
    .prepare("SELECT id, title, attempts FROM lessons WHERE project_id IS ? ORDER BY id")
    .all(projectIdOrNull(projectId));
  return rows.find((row) => normalizeTitle(row.title) === wanted) ?? null;
}

// Counts of every memory table per owning project id, keyed by id.
function countsByProjectId(db) {
  const totals = new Map();
  for (const [kind, table, where] of STAT_TABLES) {
    for (const row of db.prepare(`SELECT project_id, COUNT(*) AS total FROM ${table} ${where} GROUP BY project_id`).all()) {
      const key = row.project_id ?? null;
      if (!totals.has(key)) totals.set(key, { project_id: key, lessons: 0, memory: 0, index: 0, libs: 0, runs: 0 });
      totals.get(key)[kind] = row.total;
    }
  }
  return [...totals.values()];
}

// Counts of every memory table grouped by project, named by the project's current name, for `nightqueue memory stats`.
export function memoryStats(env = process.env) {
  const db = openDb(env);
  return attachNames(db, countsByProjectId(db))
    .map(({ project, lessons, memory, index, libs, runs }) => ({ project: project ?? null, lessons, memory, index, libs, runs }))
    .sort((a, b) => String(a.project ?? "").localeCompare(String(b.project ?? "")));
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
