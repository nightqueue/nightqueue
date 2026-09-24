import { inTransaction } from "./db.mjs";
import { insertComment, jobRefs } from "./roadmap-comments.mjs";
import {
  CLOSED_STATUSES,
  JOB_TO_ROADMAP,
  LIVE_JOB_STATUSES,
  OPEN_STATUSES,
  OPERATOR_AUTHOR,
  STATUS_ASSIGNMENT,
  commentFor,
  deriveOrgStatus,
  followThroughCloseSource,
  jobAuthor,
  jobEvent,
  orgStatusAgrees,
  roadmapTransition,
  sqlList,
} from "./roadmap-workflow.mjs";
import { ownerOf } from "./scope.mjs";

const LIVE_JOB_LIST = sqlList(LIVE_JOB_STATUSES);

// The job still holding the row of an org item for one project, or null when the project has no live job for it.
export function liveRowJob(db, itemId, project) {
  return (
    db
      .prepare(
        `SELECT j.id, j.status FROM roadmap_item_projects p JOIN jobs j ON j.id = p.job_id
          WHERE p.item_id = ? AND p.project = ? AND j.status IN (${LIVE_JOB_LIST})`,
      )
      .get(itemId, project) ?? null
  );
}

// Re-derives an org item's status from its rows and, when it changed, persists it with an org-level comment signed by `author`.
export function syncOrgStatus(db, itemId, author) {
  const statuses = db.prepare("SELECT status FROM roadmap_item_projects WHERE item_id = ?").all(itemId).map((row) => row.status);
  const derived = deriveOrgStatus(statuses);
  const item = db.prepare("SELECT status FROM roadmap_items WHERE id = ? AND scope = 'org'").get(itemId);
  if (!item || orgStatusAgrees(item.status, derived)) return false;
  db.prepare(`UPDATE roadmap_items SET ${STATUS_ASSIGNMENT}, updated_at = datetime('now') WHERE id = ?`).run(derived, derived, itemId);
  const body = `status derived from its projects: ${item.status} → ${derived}`;
  insertComment(db, { itemId, kind: derived === "done" ? "closed" : "note", author, body });
  return true;
}

// Links the row of an org item for one project to the job built for it, moves it to `in_progress`, leaves the `queued`
// comment and re-derives the item, in one transaction; false means a live job already holds that row.
export function linkOrgRow(db, { itemId, project, jobId }) {
  const job = { id: jobId };
  const statement = db.prepare(
    `INSERT INTO roadmap_item_projects (item_id, project, status, job_id, job_status_seen)
     VALUES (?, ?, ?, ?, 'pending')
     ON CONFLICT(item_id, project) DO UPDATE SET status = excluded.status, job_id = excluded.job_id,
        job_status_seen = 'pending', closed_at = NULL, updated_at = datetime('now')
      WHERE NOT EXISTS (SELECT 1 FROM jobs j WHERE j.id = roadmap_item_projects.job_id AND j.status IN (${LIVE_JOB_LIST}))`,
  );
  return inTransaction(db, () => {
    if (statement.run(itemId, project, JOB_TO_ROADMAP.queued.status, jobId).changes !== 1) return false;
    insertComment(db, { itemId, project, ...commentFor(job, "queued", jobRefs(db, job)) });
    syncOrgStatus(db, itemId, jobAuthor(jobId));
    return true;
  });
}

// Applies to one project row what its job's current row means, replaying first the `done` a missed follow of a close skipped.
function followLinkedRow(db, row, job) {
  return followThroughCloseSource({ target: row, job, apply: (target, jobRow) => applyJobRowToRow(db, target, jobRow) });
}

// Applies to one project row what the given row of its job means and leaves the event's comment under that project.
function applyJobRowToRow(db, row, job) {
  const event = jobEvent(job, row.job_status_seen);
  const { status } = roadmapTransition(job, row.job_status_seen);
  db.prepare("UPDATE roadmap_item_projects SET job_status_seen = ? WHERE id = ?").run(job.status, row.id);
  const comment = commentFor(job, event, jobRefs(db, job));
  if (comment) insertComment(db, { itemId: row.item_id, project: row.project, ...comment });
  if (status === null || status === row.status) return false;
  db.prepare(`UPDATE roadmap_item_projects SET ${STATUS_ASSIGNMENT}, updated_at = datetime('now') WHERE id = ?`).run(
    status,
    status,
    row.id,
  );
  return true;
}

// Brings every project row linked to a job in line with the job's row and re-derives their org items; the caller holds the transaction.
export function followJobRows(db, job) {
  const rows = db
    .prepare(
      "SELECT id, item_id, project, status, job_status_seen FROM roadmap_item_projects WHERE job_id = ? AND job_status_seen IS NOT ?",
    )
    .all(job.id, job.status);
  let moved = 0;
  for (const row of rows) if (followLinkedRow(db, row, job)) moved += 1;
  for (const itemId of new Set(rows.map((row) => row.item_id))) syncOrgStatus(db, itemId, jobAuthor(job.id));
  return moved;
}

