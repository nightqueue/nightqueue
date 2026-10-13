import { addColumnIfMissing } from "../columns.mjs";
import { inTransaction } from "../tx.mjs";

const CLOSE_TITLE = "(CASE WHEN json_valid(close) THEN CASE WHEN json_type(close, '$.data.title') = 'text' THEN trim(json_extract(close, '$.data.title')) END END)";
const UNFILLED_PR_TITLE = `pr_title IS NULL AND close IS NOT NULL AND ${CLOSE_TITLE} <> ''`;

// Adds the title columns on every open and backfills the pull request title of closed jobs from their close checklist, the write behind a read that finds nothing once done.
export function migrateJobTitles(db) {
  addColumnIfMissing(db, "jobs", "title", "TEXT");
  addColumnIfMissing(db, "jobs", "pr_title", "TEXT");
  if (!db.prepare(`SELECT 1 FROM jobs WHERE ${UNFILLED_PR_TITLE} LIMIT 1`).get()) return;
  inTransaction(db, () => db.prepare(`UPDATE jobs SET pr_title = ${CLOSE_TITLE} WHERE ${UNFILLED_PR_TITLE}`).run());
}
