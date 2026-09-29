import { UserError } from "../config/errors.mjs";
import { jobRef } from "./refs.mjs";

// Refuses a link to a job this database has no row for, naming it, so a writer never meets a bare foreign key failure.
export function refuseMissingJob(db, jobId) {
  if (db.prepare("SELECT 1 FROM jobs WHERE id = ?").get(jobId)) return;
  throw new UserError(`${jobRef(jobId)} is not in the queue of this database, so nothing can be linked to it; nothing was written`);
}
