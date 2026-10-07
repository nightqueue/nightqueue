import { UserError } from "../config/errors.mjs";
import { ownedRowCounts, projectById } from "./registry.mjs";
import { inTransaction } from "./tx.mjs";

// The purge of a project: the project and every row it owns, children first, in one transaction.

const OWN_DECISIONS = "SELECT id FROM decisions WHERE project_id = ?";

// The rows only reachable through an owned row, as [table, SQL counting them].
const DEPENDENT_COUNTS = [
  ["pipeline_phases", "SELECT COUNT(*) AS n FROM pipeline_phases WHERE run_id IN (SELECT id FROM pipeline_runs WHERE project_id = ?)"],
  ["project_key_aliases", "SELECT COUNT(*) AS n FROM project_key_aliases WHERE project_id = ?"],
  ["job_attempts", "SELECT COUNT(*) AS n FROM job_attempts WHERE job_id IN (SELECT id FROM jobs WHERE project_id = ?)"],
];

// What a project owns, per table and only where there is any.
export function projectFootprint(db, projectId) {
  const dependents = DEPENDENT_COUNTS.map(([table, sql]) => ({ table, total: db.prepare(sql).get(projectId).n }));
  return [...ownedRowCounts(db, { projectId }), ...dependents].filter((entry) => entry.total > 0);
}

// Refuses the purge while a job of the project is being worked or closed.
function requireNoActiveJob(db, project) {
  const active = db
    .prepare("SELECT COUNT(*) AS n FROM jobs WHERE project_id = ? AND (status = 'running' OR close_status = 'closing')")
    .get(project.id).n;
  if (active > 0) {
    throw new UserError(`cannot purge project \`${project.name}\`: ${active} job(s) are running or closing; nothing was removed`);
  }
}

// Deletes every row of the project, then the project, in the order the foreign keys accept.
function deleteOwnedRows(db, projectId) {
  db.prepare(`UPDATE decisions SET superseded_by = NULL WHERE superseded_by IN (${OWN_DECISIONS})`).run(projectId);
  db.prepare("DELETE FROM decisions WHERE project_id = ?").run(projectId);
  for (const table of ["pipeline_runs", "lessons", "memory", "project_index", "project_libs", "jobs", "project_key_aliases"]) {
    db.prepare(`DELETE FROM ${table} WHERE project_id = ?`).run(projectId);
  }
  db.prepare("DELETE FROM projects WHERE id = ?").run(projectId);
}

// Purges a project and everything it owns in one transaction, refused while a job is running or closing; answers the counts it removed.
export function purgeProject(db, id) {
  return inTransaction(db, () => {
    const project = projectById(db, id);
    if (!project) throw new UserError(`unknown project id \`${id}\``);
    requireNoActiveJob(db, project);
    const removed = projectFootprint(db, id);
    deleteOwnedRows(db, id);
    return { project, removed };
  });
}
