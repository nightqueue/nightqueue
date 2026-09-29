import { UserError } from "../config/errors.mjs";
import { inTransaction, openDb, sqliteToIso, toQueryVector, vectorToBlob, withWriteRetry } from "./db.mjs";
import { truncateByCodePoint } from "./jobs.mjs";
import { escapePromptMarkers } from "./prompt-safety.mjs";
import { GLOBAL_KEY, jobRef, parseRef } from "./refs.mjs";
import { attachNames, ownerByKey } from "./registry.mjs";
import {
  OWNER_CLAUSE,
  decisionRef,
  orgFirst,
  ownerDescription,
  ownerOf,
  ownerRef,
  ownerValues,
  projectScope,
  requireScopeTarget,
  sameOwner,
  targetDecisionRef,
  visibility,
} from "./scope.mjs";
import {
  RECALL_COS_CUT,
  coverageFloor,
  embedWithDeadline,
  ftsMatch,
  informativeCap,
  interleave,
  markVia,
  queryTokens,
  rankByCosine,
  resolveEmbedder,
  safeLimit,
} from "./search.mjs";

export const DECISION_STATUSES = ["proposed", "accepted", "superseded", "rejected"];
export const DECISION_RECALL_LIMIT = 8;
export const STANDING_HEADING = "Standing decisions";
export const PROPOSED_HEADING = "Proposed (not binding)";
export const GATE_STATUSES = ["accepted", "proposed"];
export const GATE_CANDIDATE_LIMIT = 10;

const TITLE_LINE_MAX = 200;
const REQUIRED_TEXT_FIELDS = ["title", "context", "decision"];
const OPTIONAL_TEXT_FIELDS = ["consequences"];
const ORG_FIRST = "CASE WHEN scope = 'org' THEN 0 ELSE 1 END";
const GATE_STATUS_CLAUSE = `status IN (${GATE_STATUSES.map((status) => `'${status}'`).join(", ")})`;
const CREATED_DATE = /^\d{4}-\d{2}-\d{2}$/;
const INSERT_DECISION = `INSERT INTO decisions
  (scope, project_id, org_id, number, title, context, decision, consequences, status, job_id, superseded_by, created_at)
  VALUES (?, ?, ?, (SELECT COALESCE(MAX(number), 0) + 1 FROM decisions WHERE ${OWNER_CLAUSE}),
    ?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')))
  RETURNING id, number`;
const NUMBERED_DECISION_QUERY = `SELECT *, (SELECT s.number FROM decisions s WHERE s.id = decisions.superseded_by) AS superseded_by_number
  FROM decisions WHERE ${OWNER_CLAUSE} AND number = ?`;

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

// The rows with the current names of their owner attached as `project` and `org`.
function named(db, rows) {
  return attachNames(db, rows);
}

// One row with the current names of its owner attached, or null.
function namedRow(db, row) {
  return row ? named(db, [row])[0] : null;
}

// Returns the row of a decision, its owner's names attached, or null.
export function getDecision(id, env = process.env) {
  const db = openDb(env);
  return namedRow(db, db.prepare("SELECT * FROM decisions WHERE id = ?").get(requireId(id)));
}

// Returns the row of the decision an owner numbered, or null; `db` lets a read-only caller bring its own connection.
export function getDecisionByNumber({ projectId, orgId, number } = {}, env = process.env, db = null) {
  if (!Number.isInteger(number) || number <= 0) {
    throw new UserError(`expected a positive integer decision number, got \`${String(number)}\``);
  }
  const connection = db ?? openDb(env);
  const target = requireScopeTarget(connection, { projectId, orgId });
  const row = connection.prepare(NUMBERED_DECISION_QUERY).get(...ownerValues(target), number);
  return namedRow(connection, row);
}