// The jobs whose linked project rows have not seen their current status yet.
export function driftedRowJobIds(db) {
  return db
    .prepare(
      `SELECT DISTINCT p.job_id AS id FROM roadmap_item_projects p JOIN jobs j ON j.id = p.job_id
        WHERE p.job_status_seen IS NOT j.status`,
    )
    .all()
    .map((row) => row.id);
}

// Cancels every open row of an org item closed by hand, one `closed` comment per row under its project; the caller holds the transaction.
export function cancelOpenRows(db, { itemId, status, author = OPERATOR_AUTHOR }) {
  const projects = db
    .prepare(
      `UPDATE roadmap_item_projects SET status = 'cancelled', closed_at = NULL, updated_at = datetime('now')
        WHERE item_id = ? AND status IN (${sqlList(OPEN_STATUSES)}) RETURNING project`,
    )
    .all(itemId)
    .map((row) => row.project);
  const who = author === OPERATOR_AUTHOR ? "the operator" : author;
  for (const project of projects) {
    insertComment(db, { itemId, project, kind: "closed", author, body: `cancelled: the org item was set to \`${status}\` by ${who}` });
  }
  return projects;
}

// The project rows of some org items with their job's status, by item; a `viewer` project keeps only its own row.
export function projectRowsByItem(db, itemIds, viewer = null) {
  const ids = [...new Set(itemIds)];
  const byItem = new Map(ids.map((id) => [id, []]));
  if (!ids.length) return byItem;
  const filter = viewer === null ? "" : " AND p.project = ?";
  const rows = db
    .prepare(
      `SELECT p.item_id, p.project, p.status, p.job_id, p.closed_at, j.status AS job_status
         FROM roadmap_item_projects p LEFT JOIN jobs j ON j.id = p.job_id
        WHERE p.item_id IN (${ids.map(() => "?").join(", ")})${filter}
        ORDER BY p.item_id, p.project`,
    )
    .all(...ids, ...(viewer === null ? [] : [viewer]));
  for (const row of rows) {
    byItem.get(row.item_id).push({ project: row.project, status: row.status, job_id: row.job_id ?? null, job_status: row.job_status ?? null });
  }
  return byItem;
}

// The item a job's project row belongs to, or null when the job carries no org row.
export function orgItemOfJob(db, jobId) {
  return (
    db
      .prepare(
        `SELECT r.id, r.scope, r.project, r.org FROM roadmap_item_projects p JOIN roadmap_items r ON r.id = p.item_id
          WHERE p.job_id = ? ORDER BY p.id DESC LIMIT 1`,
      )
      .get(jobId) ?? null
  );
}

// The project rows whose status disagrees with what their job's current row means.
function rowJobDrift(db) {
  return db
    .prepare(
      `SELECT p.item_id AS id, r.scope, r.project, r.org, p.project AS row_project, p.status, p.job_id, p.job_status_seen,
              j.status AS job_status, j.result
         FROM roadmap_item_projects p JOIN jobs j ON j.id = p.job_id JOIN roadmap_items r ON r.id = p.item_id
        WHERE p.job_status_seen IS NOT j.status
        ORDER BY p.item_id, p.project`,
    )
    .all()
    .map((row) => ({ row, expected: roadmapTransition({ ...row, status: row.job_status }, row.job_status_seen).status }))
    .filter(({ row, expected }) => expected !== null && expected !== row.status)
    .map(({ row, expected }) => ({
      id: row.id,
      scope: row.scope,
      owner: ownerOf(row),
      project: row.row_project,
      status: row.status,
      expected,
      job_id: row.job_id,
      job_status: row.job_status,
    }));
}

// The org items whose persisted status disagrees with the one their rows derive.
function orgDerivationDrift(db) {
  const rows = db
    .prepare(
      `SELECT r.id, r.org, r.status, p.status AS row_status FROM roadmap_items r
         JOIN roadmap_item_projects p ON p.item_id = r.id WHERE r.scope = 'org' ORDER BY r.id`,
    )
    .all();
  const items = new Map();
  for (const row of rows) {
    const entry = items.get(row.id) ?? { row, statuses: [] };
    entry.statuses.push(row.row_status);
    items.set(row.id, entry);
  }
  return [...items.values()]
    .map(({ row, statuses }) => ({ row, expected: deriveOrgStatus(statuses) }))
    .filter(({ row, expected }) => !orgStatusAgrees(row.status, expected))
    .map(({ row, expected }) => ({
      id: row.id,
      scope: "org",
      owner: row.org,
      project: null,
      status: row.status,
      expected,
      job_id: null,
      job_status: null,
    }));
}

// What the project rows add to the drift report: rows behind their job, and org items whose status disagrees with their rows.
export function projectRowsDrift(db) {
  return [...rowJobDrift(db), ...orgDerivationDrift(db)];
}

// Tells whether a manual status closes an org item, the move that cancels its open rows.
export function closesOrgItem(row, status) {
  return row?.scope === "org" && CLOSED_STATUSES.includes(status);
}
