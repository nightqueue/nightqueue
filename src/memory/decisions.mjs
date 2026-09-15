import { UserError } from "../config/errors.mjs";
import { openDb, sqliteToIso, toQueryVector, vectorToBlob, withWriteRetry } from "./db.mjs";
import { truncateByCodePoint } from "./jobs.mjs";
import { escapePromptMarkers } from "./prompt-safety.mjs";
import {
  OWNER_CLAUSE,
  orgFirst,
  ownerDescription,
  ownerLabel,
  ownerOf,
  ownerRef,
  ownerValues,
  requireScopeTarget,
  visibility,
} from "./scope.mjs";
import {
  RECALL_COS_CUT,
  embedWithDeadline,
  ftsMatch,
  interleave,
  markVia,
  rankByCosine,
  resolveEmbedder,
  safeLimit,
} from "./search.mjs";

export const DECISION_STATUSES = ["proposed", "accepted", "superseded", "rejected"];
export const DECISION_RECALL_LIMIT = 8;

const REQUIRED_TEXT_FIELDS = ["title", "context", "decision"];
const OPTIONAL_TEXT_FIELDS = ["consequences"];
const ORG_FIRST = "CASE WHEN scope = 'org' THEN 0 ELSE 1 END";

// Requires a non-empty text field, because the column is NOT NULL and a raw SQLite error helps nobody.
function requireText(field, value) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new UserError(`decision field \`${field}\` is required and cannot be empty`);
  return text;
}

// Requires a positive integer id, so a malformed reference never reaches the database.
function requireId(id) {
  if (!Number.isInteger(id) || id <= 0) {
    throw new UserError(`expected a positive integer decision id, got \`${String(id)}\``);
  }
  return id;
}

// Returns the trimmed string, or null when there is nothing to store.
function optionalText(value) {
  const text = typeof value === "string" ? value.trim() : "";
  return text ? text : null;
}

// Requires a value of the status enum, naming the accepted values in the error.
function requireStatus(status) {
  if (DECISION_STATUSES.includes(status)) return status;
  throw new UserError(
    `invalid decision \`status\`: \`${String(status)}\`; expected one of ${DECISION_STATUSES.join("|")}`,
  );
}

// Tells whether a patch carries a value for a field: an explicit null is treated exactly like an absent key.
function hasValue(patch, field) {
  return patch[field] !== undefined && patch[field] !== null;
}

// Returns the raw row of a decision, or null.
export function getDecision(id, env = process.env) {
  return openDb(env).prepare("SELECT * FROM decisions WHERE id = ?").get(requireId(id)) ?? null;
}

// Returns the raw row of the decision an owner numbered, or null; `db` lets a read-only caller bring its own connection.
export function getDecisionByNumber({ project, org, number } = {}, env = process.env, db = null) {
  if (!Number.isInteger(number) || number <= 0) {
    throw new UserError(`expected a positive integer decision number, got \`${String(number)}\``);
  }
  const target = requireScopeTarget({ project, org }, env);
  return (
    (db ?? openDb(env))
      .prepare(`SELECT * FROM decisions WHERE ${OWNER_CLAUSE} AND number = ?`)
      .get(...ownerValues(target), number) ?? null
  );
}

// The status to store plus whether the safe default ("proposed") replaced a missing or invalid one.
function resolveSavedStatus(status) {
  if (DECISION_STATUSES.includes(status)) return { status, statusDefaulted: false };
  return { status: "proposed", statusDefaulted: true };
}

// Inserts a decision numbered `max(number) + 1` for its owner, in one statement so no concurrent save collides.
export function saveDecision({ project, org, title, context, decision, consequences, status } = {}, env = process.env) {
  const target = requireScopeTarget({ project, org }, env);
  const owner = ownerValues(target);
  const { status: resolvedStatus, statusDefaulted } = resolveSavedStatus(status);
  const values = [
    ...owner,
    ...owner,
    requireText("title", title),
    requireText("context", context),
    requireText("decision", decision),
    optionalText(consequences),
    resolvedStatus,
  ];
  const statement = openDb(env).prepare(
    `INSERT INTO decisions (scope, project, org, number, title, context, decision, consequences, status)
     VALUES (?, ?, ?, (SELECT COALESCE(MAX(number), 0) + 1 FROM decisions WHERE ${OWNER_CLAUSE}), ?, ?, ?, ?, ?)
     RETURNING id, number`,
  );
  const row = withWriteRetry(() => statement.get(...values));
  const [scope, projectName, orgName] = owner;
  return { id: Number(row.id), number: Number(row.number), scope, project: projectName, org: orgName, statusDefaulted };
}