// The owner target a parsed decision ref names: its key's owner (current or old key), the global owner for `G`, or the project context of a bare `D-<n>`.
function decisionRefOwner(db, ref, projectId) {
  if (ref.key === GLOBAL_KEY) return projectScope(db, null);
  if (ref.key !== null) return ownerByKey(db, ref.key);
  if (projectId === null || projectId === undefined) {
    throw new UserError(`\`D-${ref.number}\` names a decision of a project: pass the project, or write it \`<KEY>/D-${ref.number}\``);
  }
  return projectScope(db, projectId);
}

// Resolves a decision ref (`D-<n>` in the `projectId` context, `<KEY>/D-<n>`, `G/D-<n>`) to its row, names attached; a ref never resolves to two rows.
export function decisionOfRef(value, { projectId = null } = {}, env = process.env, db = null) {
  const ref = parseRef(value);
  if (ref?.kind !== "decision") {
    throw new UserError(`expected a decision ref (\`D-<number>\` or \`<KEY>/D-<number>\`), got \`${String(value)}\``);
  }
  const connection = db ?? openDb(env);
  const owner = decisionRefOwner(connection, ref, projectId);
  const text = ref.key === null ? `D-${ref.number}` : `${ref.key}/D-${ref.number}`;
  const rows = owner ? connection.prepare(NUMBERED_DECISION_QUERY).all(...ownerValues(owner), ref.number) : [];
  if (rows.length === 0) throw new UserError(`unknown decision \`${text}\``);
  if (rows.length > 1) throw new UserError(`\`${text}\` names ${rows.length} decisions; a ref must name exactly one, so fix the duplicate numbers first`);
  return namedRow(connection, rows[0]);
}

// Resolves a decision ref to the id of the one decision it names.
export function decisionIdOfRef(value, context = {}, env = process.env, db = null) {
  return Number(decisionOfRef(value, context, env, db).id);
}

// Tells whether a decision row belongs to exactly the given owner target.
function ownedBy(row, target) {
  const [scope, projectId, orgId] = ownerValues(target);
  return row.scope === scope && (row.project_id ?? null) === projectId && (row.org_id ?? null) === orgId;
}

// The per-owner number one `supersedes`/`unrelated` entry names: a plain number as it is, or a ref that must name a decision of the owner itself.
function ownDecisionNumber(db, target, entry, env) {
  if (typeof entry === "number") return entry;
  if (typeof entry === "string" && /^\s*\d+\s*$/.test(entry)) return Number(entry);
  const context = { projectId: target.scope === "project" ? target.projectId : null };
  const row = decisionOfRef(entry, context, env, db);
  if (!ownedBy(row, target)) throw new UserError(`\`${String(entry).trim()}\` is not a decision of ${ownerDescription(target)}`);
  return Number(row.number);
}

// The per-owner numbers a list of numbers or refs names, for the owner `{ projectId }` or `{ orgId }`; an absent list stays absent.
export function ownDecisionNumbers(entries, owner = {}, env = process.env, db = null) {
  if (!Array.isArray(entries)) return entries;
  const connection = db ?? openDb(env);
  const target = requireScopeTarget(connection, owner);
  return entries.map((entry) => ownDecisionNumber(connection, target, entry, env));
}

// The status to store plus whether the safe default ("proposed") replaced a missing or invalid one.
function resolveSavedStatus(status) {
  if (DECISION_STATUSES.includes(status)) return { status, statusDefaulted: false };
  return { status: "proposed", statusDefaulted: true };
}

// Inserts one decision numbered `max(number) + 1` for its owner, in one statement so no concurrent save collides.
function insertDecisionRow(db, row) {
  const owner = ownerValues(row.target);
  const inserted = db.prepare(INSERT_DECISION).get(
    ...owner,
    ...owner,
    row.title,
    row.context,
    row.decision,
    row.consequences,
    row.status,
    row.jobId ?? null,
    row.supersededById ?? null,
    row.createdAt ?? null,
  );
  return { id: Number(inserted.id), number: Number(inserted.number) };
}

// The identity of a saved decision the way every save answers it: the owner's ids and its current names.
function savedIdentity(target, inserted, statusDefaulted) {
  const org = target.scope === "org";
  return {
    id: inserted.id,
    number: inserted.number,
    ref: targetDecisionRef(target, inserted.number),
    scope: target.scope,
    project: org ? null : target.project,
    org: org ? target.org : null,
    projectId: org ? null : target.projectId,
    orgId: org ? target.orgId : null,
    statusDefaulted,
  };
}

