import { UserError } from "../config/errors.mjs";
import { projectByName, projectsOfOrg } from "../config/projects.mjs";
import { loadConfig } from "../config/store.mjs";
import { openDb, sqliteToIso, withWriteRetry } from "./db.mjs";
import { getDecision, recallDecisions, renderDecisionText } from "./decisions.mjs";
import { addJob, cancelJob, truncateByCodePoint } from "./jobs.mjs";
import { escapePromptMarkers } from "./prompt-safety.mjs";
import {
  OWNER_CLAUSE,
  ownerDescription,
  ownerOf,
  ownerRef,
  ownerValues,
  requireOwnerTarget,
  requireScopeTarget,
  rowOwner,
  rowTarget,
  seesRow,
  visibility,
} from "./scope.mjs";

export const ROADMAP_HORIZONS = ["now", "next", "later"];
export const ROADMAP_STATUSES = ["open", "queued", "done", "dropped"];
export const PROMPT_SOURCE_CONFLICT =
  "pass either `prompt` or `roadmap_item_id`, never both: the roadmap item is what builds the prompt";
export const PROMPT_SOURCE_MISSING = "queue_add needs `prompt`, or `roadmap_item_id` to build it from a roadmap item";

const RELATED_RECALL_LIMIT = 4;
const RELATED_PROMPT_LIMIT = 3;
const LIVE_JOB_STATUSES = ["pending", "running", "gate"];
const MANUAL_STATUSES = ROADMAP_STATUSES.filter((status) => status !== "queued");

// Requires a non-empty text field, because the column is NOT NULL and a raw SQLite error helps nobody.
function requireText(field, value) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new UserError(`roadmap field \`${field}\` is required and cannot be empty`);
  return text;
}

// Requires a positive integer id, so a malformed reference never reaches the database.
function requireId(id) {
  if (!Number.isInteger(id) || id <= 0) {
    throw new UserError(`expected a positive integer roadmap item id, got \`${String(id)}\``);
  }
  return id;
}

// Returns the trimmed string, or null when there is nothing to store.
function optionalText(value) {
  const text = typeof value === "string" ? value.trim() : "";
  return text ? text : null;
}

// Requires one of the three horizons, naming them in the error.
function requireHorizon(horizon) {
  if (ROADMAP_HORIZONS.includes(horizon)) return horizon;
  throw new UserError(
    `invalid roadmap \`horizon\`: \`${String(horizon)}\`; expected one of ${ROADMAP_HORIZONS.join("|")}`,
  );
}

// Requires a status an operator may set by hand: `queued` is reached only through the queue.
function requireManualStatus(status) {
  if (MANUAL_STATUSES.includes(status)) return status;
  if (status === "queued") {
    throw new UserError(
      "a roadmap item only becomes `queued` through `queue_add` with `roadmap_item_id`; set it to `open`, `done` or `dropped`",
    );
  }
  throw new UserError(
    `invalid roadmap \`status\`: \`${String(status)}\`; expected one of ${MANUAL_STATUSES.join("|")}`,
  );
}

// Requires a positive integer position, because the column orders a group and has no room for a placeholder.
function requirePosition(position) {
  if (!Number.isInteger(position) || position <= 0) {
    throw new UserError(`expected a positive integer roadmap \`position\`, got \`${String(position)}\``);
  }
  return position;
}

// Tells whether a patch carries a value for a field: an explicit null is treated exactly like an absent key.
function hasValue(patch, field) {
  return patch[field] !== undefined && patch[field] !== null;
}

// Requires `decision_id` to point at a decision the item's owner sees: its own and, for a project item, its org's.
function requireDecisionId(target, value, env) {
  const id = requireId(value);
  const decision = getDecision(id, env);
  if (!decision) throw new UserError(`unknown decision \`${id}\``);
  if (!seesRow(target, decision)) {
    throw new UserError(`decision \`${id}\` belongs to ${ownerDescription(decision)}, not ${ownerDescription(target)}`);
  }
  return id;
}

// Undoes a failed transaction without ever masking the error that caused it.
function rollbackQuietly(db) {
  try {
    db.exec("ROLLBACK");
  } catch {
    return;
  }
}

// Runs the given steps inside one immediate transaction, so no reader is ever promoted to writer.
function inTransaction(db, steps) {
  return withWriteRetry(() => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const value = steps();
      db.exec("COMMIT");
      return value;
    } catch (err) {
      rollbackQuietly(db);
      throw err;
    }
  });
}

