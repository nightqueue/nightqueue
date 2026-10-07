import { UserError } from "../config/errors.mjs";
import { jobTitle } from "../queue/job-title.mjs";
import { openDb } from "./db.mjs";
import { jobRef } from "./refs.mjs";
import { ftsMatch } from "./search.mjs";

export const JOB_SEARCH_LIMIT = 5;

// The number of hits a search returns: the asked one clamped to 1..5, or 5.
function searchLimit(limit) {
  if (!Number.isInteger(limit)) return JOB_SEARCH_LIMIT;
  return Math.min(Math.max(limit, 1), JOB_SEARCH_LIMIT);
}

// The SQL and its values for the matching jobs of one project, best first, without the excluded job when there is one.
function jobSearchQuery({ match, projectId, excludeJobId, limit }) {
  const excludes = Number.isInteger(excludeJobId) && excludeJobId > 0;
  const sql = `SELECT j.id, j.slug, j.status, j.pr_url, j.finished_at, j.prompt, bm25(jobs_fts) AS rank
    FROM jobs_fts JOIN jobs j ON j.id = jobs_fts.rowid
   WHERE jobs_fts MATCH ? AND j.project_id = ?${excludes ? " AND j.id <> ?" : ""}
   ORDER BY rank LIMIT ?`;
  const values = excludes ? [match, projectId, excludeJobId, limit] : [match, projectId, limit];
  return { sql, values };
}

// Public shape of one search hit; the prompt never leaves this module.
function hitView(row) {
  return {
    id: row.id,
    ref: jobRef(row.id),
    slug: row.slug ?? null,
    title: jobTitle(row),
    status: row.status,
    pr_url: row.pr_url ?? null,
    finished_at: row.finished_at ?? null,
  };
}

// Up to five jobs of one project whose slug, brief or notice match a query, best first.
export function searchJobs({ query, projectId, excludeJobId, limit } = {}, env = process.env, db = null) {
  if (typeof projectId !== "string" || !projectId.trim()) throw new UserError("job search needs `projectId`");
  const match = typeof query === "string" ? ftsMatch(query) : null;
  if (match === null) return [];
  const connection = db ?? openDb(env);
  const { sql, values } = jobSearchQuery({ match, projectId, excludeJobId, limit: searchLimit(limit) });
  return connection.prepare(sql).all(...values).map(hitView);
}