// Inserts a decision without any review of what it overlaps: the internal primitive fixtures seed through.
export function saveDecision({ projectId, orgId, title, context, decision, consequences, status } = {}, env = process.env) {
  const db = openDb(env);
  const target = requireScopeTarget(db, { projectId, orgId });
  const { status: resolvedStatus, statusDefaulted } = resolveSavedStatus(status);
  const row = {
    target,
    title: requireText("title", title),
    context: requireText("context", context),
    decision: requireText("decision", decision),
    consequences: optionalText(consequences),
    status: resolvedStatus,
  };
  const inserted = withWriteRetry(() => insertDecisionRow(db, row));
  return savedIdentity(target, inserted, statusDefaulted);
}

// A list of decision numbers a save names: absent means none, anything else must be positive integers.
function requireNumberList(field, value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || !value.every((number) => Number.isInteger(number) && number > 0)) {
    throw new UserError(`\`${field}\` must be a list of positive integer decision numbers, got \`${JSON.stringify(value)}\``);
  }
  return [...new Set(value)];
}

// An optional positive integer (a job id or a decision number): absent means null, anything else is refused.
function optionalPositiveInteger(field, value) {
  if (value === undefined || value === null) return null;
  if (Number.isInteger(value) && value > 0) return value;
  throw new UserError(`\`${field}\` must be a positive integer, got \`${String(value)}\``);
}

// The `YYYY-MM-DD` a decision was created on, as the timestamp SQLite stores; absent means now.
function requireCreatedAt(value) {
  if (value === undefined || value === null) return null;
  const text = typeof value === "string" ? value.trim() : "";
  const ms = CREATED_DATE.test(text) ? Date.parse(`${text}T00:00:00Z`) : Number.NaN;
  const valid = Number.isFinite(ms) && new Date(ms).toISOString().startsWith(text);
  if (!valid) throw new UserError(`\`createdAt\` must be a calendar date \`YYYY-MM-DD\`, got \`${String(value)}\``);
  return `${text} 00:00:00`;
}

// The numbers a reviewed save names, refusing one named in both lists and any supersede from inside a job.
function namedNumbers({ supersedes, unrelated, jobId }) {
  const replaced = requireNumberList("supersedes", supersedes);
  const untouched = requireNumberList("unrelated", unrelated);
  const both = replaced.filter((number) => untouched.includes(number));
  if (both.length) {
    throw new UserError(
      `decision number ${both.join(", ")} is named in both \`supersedes\` and \`unrelated\`; name each candidate in one list only`,
    );
  }
  if (replaced.length && jobId !== null) {
    throw new UserError(
      `inside ${jobRef(jobId)} \`supersedes\` is refused: superseding a decision is the operator's call; name it in \`unrelated\` only if this decision really leaves it untouched, otherwise stop and leave it to the operator`,
    );
  }
  return { replaced, untouched };
}

// Every field of a reviewed save, validated before anything is embedded or written.
function reviewedSpec(db, spec) {
  const target = requireScopeTarget(db, { projectId: spec.projectId, orgId: spec.orgId });
  const jobId = optionalPositiveInteger("jobId", spec.jobId);
  return {
    target,
    ...resolveSavedStatus(spec.status),
    title: requireText("title", spec.title),
    context: requireText("context", spec.context),
    decision: requireText("decision", spec.decision),
    consequences: optionalText(spec.consequences),
    createdAt: requireCreatedAt(spec.createdAt),
    supersededBy: optionalPositiveInteger("supersededBy", spec.supersededBy),
    jobId,
    ...namedNumbers({ supersedes: spec.supersedes, unrelated: spec.unrelated, jobId }),
  };
}