// Returns the raw row of a roadmap item, or null.
export function getRoadmapItem(id, env = process.env) {
  return openDb(env).prepare("SELECT * FROM roadmap_items WHERE id = ?").get(requireId(id)) ?? null;
}

// The columns and joins every read that carries a linked decision number and live job status shares.
const ROADMAP_ITEM_VIEW_QUERY = `SELECT r.*, d.number AS decision_number, j.status AS job_status
       FROM roadmap_items r
       LEFT JOIN decisions d ON d.id = r.decision_id
       LEFT JOIN jobs j ON j.id = r.job_id`;

// Returns the joined row of a roadmap item — its linked decision number and live job status included — or null.
function getRoadmapItemJoined(id, env = process.env) {
  return openDb(env).prepare(`${ROADMAP_ITEM_VIEW_QUERY} WHERE r.id = ?`).get(requireId(id)) ?? null;
}

// Inserts a roadmap item at the end of its horizon group, in one statement so no concurrent save collides.
export function saveRoadmapItem({ project, org, horizon, title, detail, decision_id } = {}, env = process.env) {
  const target = requireScopeTarget({ project, org }, env);
  const owner = ownerValues(target);
  const group = requireHorizon(horizon);
  const values = [
    ...owner,
    group,
    requireText("title", title),
    optionalText(detail),
    decision_id === undefined || decision_id === null ? null : requireDecisionId(target, decision_id, env),
    ...owner,
    group,
  ];
  const statement = openDb(env).prepare(
    `INSERT INTO roadmap_items (scope, project, org, horizon, title, detail, decision_id, position)
     VALUES (?, ?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(position), 0) + 1 FROM roadmap_items WHERE ${OWNER_CLAUSE} AND horizon = ?))
     RETURNING id, position`,
  );
  const row = withWriteRetry(() => statement.get(...values));
  const [scope, projectName, orgName] = owner;
  return { id: Number(row.id), position: Number(row.position), scope, project: projectName, org: orgName };
}

// Renumbers a horizon group of one owner to contiguous positions 1..N, ordered by the positions it currently holds.
function renumberGroup(db, owner, horizon) {
  db.prepare(
    `WITH ordered AS (
       SELECT id, ROW_NUMBER() OVER (ORDER BY position, id) AS rn
       FROM roadmap_items WHERE ${OWNER_CLAUSE} AND horizon = ?
     )
     UPDATE roadmap_items SET position = (SELECT rn FROM ordered WHERE ordered.id = roadmap_items.id)
     WHERE id IN (SELECT id FROM ordered)`,
  ).run(...ownerValues(owner), horizon);
}

// How many items a horizon group of one owner holds.
function countGroup(db, owner, horizon) {
  return db
    .prepare(`SELECT COUNT(*) AS total FROM roadmap_items WHERE ${OWNER_CLAUSE} AND horizon = ?`)
    .get(...ownerValues(owner), horizon).total;
}

// Position the move aims at: the asked one clamped to the group, or the end of the destination horizon.
function targetPosition(row, patch, { sameHorizon, size }) {
  const max = Math.max(1, sameHorizon ? size : size + 1);
  const wanted = hasValue(patch, "position") ? requirePosition(patch.position) : sameHorizon ? row.position : max;
  return Math.min(Math.max(wanted, 1), max);
}

// Moves an item to a horizon and a position, renumbering every affected group inside one transaction.
function moveRoadmapItem(row, patch, env) {
  const db = openDb(env);
  const horizon = hasValue(patch, "horizon") ? requireHorizon(patch.horizon) : row.horizon;
  const write = db.prepare(
    "UPDATE roadmap_items SET horizon = ?, position = ?, updated_at = datetime('now') WHERE id = ?",
  );
  const owner = rowOwner(row);
  inTransaction(db, () => {
    const sameHorizon = horizon === row.horizon;
    const wanted = targetPosition(row, patch, { sameHorizon, size: countGroup(db, owner, horizon) });
    const tentative = sameHorizon && wanted > row.position ? wanted + 0.5 : wanted - 0.5;
    write.run(horizon, tentative, row.id);
    renumberGroup(db, owner, horizon);
    if (!sameHorizon) renumberGroup(db, owner, row.horizon);
  });
}

