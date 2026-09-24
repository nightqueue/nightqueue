import { UserError } from "../config/errors.mjs";
import { ALL_PROJECTS, projectByName, projectsOfOrg } from "../config/projects.mjs";
import { loadConfig } from "../config/store.mjs";
import { inTransaction, openDb, sqliteToIso, withWriteRetry } from "./db.mjs";
import {
  PROPOSED_HEADING,
  STANDING_HEADING,
  decisionTitleLine,
  decisionTitles,
  getDecision,
  recallDecisions,
  renderDecisionText,
} from "./decisions.mjs";
import { PRIORITY_RANGE, addJob, cancelJob, truncateByCodePoint } from "./jobs.mjs";
import { escapePromptMarkers } from "./prompt-safety.mjs";
import { COMMENT_JOB_COLUMNS, insertComment, jobRefs, listComments } from "./roadmap-comments.mjs";
import {
  cancelOpenRows,
  closesOrgItem,
  driftedRowJobIds,
  followJobRows,
  linkOrgRow,
  liveRowJob,
  orgItemOfJob,
  projectRowsByItem,
  projectRowsDrift,
} from "./roadmap-projects.mjs";
import {
  CLOSED_STATUSES,
  COMMIT_TYPE_BY_TYPE,
  HORIZON_REMOVED,
  JOB_TO_ROADMAP,
  LIVE_JOB_STATUSES,
  MANUAL_STATUSES,
  OPEN_STATUSES,
  OPERATOR_AUTHOR,
  ROADMAP_STATUSES,
  ROADMAP_TYPES,
  STATUS_ASSIGNMENT,
  TIER_BY_TYPE,
  commentFor,
  followThroughCloseSource,
  isCommentAuthor,
  isReopening,
  jobEvent,
  resultField,
  roadmapTransition,
  sqlList,
  statusRankSql,
} from "./roadmap-workflow.mjs";
import {
  OWNER_CLAUSE,
  ownerDescription,
  ownerOf,
  ownerRef,
  ownerValues,
  projectScope,
  requireOwnerTarget,
  requireScopeTarget,
  rowOwner,
  rowTarget,
  seesRow,
  visibility,
} from "./scope.mjs";

export { MANUAL_STATUSES, ROADMAP_STATUSES, ROADMAP_TYPES } from "./roadmap-workflow.mjs";
export const PROMPT_SOURCE_CONFLICT =
  "pass either `prompt` or `roadmap_item_id`, never both: the roadmap item is what builds the prompt";
export const PROMPT_SOURCE_MISSING = "queue_add needs `prompt`, or `roadmap_item_id` to build it from a roadmap item";

export { ALL_PROJECTS };

const RELATED_RECALL_LIMIT = 9;
const RELATED_PROMPT_LIMIT = 8;
const LIVE_JOB_LIST = sqlList(LIVE_JOB_STATUSES);

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

// Refuses the retired `horizon` field by name, so a caller of an older contract learns what replaced it.
function refuseHorizon(fields) {
  if (fields?.horizon !== undefined) throw new UserError(HORIZON_REMOVED);
}

// Requires a priority in the job range (1 runs first), naming the range in the error.
function requirePriority(priority) {
  if (Number.isInteger(priority) && priority >= PRIORITY_RANGE.min && priority <= PRIORITY_RANGE.max) return priority;
  throw new UserError(
    `invalid roadmap \`priority\`: \`${String(priority)}\`; expected an integer ${PRIORITY_RANGE.min}-${PRIORITY_RANGE.max} (${PRIORITY_RANGE.min} first, like a job's)`,
  );
}

// Requires a status an operator may set by hand: `in_progress` is reached only through a job.
function requireManualStatus(status) {
  if (MANUAL_STATUSES.includes(status)) return status;
  if (status === "in_progress") {
    throw new UserError(
      "`in_progress` is set only by a job: queue the item with `queue_add` and `roadmap_item_id`",
    );
  }
  throw new UserError(
    `invalid roadmap \`status\`: \`${String(status)}\`; expected one of ${MANUAL_STATUSES.join("|")}`,
  );
}