// Vector of the new decision in the shape the stored ones were embedded in; null keeps the gate lexical.
async function probeVector({ title, decision, embedder, deadlineMs }, env) {
  const resolved = await resolveEmbedder(embedder, env);
  if (!resolved) return null;
  const vector = await embedWithDeadline(resolved, decisionProbe({ title, decision }), deadlineMs);
  return vector ? { vector, model: resolved.model } : null;
}

// Refuses a second proposal from a job while its first one is still proposed.
function refuseSecondProposal(db, spec) {
  if (spec.jobId === null || spec.status !== "proposed") return;
  const first = namedRow(
    db,
    db
      .prepare("SELECT scope, project_id, org_id, number FROM decisions WHERE job_id = ? AND status = 'proposed' ORDER BY id LIMIT 1")
      .get(spec.jobId),
  );
  if (first) {
    throw new UserError(`${jobRef(spec.jobId)} already proposed decision ${decisionRef(first)}; a job proposes at most one decision`);
  }
}

// Rows of an owner by number, refusing any number that owner never used.
function rowsByNumber(db, target, numbers) {
  if (!numbers.length) return new Map();
  const rows = named(
    db,
    db
      .prepare(
        `SELECT id, scope, project_id, org_id, number, title, status FROM decisions
         WHERE ${OWNER_CLAUSE} AND number IN (${numbers.map(() => "?").join(",")})`,
      )
      .all(...ownerValues(target), ...numbers),
  );
  const byNumber = new Map(rows.map((row) => [Number(row.number), row]));
  const missing = numbers.filter((number) => !byNumber.has(number));
  if (missing.length) {
    throw new UserError(`${ownerDescription(target)} has no decision number ${missing.join(", ")}; name decisions by their \`number\``);
  }
  return byNumber;
}

// Refuses superseding a decision that already binds nothing.
function requireSupersedable(rows) {
  for (const row of rows) {
    if (GATE_STATUSES.includes(row.status)) continue;
    throw new UserError(
      `decision ${decisionRef(row)} is \`${row.status}\`: only an accepted or proposed decision can be superseded`,
    );
  }
}

// Eligible rows of the gate: the owner's accepted and proposed decisions, without text or vector.
function gateRows(db, target) {
  return named(
    db,
    db
      .prepare(`SELECT id, scope, project_id, org_id, number, title, status FROM decisions WHERE ${OWNER_CLAUSE} AND ${GATE_STATUS_CLAUSE}`)
      .all(...ownerValues(target)),
  );
}

// FTS5 expression matching a token as a prefix, in the title column only.
function titlePrefixMatch(token) {
  return `title : "${token.replaceAll('"', "")}"*`;
}

// Ids of the eligible rows whose title matches a token as a prefix.
function titleMatches(db, token, eligibleIds) {
  return db
    .prepare("SELECT rowid AS id FROM decisions_fts WHERE decisions_fts MATCH ?")
    .all(titlePrefixMatch(token))
    .map((row) => Number(row.id))
    .filter((id) => eligibleIds.has(id));
}

// How many of the given match lists each row id appears in.
function hitsById(matchLists) {
  const hits = new Map();
  for (const ids of matchLists) for (const id of ids) hits.set(id, (hits.get(id) ?? 0) + 1);
  return hits;
}

// Lexical side of the gate: eligible rows whose title matches enough of the new title's informative tokens.
function gateLexical(db, eligible, title) {
  const tokens = queryTokens(title);
  if (!tokens.length || !eligible.length) return [];
  const eligibleIds = new Set(eligible.map((row) => row.id));
  const existing = tokens.map((token) => titleMatches(db, token, eligibleIds)).filter((ids) => ids.length > 0);
  const informative = existing.filter((ids) => ids.length <= informativeCap(eligible.length));
  const useful = informative.length ? informative : existing;
  const floor = coverageFloor(useful.length, tokens.length);
  if (floor > useful.length) return [];
  const hits = hitsById(useful);
  return eligible
    .filter((row) => (hits.get(row.id) ?? 0) >= floor)
    .sort((a, b) => hits.get(b.id) - hits.get(a.id) || a.number - b.number);
}