// Column assignments of an update patch, validating every present field the way the insert does.
function updateAssignments(patch, row, env) {
  const columns = [];
  const values = [];
  if (hasValue(patch, "title")) {
    columns.push("title = ?");
    values.push(requireText("title", patch.title));
  }
  if (hasValue(patch, "detail")) {
    columns.push("detail = ?");
    values.push(optionalText(patch.detail));
  }
  if (hasValue(patch, "status")) {
    columns.push("status = ?");
    values.push(requireManualStatus(patch.status));
  }
  if (hasValue(patch, "decision_id")) {
    columns.push("decision_id = ?");
    values.push(requireDecisionId(rowTarget(row, env), patch.decision_id, env));
  }
  return { columns, values };
}

// Updates the fields present in the patch and returns the stored row; `horizon` or `position` also renumbers.
export function updateRoadmapItem(id, patch = {}, env = process.env) {
  const row = getRoadmapItem(id, env);
  if (!row) throw new UserError(`unknown roadmap item \`${id}\``);
  const changes = patch ?? {};
  const { columns, values } = updateAssignments(changes, row, env);
  if (columns.length) {
    const statement = openDb(env).prepare(
      `UPDATE roadmap_items SET ${columns.join(", ")}, updated_at = datetime('now') WHERE id = ?`,
    );
    withWriteRetry(() => statement.run(...values, row.id));
  }
  if (hasValue(changes, "horizon") || hasValue(changes, "position")) moveRoadmapItem(row, changes, env);
  return getRoadmapItemJoined(row.id, env);
}

// Public shape of a roadmap item: free text truncated like the queue views truncate it.
export function roadmapItemView(row) {
  return {
    id: row.id,
    scope: row.scope,
    owner: ownerOf(row),
    title: truncateByCodePoint(row.title),
    detail: truncateByCodePoint(row.detail ?? null),
    status: row.status,
    position: row.position,
    horizon: row.horizon,
    decision_number: row.decision_number ?? null,
    job_id: row.job_id ?? null,
    job_status: row.job_status ?? null,
    updated_at: sqliteToIso(row.updated_at),
  };
}

// Items of one horizon an owner sees, org items first, each carrying its linked decision number and the live job status.
function horizonItems(db, target, horizon) {
  const visible = visibility(target, "r");
  return db
    .prepare(
      `${ROADMAP_ITEM_VIEW_QUERY}
       WHERE ${visible.clause} AND r.horizon = ?
       ORDER BY CASE WHEN r.scope = 'org' THEN 0 ELSE 1 END, r.position ASC, r.id ASC`,
    )
    .all(...visible.values, horizon)
    .map(roadmapItemView);
}

// The roadmap of an owner with nothing planned: the three horizons, always present and always empty.
export function emptyRoadmap(owner = {}) {
  return { ...owner, horizons: ROADMAP_HORIZONS.map((horizon) => ({ horizon, items: [] })) };
}

// The whole roadmap an owner sees: the three horizons, always in the now/next/later order; `db` lets a read-only caller bring its own connection.
export function listRoadmap(owner, env = process.env, db = null) {
  const connection = db ?? openDb(env);
  const target = requireOwnerTarget(owner, env);
  return {
    ...ownerRef(target),
    horizons: ROADMAP_HORIZONS.map((horizon) => ({ horizon, items: horizonItems(connection, target, horizon) })),
  };
}

// The job still holding a roadmap item, or null when its link is history.
function liveJobOf(row, env) {
  if (!row.job_id) return null;
  return (
    openDb(env)
      .prepare(
        `SELECT id, status FROM jobs WHERE id = ? AND status IN (${LIVE_JOB_STATUSES.map(() => "?").join(", ")})`,
      )
      .get(row.job_id, ...LIVE_JOB_STATUSES) ?? null
  );
}

// Returns the item a queue_add may build a job from, or explains why queueing it is refused.
export function queueableRoadmapItem(id, env = process.env) {
  const row = getRoadmapItem(id, env);
  if (!row) throw new UserError(`unknown roadmap item \`${id}\``);
  if (row.status === "done" || row.status === "dropped") {
    throw new UserError(
      `roadmap item \`${row.id}\` is \`${row.status}\`; set it back to \`open\` with \`roadmap_update\` before queueing it`,
    );
  }
  const live = liveJobOf(row, env);
  if (live) {
    throw new UserError(
      `roadmap item \`${row.id}\` is already queued as job \`${live.id}\` (\`${live.status}\`); cancel that job first`,
    );
  }
  return row;
}

