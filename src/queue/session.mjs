import { existsSync } from "node:fs";
import { UserError } from "../config/errors.mjs";
import { projectByName } from "../config/projects.mjs";
import { loadConfig } from "../config/store.mjs";
import { readRunState } from "./resume.mjs";

// The session id and attempt of a job's last run, or null when it never recorded one.
function lastSession(job) {
  const session = job.last_session_id ?? job.session_id ?? null;
  if (!session) return null;
  return { session, attempt: job.last_session_id ? (job.last_session_attempt ?? job.attempts) : job.attempts };
}

// Why a job's session cannot be resumed right now, or null when it can.
function sessionRefusal(job) {
  if (job.status === "running") return `job \`${job.id}\` is running (worker \`${job.worker}\`) and its runner owns the session; wait for it to end or cancel it first`;
  if (job.status === "pending") return `job \`${job.id}\` has not run yet; there is no session to resume`;
  if (!lastSession(job)) return `job \`${job.id}\` recorded no session; it never reached the agent`;
  return null;
}

// The cwd a session resumes in: the run's worktree when it is still on disk, else the project's checkout, with whether it fell back.
function resumeCwd(job, env) {
  const state = readRunState({ project: job.project, slug: job.slug, env });
  const worktree = typeof state?.worktree === "string" ? state.worktree.trim() : "";
  if (worktree && existsSync(worktree)) return { cwd: worktree, worktreeReleased: false };
  const checkout = projectByName(loadConfig(env, { warn: () => {} }), job.project)?.path;
  if (!checkout) throw new UserError(`project \`${job.project}\` is not registered; its checkout cannot be resolved`);
  return { cwd: checkout, worktreeReleased: Boolean(worktree) };
}

// The session of a job's last attempt to resume, its attempt number and the cwd to resume it in; throws the reason when it cannot.
export function resolveJobSession(job, env = process.env) {
  const refusal = sessionRefusal(job);
  if (refusal) throw new UserError(refusal);
  const { session, attempt } = lastSession(job);
  const { cwd, worktreeReleased } = resumeCwd(job, env);
  return { jobId: job.id, attempt, session, cwd, worktreeReleased };
}