// Semantic side of the gate: ids of the owner's accepted and proposed rows whose stored vector is close to the new decision's.
function gateSemantic(db, target, vector, model) {
  const query = toQueryVector(vector);
  if (!query || typeof model !== "string" || !model) return [];
  const rows = db
    .prepare(
      `SELECT id, embedding FROM decisions
       WHERE embedding IS NOT NULL AND embedding_model = ? AND length(embedding) = ?
         AND ${OWNER_CLAUSE} AND ${GATE_STATUS_CLAUSE}`,
    )
    .all(model, query.length * 4, ...ownerValues(target));
  return rankByCosine(rows, query, RECALL_COS_CUT, rows.length);
}

// Every decision of the owner the new one overlaps and the caller has not named yet, lexical first, deduped by id and capped.
function unnamedOverlaps(db, target, probe) {
  const eligible = gateRows(db, target);
  const byId = new Map(eligible.map((row) => [row.id, row]));
  const lexical = gateLexical(db, eligible, probe.title).map((row) => ({ ...row, via: "lexical" }));
  const semantic = gateSemantic(db, target, probe.embedded?.vector, probe.embedded?.model)
    .filter((entry) => byId.has(entry.id))
    .map((entry) => ({ ...byId.get(entry.id), via: "semantic" }));
  return firstOfEachId([...lexical, ...semantic])
    .filter((row) => !probe.reviewed.has(Number(row.number)))
    .slice(0, GATE_CANDIDATE_LIMIT);
}

// Keeps the first row of each id, in order.
function firstOfEachId(rows) {
  const byId = new Map();
  for (const row of rows) if (!byId.has(row.id)) byId.set(row.id, row);
  return [...byId.values()];
}

// Compact shape of an overlap candidate, the one a needs_review answer lists.
function candidateView(row) {
  return { id: row.id, number: row.number, label: decisionRef(row), ref: decisionRef(row), title: row.title, status: row.status, via: row.via };
}

// Marks the superseded rows as replaced by the new decision.
function markSuperseded(db, rows, successorId) {
  if (!rows.length) return;
  db.prepare(
    `UPDATE decisions SET status = 'superseded', superseded_by = ?, updated_at = datetime('now')
     WHERE id IN (${rows.map(() => "?").join(",")})`,
  ).run(successorId, ...rows.map((row) => row.id));
}

// Refuses a save from a job this database has no row for, since the decision could not record its job of origin.
function refuseUnknownJob(db, spec) {
  if (spec.jobId === null) return;
  if (db.prepare("SELECT 1 FROM jobs WHERE id = ?").get(spec.jobId)) return;
  throw new UserError(
    `job \`${spec.jobId}\` is not in the queue of this database, so a decision saved from it cannot record its job of origin; save it outside the job`,
  );
}

// The synchronous body of a reviewed save: refusals, the overlap review, the insert and the supersedes, all in one transaction.
function reviewAndInsert(db, spec, embedded) {
  refuseUnknownJob(db, spec);
  refuseSecondProposal(db, spec);
  const successor = spec.supersededBy === null ? [] : [spec.supersededBy];
  const named = rowsByNumber(db, spec.target, [...new Set([...spec.replaced, ...spec.untouched, ...successor])]);
  const replacedRows = spec.replaced.map((number) => named.get(number));
  requireSupersedable(replacedRows);
  if (GATE_STATUSES.includes(spec.status)) {
    const reviewed = new Set([...spec.replaced, ...spec.untouched]);
    const unnamed = unnamedOverlaps(db, spec.target, { title: spec.title, embedded, reviewed });
    if (unnamed.length) return { needsReview: true, candidates: unnamed.map(candidateView) };
  }
  const supersededById = spec.supersededBy === null ? null : named.get(spec.supersededBy).id;
  const inserted = insertDecisionRow(db, { ...spec, supersededById });
  markSuperseded(db, replacedRows, inserted.id);
  return {
    ...savedIdentity(spec.target, inserted, spec.statusDefaulted),
    superseded: spec.replaced,
    jobId: spec.jobId,
  };
}