// Links a roadmap item to the job built from it; false means a concurrent caller queued it first.
export function markRoadmapItemQueued(id, jobId, env = process.env) {
  const statement = openDb(env).prepare(
    `UPDATE roadmap_items SET status = 'queued', job_id = ?, updated_at = datetime('now')
      WHERE id = ? AND status IN ('open', 'queued')
        AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.id = roadmap_items.job_id AND j.status IN ('pending', 'running', 'gate'))`,
  );
  const changed = withWriteRetry(() => statement.run(requireId(jobId), requireId(id)));
  return changed.changes === 1;
}

// Accepted decisions worth quoting next to an item; a row marked `fallback` did not match the title and is dropped.
async function relatedDecisions(item, linked, embedder, env) {
  try {
    const rows = await recallDecisions(
      { ...ownerRef(rowOwner(item)), query: item.title, limit: RELATED_RECALL_LIMIT, embedder },
      env,
    );
    return rows
      .filter((row) => row.via !== "fallback" && row.id !== linked?.id)
      .slice(0, RELATED_PROMPT_LIMIT);
  } catch {
    return [];
  }
}

// Prompt a roadmap item is queued with: the task, the decision it is linked to and the accepted decisions around it.
export async function buildRoadmapPrompt({ item, embedder } = {}, env = process.env) {
  const linked = item.decision_id ? getDecision(item.decision_id, env) : null;
  const related = await relatedDecisions(item, linked, embedder, env);
  const blocks = [`## Task\n${escapePromptMarkers(item.title)}`];
  if (item.detail) blocks.push(escapePromptMarkers(item.detail));
  if (linked) blocks.push(`## Linked decision\n${renderDecisionText(linked)}`);
  if (related.length) blocks.push(`## Related decisions\n${related.map(renderDecisionText).join("\n\n")}`);
  return blocks.join("\n\n");
}

// Refuses a project that is not the item's own, because a project item is what decides where its job goes.
function requireItemProject(item, project) {
  if (project === undefined || project === null || project === item.project) return;
  throw new UserError(
    `roadmap item \`${item.id}\` belongs to project \`${item.project}\`, not \`${project}\`; queue it by its id alone`,
  );
}

// Requires the target project of an org item to be a registered project of that org, because a job is always a project's.
function requireOrgMember(item, project, env) {
  const config = loadConfig(env, { warn: () => {} });
  const named = typeof project === "string" && project.trim() ? projectByName(config, project.trim()) : null;
  if (named && named.org === item.org) return named.name;
  const members = projectsOfOrg(config, item.org);
  throw new UserError(
    `roadmap item \`${item.id}\` belongs to org \`${item.org}\`: name the project its job goes to with \`--project <name>\` ` +
      `(\`project\` in queue_add); projects of \`${item.org}\`: ${members.length ? members.join(", ") : "(none)"}`,
  );
}

// Queues the job an org item builds for one project of its org, leaving the item open: one item fathers a job per project.
async function queueOrgItem(item, { project, priority, maxAttempts, timeoutS, tier, embedder }, env) {
  const targetProject = requireOrgMember(item, project, env);
  const prompt = await buildRoadmapPrompt({ item, embedder }, env);
  const job = addJob({ project: targetProject, prompt, priority, maxAttempts, timeoutS, tier }, env);
  return { job, item, targetProject };
}

// Queues the job a roadmap item builds; a project item is linked to that job, an org item names the project it goes to.
export async function queueRoadmapItem(
  { id, project, priority, maxAttempts, timeoutS, tier, embedder } = {},
  env = process.env,
) {
  const item = queueableRoadmapItem(id, env);
  if (item.scope === "org") {
    return await queueOrgItem(item, { project, priority, maxAttempts, timeoutS, tier, embedder }, env);
  }
  requireItemProject(item, project);
  const prompt = await buildRoadmapPrompt({ item, embedder }, env);
  const job = addJob({ project: item.project, prompt, priority, maxAttempts, timeoutS, tier }, env);
  if (markRoadmapItemQueued(item.id, job.id, env)) return { job, item, targetProject: item.project };
  cancelJob(job.id, { reason: "roadmap item was queued by another caller" }, env);
  throw new UserError(
    `roadmap item \`${item.id}\` was queued by another caller; job \`${job.id}\` was cancelled and nothing else changed`,
  );
}

// Closes the roadmap item a finished job came from; an item nobody queued is left alone.
export function markRoadmapItemDone(jobId, env = process.env) {
  const statement = openDb(env).prepare(
    "UPDATE roadmap_items SET status = 'done', updated_at = datetime('now') WHERE job_id = ? AND status = 'queued'",
  );
  const changed = withWriteRetry(() => statement.run(requireId(jobId)));
  return changed.changes;
}