// Requires one of the five item types, naming them all in the error.
function requireType(type) {
  if (ROADMAP_TYPES.includes(type)) return type;
  throw new UserError(`roadmap field \`type\` is required: expected one of ${ROADMAP_TYPES.join("|")}, got \`${String(type)}\``);
}

// Requires a comment author: `operator`, or `job:<id>` for a job.
function requireAuthor(author) {
  if (isCommentAuthor(author)) return author;
  throw new UserError(`invalid roadmap comment author \`${String(author)}\`; expected \`${OPERATOR_AUTHOR}\` or \`job:<id>\``);
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

// Inserts a roadmap item at the end of its priority group, in one statement so no concurrent save collides.
export function saveRoadmapItem(
  { project, org, title, detail, decision_id, priority, status, type, ...rest } = {},
  env = process.env,
) {
  refuseHorizon(rest);
  const kind = requireType(type);
  const target = requireScopeTarget({ project, org }, env);
  const owner = ownerValues(target);
  const group = priority === undefined || priority === null ? PRIORITY_RANGE.fallback : requirePriority(priority);
  const state = status === undefined || status === null ? "todo" : requireManualStatus(status);
  const values = [
    ...owner,
    group,
    kind,
    state,
    state,
    requireText("title", title),
    optionalText(detail),
    decision_id === undefined || decision_id === null ? null : requireDecisionId(target, decision_id, env),
    ...owner,
    group,
  ];
  const statement = openDb(env).prepare(
    `INSERT INTO roadmap_items (scope, project, org, priority, type, status, closed_at, title, detail, decision_id, position)
     VALUES (?, ?, ?, ?, ?, ?, CASE WHEN ? = 'done' THEN datetime('now') END, ?, ?, ?,
             (SELECT COALESCE(MAX(position), 0) + 1 FROM roadmap_items WHERE ${OWNER_CLAUSE} AND priority = ?))
     RETURNING id, position`,
  );
  const row = withWriteRetry(() => statement.get(...values));
  const [scope, projectName, orgName] = owner;
  return {
    id: Number(row.id),
    position: Number(row.position),
    priority: group,
    type: kind,
    status: state,
    scope,
    project: projectName,
    org: orgName,
  };
}

// Renumbers a priority group of one owner to contiguous positions 1..N, ordered by the positions it currently holds.
function renumberGroup(db, owner, priority) {
  db.prepare(
    `WITH ordered AS (
       SELECT id, ROW_NUMBER() OVER (ORDER BY position, id) AS rn
       FROM roadmap_items WHERE ${OWNER_CLAUSE} AND priority = ?
     )
     UPDATE roadmap_items SET position = (SELECT rn FROM ordered WHERE ordered.id = roadmap_items.id)
     WHERE id IN (SELECT id FROM ordered)`,
  ).run(...ownerValues(owner), priority);
}

// How many items a priority group of one owner holds.
function countGroup(db, owner, priority) {
  return db
    .prepare(`SELECT COUNT(*) AS total FROM roadmap_items WHERE ${OWNER_CLAUSE} AND priority = ?`)
    .get(...ownerValues(owner), priority).total;
}

// Position the move aims at: the asked one clamped to the group, or the end of the destination priority group.
function targetPosition(row, patch, { sameGroup, size }) {
  const max = Math.max(1, sameGroup ? size : size + 1);
  const wanted = hasValue(patch, "position") ? requirePosition(patch.position) : sameGroup ? row.position : max;
  return Math.min(Math.max(wanted, 1), max);
}

// Moves an item to a priority and a position, renumbering every affected group inside one transaction.
function moveRoadmapItem(row, patch, env) {
  const db = openDb(env);
  const priority = hasValue(patch, "priority") ? requirePriority(patch.priority) : row.priority;
  const write = db.prepare(
    "UPDATE roadmap_items SET priority = ?, position = ?, updated_at = datetime('now') WHERE id = ?",
  );
  const owner = rowOwner(row);
  inTransaction(db, () => {
    const sameGroup = priority === row.priority;
    const wanted = targetPosition(row, patch, { sameGroup, size: countGroup(db, owner, priority) });
    const tentative = sameGroup && wanted > row.position ? wanted + 0.5 : wanted - 0.5;
    write.run(priority, tentative, row.id);
    renumberGroup(db, owner, priority);
    if (!sameGroup) renumberGroup(db, owner, row.priority);
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
    const status = requireManualStatus(patch.status);
    columns.push(STATUS_ASSIGNMENT);
    values.push(status, status);
  }
  if (hasValue(patch, "type")) {
    columns.push("type = ?");
    values.push(requireType(patch.type));
  }
  if (hasValue(patch, "decision_id")) {
    columns.push("decision_id = ?");
    values.push(requireDecisionId(rowTarget(row, env), patch.decision_id, env));
  }
  return { columns, values };
}

// Writes the columns of an update, in one transaction with what the new status implies: closing an org item cancels its
// open project rows, and going back from review or done leaves the `reopened` comment.
function writeUpdate(row, { columns, values, status, author }, env) {
  const db = openDb(env);
  const statement = db.prepare(`UPDATE roadmap_items SET ${columns.join(", ")}, updated_at = datetime('now') WHERE id = ?`);
  inTransaction(db, () => {
    const before = db.prepare("SELECT status FROM roadmap_items WHERE id = ?").get(row.id)?.status ?? null;
    statement.run(...values, row.id);
    if (closesOrgItem(row, status)) cancelOpenRows(db, { itemId: row.id, status, author });
    if (status === null || !isReopening(before, status)) return;
    const body = author === OPERATOR_AUTHOR ? "reopened by operator" : `reopened by ${author}`;
    insertComment(db, { itemId: row.id, kind: "reopened", author, body });
  });
}

// Updates the fields present in the patch and returns the stored row; `priority` or `position` also renumbers, and
// `author` (the operator by default) signs the comment a move back from review or done leaves.
export function updateRoadmapItem(id, patch = {}, env = process.env) {
  const changes = patch ?? {};
  refuseHorizon(changes);
  const row = getRoadmapItem(id, env);
  if (!row) throw new UserError(`unknown roadmap item \`${id}\``);
  if (hasValue(changes, "priority")) requirePriority(changes.priority);
  const author = hasValue(changes, "author") ? requireAuthor(changes.author) : OPERATOR_AUTHOR;
  const { columns, values } = updateAssignments(changes, row, env);
  if (columns.length) {
    const status = hasValue(changes, "status") ? changes.status : null;
    writeUpdate(row, { columns, values, status, author }, env);
  }
  if (hasValue(changes, "priority") || hasValue(changes, "position")) moveRoadmapItem(row, changes, env);
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
    priority: row.priority,
    type: row.type,
    position: row.position,
    decision_number: row.decision_number ?? null,
    job_id: row.job_id ?? null,
    job_status: row.job_status ?? null,
    closed_at: sqliteToIso(row.closed_at ?? null),
    updated_at: sqliteToIso(row.updated_at),
  };
}

// The values a listing filter keeps, each validated; an absent list keeps everything.
function filterValues(field, list, { isValid, expected }) {
  if (list === undefined || list === null) return [];
  const values = Array.isArray(list) ? list : [list];
  const invalid = values.find((value) => !isValid(value));
  if (invalid !== undefined) {
    throw new UserError(`invalid roadmap \`${field}\` filter \`${String(invalid)}\`; expected ${expected}`);
  }
  return values;
}

// The SQL of the opt-in status, priority and type filters of a listing, and the values it binds.
function listFilterSql({ status, priority, type } = {}) {
  const statuses = filterValues("status", status, {
    isValid: (value) => ROADMAP_STATUSES.includes(value),
    expected: ROADMAP_STATUSES.join("|"),
  });
  const priorities = filterValues("priority", priority, {
    isValid: (value) => Number.isInteger(value) && value >= PRIORITY_RANGE.min && value <= PRIORITY_RANGE.max,
    expected: `an integer ${PRIORITY_RANGE.min}-${PRIORITY_RANGE.max}`,
  });
  const types = filterValues("type", type, { isValid: (value) => ROADMAP_TYPES.includes(value), expected: ROADMAP_TYPES.join("|") });
  const inClause = (column, values) => (values.length ? ` AND ${column} IN (${values.map(() => "?").join(", ")})` : "");
  return {
    sql: `${inClause("r.status", statuses)}${inClause("r.priority", priorities)}${inClause("r.type", types)}`,
    values: [...statuses, ...priorities, ...types],
  };
}

// The roadmap of an owner with nothing planned.
export function emptyRoadmap(owner = {}) {
  return { ...owner, items: [] };
}

// Every item an owner sees, in workflow order, then org items first, then by priority (1 first) and position; `db` lets a read-only caller bring its own connection.
export function listRoadmap(owner, filters = {}, env = process.env, db = null) {
  const connection = db ?? openDb(env);
  const target = requireOwnerTarget(owner, env);
  const visible = visibility(target, "r");
  const filter = listFilterSql(filters ?? {});
  const items = connection
    .prepare(
      `${ROADMAP_ITEM_VIEW_QUERY}
       WHERE ${visible.clause}${filter.sql}
       ORDER BY ${statusRankSql("r.status")}, CASE WHEN r.scope = 'org' THEN 0 ELSE 1 END,
                r.priority ASC, r.position ASC, r.id ASC`,
    )
    .all(...visible.values, ...filter.values)
    .map(roadmapItemView);
  return { ...ownerRef(target), items: withProjectRows(connection, target, items) };
}

// The org items of a listing with their project rows: a project reads only its own row's status, an org reads the whole matrix.
function withProjectRows(db, target, items) {
  const orgIds = items.filter((item) => item.scope === "org").map((item) => item.id);
  const matrix = target.scope === "org";
  const rows = projectRowsByItem(db, orgIds, matrix ? null : (target.project ?? ""));
  return items.map((item) => {
    if (item.scope !== "org") return item;
    const own = rows.get(item.id) ?? [];
    return matrix ? { ...item, projects: own } : { ...item, project_status: own[0]?.status ?? null };
  });
}

// The job still holding a roadmap item, or null when its link is history.
function liveJobOf(row, env) {
  if (!row.job_id) return null;
  return (
    openDb(env)
      .prepare(`SELECT id, status FROM jobs WHERE id = ? AND status IN (${LIVE_JOB_LIST})`)
      .get(row.job_id) ?? null
  );
}

// Returns the item a queue_add may build a job from, or explains why queueing it is refused.
export function queueableRoadmapItem(id, env = process.env) {
  const row = getRoadmapItem(id, env);
  if (!row) throw new UserError(`unknown roadmap item \`${id}\``);
  if (CLOSED_STATUSES.includes(row.status)) {
    throw new UserError(
      `roadmap item \`${row.id}\` is \`${row.status}\`; move it back to \`todo\` with \`roadmap_update\` before queueing it`,
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

// Links a roadmap item to the job built from it, moves it to `in_progress` and leaves the `queued` comment, in one
// transaction; false means a concurrent caller queued it first.
export function linkRoadmapItemJob(id, jobId, env = process.env) {
  const db = openDb(env);
  const itemId = requireId(id);
  const job = { id: requireId(jobId) };
  const statement = db.prepare(
    `UPDATE roadmap_items SET status = ?, job_id = ?, job_status_seen = 'pending', closed_at = NULL, updated_at = datetime('now')
      WHERE id = ? AND status IN (${sqlList(OPEN_STATUSES)})
        AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.id = roadmap_items.job_id AND j.status IN (${LIVE_JOB_LIST}))`,
  );
  return inTransaction(db, () => {
    if (statement.run(JOB_TO_ROADMAP.queued.status, job.id, itemId).changes !== 1) return false;
    insertComment(db, { itemId, ...commentFor(job, "queued", jobRefs(db, job)) });
    return true;
  });
}

// Applies to one linked item what its job's current row means, replaying first the `done` a missed follow of a close skipped.
function followLinkedItem(db, item, job) {
  return followThroughCloseSource({ target: item, job, apply: (target, row) => applyJobRowToItem(db, target, row) });
}

// Applies to one linked item what the given row of its job means and leaves the event's comment, recording the job status it now reflects.
function applyJobRowToItem(db, item, job) {
  const event = jobEvent(job, item.job_status_seen);
  const { status } = roadmapTransition(job, item.job_status_seen);
  db.prepare("UPDATE roadmap_items SET job_status_seen = ? WHERE id = ?").run(job.status, item.id);
  const comment = commentFor(job, event, jobRefs(db, job));
  if (comment) insertComment(db, { itemId: item.id, ...comment });
  if (status === null || status === item.status) return false;
  db.prepare(`UPDATE roadmap_items SET ${STATUS_ASSIGNMENT}, updated_at = datetime('now') WHERE id = ?`).run(status, status, item.id);
  return true;
}

// The job's row as the roadmap reads it, or null when the job does not exist.
function jobRowOf(db, id) {
  return db.prepare(`SELECT ${COMMENT_JOB_COLUMNS} FROM jobs WHERE id = ?`).get(id) ?? null;
}

// Brings every item and project row linked to a job in line with the given row of the job, inside the caller's transaction.
function followJobRow(db, job) {
  const items = db
    .prepare("SELECT id, status, job_status_seen FROM roadmap_items WHERE job_id = ? AND job_status_seen IS NOT ?")
    .all(job.id, job.status);
  let moved = 0;
  for (const item of items) if (followLinkedItem(db, item, job)) moved += 1;
  return moved + followJobRows(db, job);
}

// Brings every item linked to a job in line with the job's current row, in one transaction; it returns how many items moved.
export function followJob(jobId, env = process.env) {
  const id = requireId(jobId);
  const db = openDb(env);
  return inTransaction(db, () => {
    const job = jobRowOf(db, id);
    return job ? followJobRow(db, job) : 0;
  });
}

// Follows first the status a write recorded it moved the job out of, then the job's current row, so that status leaves its event.
function followPassedStatus(db, id, fromKey) {
  const job = jobRowOf(db, id);
  if (!job) return;
  const from = resultField(job.result, fromKey);
  if (typeof from === "string" && from !== job.status) followJobRow(db, { ...job, status: from });
  followJobRow(db, job);
}

// Runs a follow inside a savepoint, so a follow that fails is undone alone and never costs the write around it.
function followQuietlyIn(db, follow) {
  db.exec("SAVEPOINT roadmap_follow");
  try {
    follow();
  } catch {
    db.exec("ROLLBACK TO roadmap_follow");
  }
  db.exec("RELEASE roadmap_follow");
}

// Runs a synchronous job write that records in `result[fromKey]` the status it moved the job out of, and follows that status
// and the new row in the same transaction, so a follow racing the write can never skip the status it left; a refused write
// throws and writes nothing.
export function followJobWrite({ jobId, write, fromKey }, env = process.env) {
  const id = requireId(jobId);
  const db = openDb(env);
  return inTransaction(db, () => {
    const written = write();
    followQuietlyIn(db, () => followPassedStatus(db, id, fromKey));
    return written;
  });
}

// Follows every job whose linked items or project rows have not seen its current status yet, the repair of a missed
// event; it returns how many items and rows moved.
export function followDriftedJobs(env = process.env) {
  const db = openDb(env);
  const itemJobIds = db
    .prepare(
      `SELECT DISTINCT r.job_id AS id FROM roadmap_items r JOIN jobs j ON j.id = r.job_id
        WHERE r.job_status_seen IS NOT j.status`,
    )
    .all()
    .map((row) => row.id);
  const jobIds = new Set([...itemJobIds, ...driftedRowJobIds(db)]);
  return [...jobIds].reduce((moved, jobId) => moved + followJob(jobId, env), 0);
}

// The linked items and project rows whose status disagrees with what their job's current row means, and the org items
// whose status disagrees with the one their rows derive, read without writing anything.
export function roadmapDrift(env = process.env, db = null) {
  const connection = db ?? openDb(env);
  return [...linkedItemDrift(connection), ...projectRowsDrift(connection)];
}

// The linked items whose status disagrees with what their job's current row means.
function linkedItemDrift(connection) {
  return connection
    .prepare(
      `SELECT r.id, r.scope, r.project, r.org, r.status, r.job_id, r.job_status_seen,
              j.status AS job_status, j.result
         FROM roadmap_items r JOIN jobs j ON j.id = r.job_id
        WHERE r.job_status_seen IS NOT j.status
        ORDER BY r.id`,
    )
    .all()
    .map((row) => ({ row, expected: roadmapTransition({ ...row, status: row.job_status }, row.job_status_seen).status }))
    .filter(({ row, expected }) => expected !== null && expected !== row.status)
    .map(({ row, expected }) => ({
      id: row.id,
      scope: row.scope,
      owner: ownerOf(row),
      status: row.status,
      expected,
      job_id: row.job_id,
      job_status: row.job_status,
    }));
}

// Refuses an item a project viewer does not see: its own project's and its org's only; no viewer is the operator, who sees them all.
function requireVisibleTo(row, viewer, env) {
  if (viewer === null || seesRow(projectScope(viewer, env), row)) return;
  throw new UserError(`roadmap item \`${row.id}\` belongs to ${ownerDescription(row)}, not project \`${viewer}\``);
}

// The reference of an item the way a pull request or a prompt quotes it: `<owner>#<id>`.
export function roadmapRef(row) {
  return `${ownerOf(row)}#${row.id}`;
}

// One item with its text untruncated and its comment thread in chronological order; a project `viewer` reads only what
// its project sees, and `db` lets a read-only caller bring its own connection.
export function getRoadmapItemDetail(id, { viewer = null } = {}, env = process.env, db = null) {
  const connection = db ?? openDb(env);
  const row = connection.prepare(`${ROADMAP_ITEM_VIEW_QUERY} WHERE r.id = ?`).get(requireId(id));
  if (!row) throw new UserError(`unknown roadmap item \`${id}\``);
  requireVisibleTo(row, viewer, env);
  const detail = {
    ...roadmapItemView(row),
    ref: roadmapRef(row),
    title: row.title,
    detail: row.detail ?? null,
    comments: listComments(connection, row.id, viewer),
  };
  if (row.scope !== "org") return detail;
  return { ...detail, projects: projectRowsByItem(connection, [row.id], viewer).get(row.id) };
}

// Appends a `note` to an item's thread, signed by `author`; a project `viewer` (a job's project) may only comment an item it sees, and owns its comment.
export function addRoadmapComment({ id, body, author = OPERATOR_AUTHOR, viewer = null } = {}, env = process.env) {
  const signer = requireAuthor(author);
  const text = requireText("body", body);
  const row = getRoadmapItem(id, env);
  if (!row) throw new UserError(`unknown roadmap item \`${id}\``);
  requireVisibleTo(row, viewer, env);
  const db = openDb(env);
  return withWriteRetry(() => insertComment(db, { itemId: row.id, kind: "note", author: signer, body: text, project: viewer }));
}

// The reference of the item a job was queued from — a project item it is linked to, or an org item through its project
// row — or null when the job carries no roadmap item.
export function roadmapRefOfJob(jobId, env = process.env) {
  const db = openDb(env);
  const id = requireId(jobId);
  const row =
    db.prepare("SELECT id, scope, project, org FROM roadmap_items WHERE job_id = ? ORDER BY id DESC LIMIT 1").get(id) ??
    orgItemOfJob(db, id);
  return row ? roadmapRef(row) : null;
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

// Every title of one status the item's owner sees; a failure of the decisions store costs the block, never the prompt.
function titlesOfStatus(item, status, env) {
  try {
    return decisionTitles({ ...ownerRef(rowOwner(item)), status }, env);
  } catch {
    return [];
  }
}

// One titles-only block of the prompt, or null when there is no title to list.
function titlesBlock(heading, rows) {
  return rows.length ? `## ${heading}\n${rows.map(decisionTitleLine).join("\n")}` : null;
}

// The block naming the item the job comes from, its type and the commit type the job's commits use.
function roadmapItemBlock(item) {
  const type = ROADMAP_TYPES.includes(item.type) ? item.type : null;
  const lines = [`Roadmap: ${roadmapRef(item)}`];
  if (type) lines.push(`Type: ${type}`, `Commit type: ${COMMIT_TYPE_BY_TYPE[type]}`);
  return `## Roadmap item\n${lines.join("\n")}`;
}

// The tier of a job built from an item: the caller's when given, else the default of the item's type.
function tierOf(item, tier) {
  if (tier !== undefined && tier !== null) return tier;
  return TIER_BY_TYPE[item.type] ?? null;
}

// Prompt a roadmap item is queued with: the task, the decision it is linked to and the accepted decisions around it.
export async function buildRoadmapPrompt({ item, embedder } = {}, env = process.env) {
  const linked = item.decision_id ? getDecision(item.decision_id, env) : null;
  const standing = titlesBlock(STANDING_HEADING, titlesOfStatus(item, "accepted", env));
  const proposed = titlesBlock(PROPOSED_HEADING, titlesOfStatus(item, "proposed", env));
  const related = await relatedDecisions(item, linked, embedder, env);
  const blocks = [`## Task\n${escapePromptMarkers(item.title)}`];
  if (item.detail) blocks.push(escapePromptMarkers(item.detail));
  blocks.push(roadmapItemBlock(item));
  if (linked) blocks.push(`## Linked decision\n${renderDecisionText(linked)}`);
  if (standing) blocks.push(standing);
  if (proposed) blocks.push(proposed);
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

// The projects an org item is queued for: one registered project of its org, or every one of them for `all`; a job is always a project's.
function orgTargets(item, project, env) {
  const config = loadConfig(env, { warn: () => {} });
  const members = projectsOfOrg(config, item.org);
  const named = typeof project === "string" ? project.trim() : "";
  if (named === ALL_PROJECTS && members.length) return members;
  const found = named && named !== ALL_PROJECTS ? projectByName(config, named) : null;
  if (found && found.org === item.org) return [found.name];
  throw new UserError(
    `roadmap item \`${item.id}\` belongs to org \`${item.org}\`: name the project its job goes to, or \`${ALL_PROJECTS}\` for every ` +
      `project of the org, with \`--project <name|${ALL_PROJECTS}>\` (\`project\` in queue_add); projects of \`${item.org}\`: ` +
      `${members.length ? members.join(", ") : "(none)"}`,
  );
}

// Queues and links the job of an org item for one project, or reports the live job that already holds that project's row.
function queueOrgTarget(item, project, { prompt, limits }, env) {
  const db = openDb(env);
  const live = liveRowJob(db, item.id, project);
  if (live) return { skipped: { project, job_id: live.id, job_status: live.status } };
  const job = addJob({ project, prompt, ...limits }, env);
  if (linkOrgRow(db, { itemId: item.id, project, jobId: job.id })) return { job };
  cancelJob(job.id, { reason: "roadmap item was queued for this project by another caller" }, env);
  const holder = liveRowJob(db, item.id, project);
  return { skipped: { project, job_id: holder?.id ?? null, job_status: holder?.status ?? null, cancelled_job_id: job.id } };
}

// Why nothing was queued for an org item: every project it was asked for already has a live job for it.
function allSkippedMessage(item, skipped) {
  const held = skipped.map((entry) => `\`${entry.project}\` (job \`${entry.job_id ?? "?"}\`, \`${entry.job_status ?? "?"}\`)`);
  return `roadmap item \`${item.id}\` is already queued for ${held.join(", ")}; cancel that job first`;
}

// Queues the job an org item builds for each project it names, one per-project row linked to each job; the item's own
// row keeps no job and its status is derived from the rows.
async function queueOrgItem(item, { project, embedder, ...limits }, env) {
  const targets = orgTargets(item, project, env);
  const prompt = await buildRoadmapPrompt({ item, embedder }, env);
  const jobLimits = { ...limits, tier: tierOf(item, limits.tier) };
  const outcomes = targets.map((target) => queueOrgTarget(item, target, { prompt, limits: jobLimits }, env));
  const jobs = outcomes.filter((outcome) => outcome.job).map((outcome) => outcome.job);
  const skipped = outcomes.filter((outcome) => outcome.skipped).map((outcome) => outcome.skipped);
  if (!jobs.length) throw new UserError(allSkippedMessage(item, skipped));
  return { job: jobs[0], jobs, skipped, item, targetProject: jobs.length === 1 ? jobs[0].project : null };
}

// Queues the job a roadmap item builds; a project item is linked to that job, an org item names the project it goes to or `all`.
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
  const job = addJob({ project: item.project, prompt, priority, maxAttempts, timeoutS, tier: tierOf(item, tier) }, env);
  if (linkRoadmapItemJob(item.id, job.id, env)) return { job, jobs: [job], skipped: [], item, targetProject: item.project };
  cancelJob(job.id, { reason: "roadmap item was queued by another caller" }, env);
  throw new UserError(
    `roadmap item \`${item.id}\` was queued by another caller; job \`${job.id}\` was cancelled and nothing else changed`,
  );
}