// Requires `superseded_by` to point at another existing decision of the same owner: superseding is authorship, not visibility.
function requireSupersededBy(row, value, env) {
  const target = requireId(value);
  if (target === row.id) throw new UserError(`decision \`${row.id}\` cannot supersede itself`);
  const other = getDecision(target, env);
  if (!other) throw new UserError(`unknown decision \`${target}\``);
  if (other.scope !== row.scope || ownerOf(other) !== ownerOf(row)) {
    throw new UserError(`decision \`${target}\` belongs to ${ownerDescription(other)}, not ${ownerDescription(row)}`);
  }
  return target;
}

// Column assignments of an update patch, validating every present field the way the insert does.
function updateAssignments(patch, row, env) {
  const columns = [];
  const values = [];
  for (const field of REQUIRED_TEXT_FIELDS) {
    if (!hasValue(patch, field)) continue;
    columns.push(`${field} = ?`);
    values.push(requireText(field, patch[field]));
  }
  for (const field of OPTIONAL_TEXT_FIELDS) {
    if (!hasValue(patch, field)) continue;
    columns.push(`${field} = ?`);
    values.push(optionalText(patch[field]));
  }
  if (hasValue(patch, "status")) {
    columns.push("status = ?");
    values.push(requireStatus(patch.status));
  }
  if (hasValue(patch, "superseded_by")) {
    columns.push("superseded_by = ?");
    values.push(requireSupersededBy(row, patch.superseded_by, env));
  }
  return { columns, values };
}

// Updates the fields present in the patch and returns the stored row; an absent or null field is left untouched.
export function updateDecision(id, patch = {}, env = process.env) {
  const row = getDecision(id, env);
  if (!row) throw new UserError(`unknown decision \`${id}\``);
  const { columns, values } = updateAssignments(patch ?? {}, row, env);
  if (!columns.length) return row;
  const statement = openDb(env).prepare(
    `UPDATE decisions SET ${columns.join(", ")}, updated_at = datetime('now') WHERE id = ? RETURNING *`,
  );
  return withWriteRetry(() => statement.get(...values, row.id));
}

// Decisions an owner sees, org rows first and each in numbering order, optionally filtered by status; `db` lets a read-only caller bring its own connection.
export function listDecisions({ project, org, status } = {}, env = process.env, db = null) {
  const connection = db ?? openDb(env);
  const visible = visibility(requireScopeTarget({ project, org }, env));
  const filter = status === undefined || status === null ? "" : " AND status = ?";
  const values = status === undefined || status === null ? [] : [requireStatus(status)];
  return connection
    .prepare(`SELECT * FROM decisions WHERE ${visible.clause}${filter} ORDER BY ${ORG_FIRST}, number ASC`)
    .all(...visible.values, ...values);
}

// Stores the embedding vector and the model tag of a decision in a single update.
export function setDecisionEmbedding({ id, vector, model }, env = process.env) {
  const tag = requireText("embedding_model", model);
  const values = [vectorToBlob(vector), tag, requireId(id)];
  const statement = openDb(env).prepare("UPDATE decisions SET embedding = ?, embedding_model = ? WHERE id = ?");
  const result = withWriteRetry(() => statement.run(...values));
  return { id, updated: Number(result.changes) };
}

// Decisions that still have no vector of the current model.
export function decisionsMissingEmbedding({ model, limit = 100 } = {}, env = process.env) {
  const tag = requireText("embedding_model", model);
  const size = Number.isInteger(limit) && limit > 0 ? limit : 100;
  return openDb(env)
    .prepare(
      `SELECT id, title, decision FROM decisions
       WHERE embedding IS NULL OR embedding_model IS NOT ?
       ORDER BY id LIMIT ?`,
    )
    .all(tag, size);
}

// Compact shape of a decision, for a listing: free text truncated like the queue views truncate it.
export function decisionView(row) {
  return {
    id: row.id,
    scope: row.scope,
    owner: ownerOf(row),
    number: row.number,
    title: truncateByCodePoint(row.title),
    status: row.status,
    updated_at: sqliteToIso(row.updated_at),
  };
}

// Full shape of a decision: untruncated, because it feeds prompt building; never the embedding BLOB.
export function decisionFullView(row) {
  return {
    id: row.id,
    scope: row.scope,
    owner: ownerOf(row),
    project: row.project ?? null,
    org: row.org ?? null,
    number: row.number,
    title: row.title,
    context: row.context,
    decision: row.decision,
    consequences: row.consequences ?? null,
    status: row.status,
    superseded_by: row.superseded_by ?? null,
    created_at: sqliteToIso(row.created_at),
    updated_at: sqliteToIso(row.updated_at),
    ...(row.via ? { via: row.via } : {}),
    ...(Number.isFinite(row.cosine) ? { cosine: Number(row.cosine.toFixed(4)) } : {}),
  };
}

