import { sqliteToIso } from "./db.mjs";
import { parseCloseColumn } from "./jobs.mjs";
import { fileRefs, resultField } from "./roadmap-workflow.mjs";

// The columns of a job every comment the runtime writes about it reads.
export const COMMENT_JOB_COLUMNS = "id, status, result, close, pr_url, branch, notice_md, operator_note";

// The merge commit the close recorded in the job's checklist, or null.
function mergeShaOf(job) {
  const data = parseCloseColumn(job.close)?.data;
  return typeof data?.mergeSha === "string" && data.mergeSha ? data.mergeSha : null;
}

// The decision a job proposed, the one a comment about it links to, or null.
function decisionOfJob(db, jobId) {
  return db.prepare("SELECT id FROM decisions WHERE job_id = ? ORDER BY id LIMIT 1").get(jobId)?.id ?? null;
}

// The references a comment about a job carries, read from the runtime-written columns of its row.
export function jobRefs(db, job) {
  return {
    job_id: job.id,
    pr: job.pr_url ?? null,
    branch: job.branch ?? null,
    sha: mergeShaOf(job),
    files: fileRefs(resultField(job.result, "files")),
    decision_id: decisionOfJob(db, job.id),
  };
}

// Appends one comment to an item's thread; `createdAt` is given only by a backfill that dates what already happened.
export function insertComment(db, { itemId, kind, author, body, refs = null, project = null, createdAt = null }) {
  const row = db
    .prepare(
      `INSERT INTO roadmap_comments (item_id, kind, author, body, refs, project, created_at)
       VALUES (?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')))
       RETURNING *`,
    )
    .get(itemId, kind, author, body, refs === null ? null : JSON.stringify(refs), project, createdAt);
  return commentView(row);
}

// Reads the refs JSON of a comment, or null when it is absent or unreadable.
function parseRefs(text) {
  if (typeof text !== "string" || !text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// Public shape of one comment.
export function commentView(row) {
  return {
    id: row.id,
    kind: row.kind,
    author: row.author,
    body: row.body,
    refs: parseRefs(row.refs),
    project: row.project ?? null,
    created_at: sqliteToIso(row.created_at),
  };
}

// The thread of an item in chronological order; a project viewer sees the item's own comments and its project's, never a sibling's.
export function listComments(db, itemId, viewer = null) {
  const filter = viewer === null ? "" : " AND (project IS NULL OR project = ?)";
  const values = viewer === null ? [itemId] : [itemId, viewer];
  return db
    .prepare(`SELECT * FROM roadmap_comments WHERE item_id = ?${filter} ORDER BY created_at, id`)
    .all(...values)
    .map(commentView);
}
