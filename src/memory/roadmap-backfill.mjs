import { inTransaction, openDb } from "./db.mjs";
import { COMMENT_JOB_COLUMNS, insertComment, jobRefs } from "./roadmap-comments.mjs";
import { CLOSED_STATUSES, jobAuthor } from "./roadmap-workflow.mjs";

const JOB_COLUMNS = COMMENT_JOB_COLUMNS.split(", ")
  .map((column) => `j.${column}`)
  .join(", ");

// Every item linked to a job, with the job's row and the timestamps its history is dated from.
const LINKED_ITEMS = `SELECT r.id AS item_id, r.status AS item_status, ${JOB_COLUMNS},
       j.created_at AS queued_at,
       COALESCE(j.finished_at, (SELECT MIN(p.created_at) FROM pipeline_runs p WHERE p.job_id = j.id), j.created_at) AS finished_at
  FROM roadmap_items r JOIN jobs j ON j.id = r.job_id
 ORDER BY r.id`;

// Tells whether an item was closed by hand: it is done or cancelled while its job never closed, and such an item gets nothing.
function closedByHand(row) {
  return CLOSED_STATUSES.includes(row.item_status) && row.status !== "closed";
}

// The comment the job's close leaves, or null while the job is not closed.
function closingComment(row) {
  if (row.status !== "closed") return null;
  return { kind: "closed", body: `job #${row.id} closed`, createdAt: row.finished_at };
}

// The comments the history of one linked job stands for, dated when each event happened.
function historyComments(db, row) {
  const refs = jobRefs(db, row);
  const comments = [{ kind: "queued", body: `queued as job #${row.id}`, createdAt: row.queued_at }];
  if (row.pr_url) comments.push({ kind: "pr", body: `job #${row.id} done: ${row.pr_url}`, createdAt: row.finished_at });
  const closing = closingComment(row);
  if (closing) comments.push(closing);
  return comments.map((comment) => ({ ...comment, itemId: row.item_id, author: jobAuthor(row.id), refs }));
}

// Tells whether the thread already holds a comment of this kind about this job, the key that makes the backfill idempotent.
function hasComment(db, { itemId, kind, refs }) {
  return Boolean(
    db
      .prepare("SELECT 1 FROM roadmap_comments WHERE item_id = ? AND kind = ? AND json_extract(refs, '$.job_id') = ? LIMIT 1")
      .get(itemId, kind, refs.job_id),
  );
}

// Synthesizes the `queued`/`pr`/`closed` comments of every item linked to a job before comments existed; idempotent,
// and a dry run counts what it would write without writing it.
export function backfillRoadmap({ dryRun = false } = {}, env = process.env) {
  const db = openDb(env);
  const run = () => {
    const rows = db.prepare(LINKED_ITEMS).all();
    const tally = { items: rows.length, written: 0, skipped: 0 };
    for (const row of rows) {
      if (closedByHand(row)) {
        tally.skipped += 1;
        continue;
      }
      for (const comment of historyComments(db, row)) {
        if (hasComment(db, comment)) continue;
        if (!dryRun) insertComment(db, comment);
        tally.written += 1;
      }
    }
    return tally;
  };
  return dryRun ? run() : inTransaction(db, run);
}