// Plain text of a decision, the single rendering the queue prompt and the CLI both print; its free text can never forge a marker.
export function renderDecisionText(row) {
  return escapePromptMarkers(
    [
      `${ownerLabel(row)} ${row.title} (${row.status})`,
      `Context: ${row.context}`,
      `Decision: ${row.decision}`,
      ...(row.consequences ? [`Consequences: ${row.consequences}`] : []),
    ].join("\n"),
  );
}

// Most recently updated accepted decisions an owner sees.
export function recentDecisions({ project, org, limit = DECISION_RECALL_LIMIT } = {}, env = process.env) {
  const visible = visibility(requireScopeTarget({ project, org }, env));
  return openDb(env)
    .prepare(
      `SELECT * FROM decisions
       WHERE status = 'accepted' AND ${visible.clause}
       ORDER BY updated_at DESC, id DESC LIMIT ?`,
    )
    .all(...visible.values, safeLimit(limit, DECISION_RECALL_LIMIT));
}

// Accepted decisions an owner sees matching a query through BM25, with the project's own decisions boosted over its org's.
export function searchDecisionsLexical({ query, project, org, limit = DECISION_RECALL_LIMIT } = {}, env = process.env) {
  const match = ftsMatch(query);
  if (!match) return [];
  const target = requireScopeTarget({ project, org }, env);
  const visible = visibility(target, "d");
  return openDb(env)
    .prepare(
      `SELECT d.*, bm25(decisions_fts) AS rank
       FROM decisions_fts JOIN decisions d ON d.id = decisions_fts.rowid
       WHERE decisions_fts MATCH ? AND d.status = 'accepted' AND ${visible.clause}
       ORDER BY bm25(decisions_fts)
         + CASE WHEN d.project = ? THEN -1.5 WHEN d.scope = 'org' THEN -1.0 WHEN d.project IS NULL THEN -0.5 ELSE 0 END
       LIMIT ?`,
    )
    .all(match, ...visible.values, target.project, safeLimit(limit, DECISION_RECALL_LIMIT));
}

// Hydrates the rows that won the cosine ranking, preserving their order.
function hydrateByCosine(db, scored) {
  if (!scored.length) return [];
  const rows = db
    .prepare(`SELECT * FROM decisions WHERE id IN (${scored.map(() => "?").join(",")})`)
    .all(...scored.map((entry) => entry.id));
  const byId = new Map(rows.map((row) => [row.id, row]));
  return scored
    .filter((entry) => byId.has(entry.id))
    .map((entry) => {
      const row = byId.get(entry.id);
      row.cosine = entry.cosine;
      return row;
    });
}

// Semantic side of the decision recall: brute-force cosine over the accepted rows carrying a vector of this model.
export function searchDecisionsSemantic(
  { vector, model, project, org, limit = DECISION_RECALL_LIMIT, cut = RECALL_COS_CUT } = {},
  env = process.env,
) {
  const query = toQueryVector(vector);
  if (!query || typeof model !== "string" || !model) return [];
  const visible = visibility(requireScopeTarget({ project, org }, env));
  const db = openDb(env);
  const rows = db
    .prepare(
      `SELECT id, embedding FROM decisions
       WHERE embedding IS NOT NULL AND embedding_model = ? AND length(embedding) = ?
         AND status = 'accepted' AND ${visible.clause}`,
    )
    .all(model, query.length * 4, ...visible.values);
  const ceiling = safeLimit(limit, DECISION_RECALL_LIMIT);
  const scored = rankByCosine(rows, query, Number.isFinite(cut) ? cut : RECALL_COS_CUT, ceiling);
  return hydrateByCosine(db, scored);
}

// Single entry of the decision recall: only accepted decisions, BM25 always answers, the semantic path only adds.
export async function recallDecisions(
  { query, project, org, limit = DECISION_RECALL_LIMIT, embedder, deadlineMs } = {},
  env = process.env,
) {
  const owner = ownerRef(requireScopeTarget({ project, org }, env));
  const size = safeLimit(limit, DECISION_RECALL_LIMIT);
  if (!ftsMatch(query)) return orgFirst(markVia(recentDecisions({ ...owner, limit: size }, env), "lexical"));
  const lexical = markVia(searchDecisionsLexical({ query, ...owner, limit: size }, env), "lexical");
  const resolved = await resolveEmbedder(embedder, env);
  const vector = resolved ? await embedWithDeadline(resolved, query, deadlineMs) : null;
  let results = lexical;
  if (vector) {
    try {
      const semantic = markVia(
        searchDecisionsSemantic({ vector, model: resolved.model, ...owner, limit: size }, env),
        "semantic",
      );
      results = interleave(lexical, semantic, size);
    } catch {
      results = lexical;
    }
  }
  if (results.length) return orgFirst(results);
  return orgFirst(markVia(recentDecisions({ ...owner, limit: size }, env), "fallback"));
}