// Saves a decision only once every accepted or proposed decision of its owner it overlaps is named, superseded whole or unrelated.
export async function saveReviewedDecision(spec = {}, env = process.env) {
  const db = openDb(env);
  const reviewed = reviewedSpec(db, spec ?? {});
  const gated = GATE_STATUSES.includes(reviewed.status);
  const embedded = gated ? await probeVector({ ...reviewed, embedder: spec.embedder, deadlineMs: spec.deadlineMs }, env) : null;
  return inTransaction(db, () => reviewAndInsert(db, reviewed, embedded));
}

// Requires `superseded_by` to point at another existing decision of the same owner: superseding is authorship, not visibility.
function requireSupersededBy(row, value, env) {
  const target = requireId(value);
  if (target === row.id) throw new UserError(`decision \`${row.id}\` cannot supersede itself`);
  const other = getDecision(target, env);
  if (!other) throw new UserError(`unknown decision \`${target}\``);
  if (!sameOwner(other, row)) {
    throw new UserError(`decision \`${target}\` belongs to ${ownerDescription(other)}, not ${ownerDescription(row)}`);
  }
  return target;
}

// Refuses turning a decision `superseded` when nothing names the decision that replaced it.
function requireSuccessorWhenSuperseded(status, patch, row) {
  if (status !== "superseded" || hasValue(patch, "superseded_by") || row.superseded_by) return status;
  throw new UserError(
    "a decision becomes `superseded` only by naming the decision that replaced it in `superseded_by`",
  );
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
    values.push(requireSuccessorWhenSuperseded(requireStatus(patch.status), patch, row));
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
  const db = openDb(env);
  const statement = db.prepare(
    `UPDATE decisions SET ${columns.join(", ")}, updated_at = datetime('now') WHERE id = ? RETURNING *`,
  );
  return namedRow(db, withWriteRetry(() => statement.get(...values, row.id)));
}

// Decisions an owner sees, org rows first and each in numbering order, optionally filtered by status; `db` lets a read-only caller bring its own connection.
export function listDecisions({ projectId, orgId, status } = {}, env = process.env, db = null) {
  const connection = db ?? openDb(env);
  const visible = visibility(requireScopeTarget(connection, { projectId, orgId }));
  const filter = status === undefined || status === null ? "" : " AND status = ?";
  const values = status === undefined || status === null ? [] : [requireStatus(status)];
  const rows = connection
    .prepare(`SELECT * FROM decisions WHERE ${visible.clause}${filter} ORDER BY ${ORG_FIRST}, number ASC`)
    .all(...visible.values, ...values);
  return named(connection, rows);
}

// Titles of the decisions an owner sees in one status, org rows first: no text and no vector, so every row fits a prompt.
export function decisionTitles({ projectId, orgId, status = "accepted" } = {}, env = process.env, db = null) {
  const connection = db ?? openDb(env);
  const visible = visibility(requireScopeTarget(connection, { projectId, orgId }));
  const rows = connection
    .prepare(
      `SELECT id, scope, project_id, org_id, number, title, status, job_id FROM decisions
       WHERE ${visible.clause} AND status = ? ORDER BY ${ORG_FIRST}, number ASC`,
    )
    .all(...visible.values, requireStatus(status));
  return named(connection, rows);
}

// The decisions a queue job proposed and nobody settled yet, in numbering order.
export function proposalsOfJob(jobId, env = process.env, db = null) {
  if (!Number.isInteger(jobId) || jobId <= 0) {
    throw new UserError(`expected a positive integer job id, got \`${String(jobId)}\``);
  }
  const connection = db ?? openDb(env);
  const rows = connection
    .prepare(
      `SELECT id, scope, project_id, org_id, number, title, status, job_id FROM decisions
       WHERE job_id = ? AND status = 'proposed' ORDER BY number ASC`,
    )
    .all(jobId);
  return named(connection, rows);
}

