import { UserError } from "../config/errors.mjs";
import { callerJobId } from "../config/job-home.mjs";
import { openStore } from "../store/open.mjs";
import { clearRunTerminal, discardRunDir } from "./resume.mjs";
import { jobRef } from "../memory/refs.mjs";

export { callerJobId };

// Refuses a retry aimed at another job from inside an unattended run: the note becomes a human answer in the next prompt of that job, and the run directory of that job would be deleted.
function requireOwnJob(id, env) {
  const own = callerJobId(env);
  if (own === null || own === Number(id)) return;
  throw new UserError(
    `refusing to retry job \`${id}\` from inside job \`${own}\`: an unattended run may only retry itself; ` +
      `ask the operator to run \`nightqueue queue retry ${jobRef(id)}\` outside the queue`,
  );
}

// Retries one job and, only with `fresh`, drops the run directory of the previous attempt; the order is fixed, so a refused retry never deletes anything.
export async function applyRetry({ id, note, fresh = false, env = process.env } = {}) {
  requireOwnJob(id, env);
  const store = openStore(env);
  const before = await store.jobs.getJob(id);
  const job = await store.jobs.retryJob(id, { note, fresh });
  const run = { projectId: before?.project_id, slug: before?.slug, env };
  if (fresh !== true) return { job, runDir: null, witness: clearRunTerminal(run) };
  return { job, runDir: discardRunDir(run), witness: { status: "absent", path: null, reason: null } };
}
