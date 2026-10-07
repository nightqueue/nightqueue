import { dbPath } from "../src/config/paths.mjs";
import { addJob } from "../src/memory/jobs.mjs";
import { closeDb } from "../src/memory/db.mjs";
import { INDEXES, ISSUE_COMMENT_GUARDS, ISSUE_FTS, ISSUE_NUMBER_INDEXES, issueCommentsDdl, issueProjectsDdl, issuesDdl } from "../src/memory/migration/tracker-shape.mjs";
import { ensureProject, seedDoneJob } from "./memory.mjs";

const { DatabaseSync } = await import("node:sqlite");

export const V23_DONE_PROMPT = "fix the runner lease renewal";
export const V23_NOTICE_WORD = "zebrarenewal";
const V23_PR_URL = "https://github.com/acme/alpha/pull/42";

// Seeds the three jobs of the fixture through the real store writes: a done one on alpha with its PR and notice, a pending one on each project.
function seedJobs(env) {
  const done = seedDoneJob(env, { project: "alpha", prompt: V23_DONE_PROMPT, prUrl: V23_PR_URL, noticeMd: `Done: the ${V23_NOTICE_WORD} fix shipped` });
  const beta = addJob({ projectId: ensureProject(env, "beta"), prompt: "raise the beta node version" }, env).id;
  const pending = addJob({ projectId: ensureProject(env, "alpha"), prompt: "document the alpha setup" }, env).id;
  return { done, beta, pending };
}

// Turns the open v24 schema back into the v23 one: no job index, and the tracker created from its frozen shapes.
function plantV23Schema(db) {
  db.exec("DROP TRIGGER IF EXISTS jobs_fts_ai; DROP TRIGGER IF EXISTS jobs_fts_au; DROP TRIGGER IF EXISTS jobs_fts_ad; DROP TABLE IF EXISTS jobs_fts");
  db.exec(`${issuesDdl("issues")}\n${issueCommentsDdl("issue_comments")}\n${issueProjectsDdl("issue_projects")}`);
  db.exec(ISSUE_COMMENT_GUARDS);
  db.exec(ISSUE_FTS);
  db.exec(ISSUE_NUMBER_INDEXES);
  db.exec(INDEXES);
}

// Inserts a project item linked to the done job, an org item of the projects' org tracking beta through its job, and a comment on each.
function seedTracker(db, { projectId, jobs, betaId }) {
  const orgId = db.prepare("SELECT org_id FROM projects WHERE id = ?").get(projectId).org_id;
  const item = db.prepare("INSERT INTO issues (scope, project_id, org_id, number, title, position, job_id) VALUES (?, ?, ?, 1, ?, 1, ?)");
  const projectItem = Number(item.run("project", projectId, null, "the lease renewal regressed", jobs.done).lastInsertRowid);
  const orgItem = Number(item.run("org", null, orgId, "raise every node version", null).lastInsertRowid);
  db.prepare("INSERT INTO issue_projects (item_id, project_id, status, job_id) VALUES (?, ?, 'in_progress', ?)").run(orgItem, betaId, jobs.beta);
  const comment = db.prepare("INSERT INTO issue_comments (item_id, kind, author, body) VALUES (?, 'note', 'operator', ?)");
  comment.run(projectItem, "seen again on the runner");
  comment.run(orgItem, "beta first");
}

// Builds the home a v23 build left: two projects of one org, three jobs, the tracker with a project item, an org item and comments, stamped 23; `live` gives the pending alpha job a runner's live lease.
export function buildV23Home(env, { live = false } = {}) {
  const projectId = ensureProject(env, "alpha");
  const betaId = ensureProject(env, "beta");
  const jobs = seedJobs(env);
  closeDb(env);
  const db = new DatabaseSync(dbPath(env));
  try {
    db.exec("PRAGMA foreign_keys = ON");
    plantV23Schema(db);
    seedTracker(db, { projectId, jobs, betaId });
    if (live) {
      db.prepare("UPDATE jobs SET status = 'running', worker = 'w', lease_until = datetime('now', '+1 hour'), started_at = datetime('now') WHERE id = ?").run(jobs.pending);
    }
    db.exec("PRAGMA user_version = 23");
  } finally {
    db.close();
  }
  return { jobs, projectId, betaId };
}