// The proposals still open on a job that is already closed, the ones nobody will settle by closing it.
export function staleProposals(env = process.env, db = null) {
  const connection = db ?? openDb(env);
  const rows = connection
    .prepare(
      `SELECT d.id, d.scope, d.project_id, d.org_id, d.number, d.title, d.job_id FROM decisions d
       JOIN jobs j ON j.id = d.job_id
       WHERE d.status = 'proposed' AND j.status = 'closed' ORDER BY d.job_id, d.number`,
    )
    .all();
  return named(connection, rows);
}

// One title line of a decisions section, the single rendering the session block and the roadmap prompt share.
export function decisionTitleLine(row) {
  const title = String(row?.title ?? "").replace(/\s+/g, " ").trim();
  return `- ${decisionRef(row)} ${escapePromptMarkers(truncateByCodePoint(title, TITLE_LINE_MAX))}`;
}

// Text a decision is embedded by: title plus the decision itself.
export function decisionProbe(decision) {
  return [decision.title, decision.decision].filter(Boolean).join(" ");
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
    ref: decisionRef(row),
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
    ref: decisionRef(row),
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
      `${decisionRef(row)} ${row.title} (${row.status})`,
      `Context: ${row.context}`,
      `Decision: ${row.decision}`,
      ...(row.consequences ? [`Consequences: ${row.consequences}`] : []),
    ].join("\n"),
  );
}

// Most recently updated accepted decisions an owner sees.
export function recentDecisions({ projectId, orgId, limit = DECISION_RECALL_LIMIT } = {}, env = process.env) {
  const db = openDb(env);
  const visible = visibility(requireScopeTarget(db, { projectId, orgId }));
  const rows = db
    .prepare(
      `SELECT * FROM decisions
       WHERE status = 'accepted' AND ${visible.clause}
       ORDER BY updated_at DESC, id DESC LIMIT ?`,
    )
    .all(...visible.values, safeLimit(limit, DECISION_RECALL_LIMIT));
  return named(db, rows);
}

// Accepted decisions an owner sees matching a query through BM25, with the project's own decisions boosted over its org's.
export function searchDecisionsLexical({ query, projectId, orgId, limit = DECISION_RECALL_LIMIT } = {}, env = process.env) {
  const match = ftsMatch(query);
  if (!match) return [];
  const db = openDb(env);
  const target = requireScopeTarget(db, { projectId, orgId });
  const visible = visibility(target, "d");
  const rows = db
    .prepare(
      `SELECT d.*, bm25(decisions_fts) AS rank
       FROM decisions_fts JOIN decisions d ON d.id = decisions_fts.rowid
       WHERE decisions_fts MATCH ? AND d.status = 'accepted' AND ${visible.clause}
       ORDER BY bm25(decisions_fts)
         + CASE WHEN d.project_id = ? THEN -1.5 WHEN d.scope = 'org' THEN -1.0 WHEN d.project_id IS NULL THEN -0.5 ELSE 0 END
       LIMIT ?`,
    )
    .all(match, ...visible.values, target.projectId, safeLimit(limit, DECISION_RECALL_LIMIT));
  return named(db, rows);
}

// Hydrates the rows that won the cosine ranking, preserving their order.
function hydrateByCosine(db, scored) {
  if (!scored.length) return [];
  const rows = db
    .prepare(`SELECT * FROM decisions WHERE id IN (${scored.map(() => "?").join(",")})`)
    .all(...scored.map((entry) => entry.id));
  const byId = new Map(named(db, rows).map((row) => [row.id, row]));
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
  { vector, model, projectId, orgId, limit = DECISION_RECALL_LIMIT, cut = RECALL_COS_CUT } = {},
  env = process.env,
) {
  const query = toQueryVector(vector);
  if (!query || typeof model !== "string" || !model) return [];
  const db = openDb(env);
  const visible = visibility(requireScopeTarget(db, { projectId, orgId }));
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
  { query, projectId, orgId, limit = DECISION_RECALL_LIMIT, embedder, deadlineMs } = {},
  env = process.env,
) {
  const owner = ownerRef(requireScopeTarget(openDb(env), { projectId, orgId }));
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
