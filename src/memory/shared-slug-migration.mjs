import { RESULT_OBJECT_BASE } from "./schema.mjs";

// The heading an operator-seeded job carries: such a job shares the run of a closed one on purpose.
export const OPERATOR_SEED_HEADING = "## PRIOR RUN (operator)";

const FENCE = /^(```|~~~)/;

const SHARED_GROUPS = `SELECT project_id, slug FROM jobs
   WHERE slug IS NOT NULL
   GROUP BY project_id, slug
  HAVING COUNT(*) > 1`;

const GROUP_PROMPTS = "SELECT prompt FROM jobs WHERE project_id = ? AND slug = ?";

const DETACH_ROW = `UPDATE jobs
    SET slug = NULL,
        branch = CASE WHEN branch = ? THEN NULL ELSE branch END,
        pr_url = CASE WHEN pr_url = ? AND status NOT IN ('done', 'closed') THEN NULL ELSE pr_url END,
        result = CASE WHEN pr_url = ? AND status NOT IN ('done', 'closed')
          THEN json_set(${RESULT_OBJECT_BASE}, '$.runSlugDetached', slug, '$.runSlugKeptBy', CAST(? AS INTEGER), '$.prUrlDetached', pr_url)
          ELSE json_set(${RESULT_OBJECT_BASE}, '$.runSlugDetached', slug, '$.runSlugKeptBy', CAST(? AS INTEGER)) END
  WHERE id = ? AND project_id = ? AND slug = ?`;

// Tells whether a prompt carries an applied prior-run block: a line that is the heading, outside any fenced code block.
export function carriesOperatorSeed(prompt) {
  let fenced = false;
  for (const line of String(prompt ?? "").split("\n")) {
    if (FENCE.test(line.trimStart())) fenced = !fenced;
    else if (!fenced && line.trim() === OPERATOR_SEED_HEADING) return true;
  }
  return false;
}

// The (project_id, slug) groups shared by several jobs, none of which was seeded from an operator run.
function pendingGroups(db) {
  const prompts = db.prepare(GROUP_PROMPTS);
  return db
    .prepare(SHARED_GROUPS)
    .all()
    .filter((group) => !prompts.all(group.project_id, group.slug).some((row) => carriesOperatorSeed(row.prompt)));
}

// Tells whether two or more jobs of a project still share one run slug outside an operator seed.
export function sharedSlugPending(db) {
  return pendingGroups(db).length > 0;
}

// The job that keeps a shared run: the one its pipeline run points at when exactly one does, the oldest otherwise.
function keeperOf(db, { project_id: projectId, slug }) {
  const linked = db
    .prepare(
      `SELECT DISTINCT j.id FROM jobs AS j JOIN pipeline_runs AS r ON r.job_id = j.id AND r.project_id = j.project_id AND r.slug = j.slug
        WHERE j.project_id = ? AND j.slug = ?`,
    )
    .all(projectId, slug);
  if (linked.length === 1) return Number(linked[0].id);
  return Number(db.prepare("SELECT MIN(id) AS id FROM jobs WHERE project_id = ? AND slug = ?").get(projectId, slug).id);
}

// Detaches every job of one shared run but its keeper, recording in each detached row what it lost.
function detachGroup(db, group) {
  const keeperId = keeperOf(db, group);
  const keeper = db.prepare("SELECT branch, pr_url FROM jobs WHERE id = ?").get(keeperId);
  const others = db
    .prepare("SELECT id FROM jobs WHERE project_id = ? AND slug = ? AND id <> ?")
    .all(group.project_id, group.slug, keeperId);
  const detach = db.prepare(DETACH_ROW);
  for (const { id } of others) {
    detach.run(keeper.branch, keeper.pr_url, keeper.pr_url, keeperId, keeperId, id, group.project_id, group.slug);
  }
}

// Gives every run slug shared by several jobs back to one of them; it must run inside one immediate transaction and is a no-op once done.
export function migrateSharedSlugs(db) {
  for (const group of pendingGroups(db)) detachGroup(db, group);
}
