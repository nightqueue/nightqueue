import assert from "node:assert/strict";
import { test } from "node:test";
import { closeDb, openDb } from "../../src/memory/db.mjs";
import { addJob, getJob } from "../../src/memory/jobs.mjs";
import { logPipelineRun } from "../../src/memory/runs.mjs";
import { carriesOperatorSeed, OPERATOR_SEED_HEADING, sharedSlugPending } from "../../src/memory/shared-slug-migration.mjs";
import { PRIOR_RUN_HEADING } from "../../src/queue/operator-run.mjs";
import { makeHome, makeProject } from "../../test-support/memory.mjs";

const SHARED = "tier-complex-set-by-the-operator";
const PR_74 = "https://github.com/acme/api/pull/74";
const BRANCH = "ns/rename-the-lease-column";

// A home with the project `alpha` registered and the queue table ready.
function makeQueue(t, name) {
  const env = makeHome(t, name);
  makeProject(t, env, "alpha");
  return env;
}

// Writes one job row the way a build without the fix left it: raw SQL is the only way to reach that state now.
function seedRow(env, { prompt = "fix the worker", slug = SHARED, status = "pending", prUrl = null, branch = null, result = null } = {}) {
  const id = addJob({ project: "alpha", prompt }, env).id;
  openDb(env)
    .prepare("UPDATE jobs SET slug = ?, status = ?, pr_url = ?, branch = ?, result = ? WHERE id = ?")
    .run(slug, status, prUrl, branch, result, id);
  return id;
}

// Closes and reopens the database of the home, which is when the migration runs.
function reopen(env) {
  closeDb(env);
  return openDb(env);
}

// The columns of a row the migration may touch.
function snapshot(env, id) {
  const row = getJob(id, env);
  return { slug: row.slug, status: row.status, pr_url: row.pr_url, branch: row.branch, result: row.result };
}

test("the operator seed heading the migration spares is the one the operator run writes", () => {
  assert.equal(OPERATOR_SEED_HEADING, PRIOR_RUN_HEADING);
});

test("a database where no two jobs share a run slug has nothing to migrate", (t) => {
  const env = makeQueue(t, "shared-slug-clean");
  seedRow(env, { slug: "one-run" });
  seedRow(env, { slug: "another-run" });
  assert.equal(sharedSlugPending(openDb(env)), false);
});

test("reopening detaches every job sharing a run slug but its keeper, records what it lost, and a second open changes nothing", (t) => {
  const env = makeQueue(t, "shared-slug-detach");
  const keeper = seedRow(env, { status: "done", prUrl: PR_74, branch: BRANCH });
  const detached = seedRow(env, { status: "cancelled", prUrl: PR_74, branch: BRANCH, result: JSON.stringify({ repairedFrom: "state.json" }) });
  const unrelated = seedRow(env, { slug: "another-run", status: "done", prUrl: PR_74, branch: BRANCH });
  const before = { keeper: snapshot(env, keeper), unrelated: snapshot(env, unrelated) };
  assert.equal(sharedSlugPending(openDb(env)), true);

  reopen(env);

  assert.deepEqual(snapshot(env, keeper), before.keeper, "the keeper of the run was touched");
  assert.deepEqual(snapshot(env, unrelated), before.unrelated);
  const row = snapshot(env, detached);
  assert.deepEqual({ slug: row.slug, pr_url: row.pr_url, branch: row.branch, status: row.status }, { slug: null, pr_url: null, branch: null, status: "cancelled" });
  assert.deepEqual(JSON.parse(row.result), { repairedFrom: "state.json", runSlugDetached: SHARED, runSlugKeptBy: keeper, prUrlDetached: PR_74 });

  const after = snapshot(env, detached);
  reopen(env);
  assert.deepEqual(snapshot(env, detached), after, "a second open migrated again");
  assert.equal(sharedSlugPending(openDb(env)), false);
});

test("a detached job that delivered keeps its pull request and a branch of its own", (t) => {
  const env = makeQueue(t, "shared-slug-delivered");
  const keeper = seedRow(env, { status: "done", prUrl: PR_74, branch: BRANCH });
  const delivered = seedRow(env, { status: "done", prUrl: PR_74, branch: "ns/its-own-branch" });

  reopen(env);

  const row = snapshot(env, delivered);
  assert.deepEqual({ slug: row.slug, pr_url: row.pr_url, branch: row.branch }, { slug: null, pr_url: PR_74, branch: "ns/its-own-branch" });
  assert.deepEqual(JSON.parse(row.result), { runSlugDetached: SHARED, runSlugKeptBy: keeper });
});

test("a run shared through an operator seed is left untouched", (t) => {
  const env = makeQueue(t, "shared-slug-seed");
  const earlier = seedRow(env, { status: "done", prUrl: PR_74 });
  const seeded = seedRow(env, { prompt: `## Brief\nfix it\n\n${OPERATOR_SEED_HEADING}\nRUN_DIR: somewhere` });

  reopen(env);

  assert.equal(getJob(earlier, env).slug, SHARED);
  assert.equal(getJob(seeded, env).slug, SHARED);
});

test("a prompt carries an operator seed only through an unfenced line that is the heading", () => {
  assert.equal(carriesOperatorSeed(`## Brief\nfix it\n\n${OPERATOR_SEED_HEADING}\nRUN_DIR: somewhere`), true);
  assert.equal(carriesOperatorSeed(`## Brief\nfix it\n\n  ${OPERATOR_SEED_HEADING}  \nRUN_DIR: somewhere`), true);
  assert.equal(carriesOperatorSeed(`## Brief\nthe runtime writes a \`${OPERATOR_SEED_HEADING}\` block after the brief`), false);
  assert.equal(carriesOperatorSeed(`## Brief\nthe block:\n\`\`\`\n${OPERATOR_SEED_HEADING}\nRUN_DIR: x\n\`\`\`\n`), false);
  assert.equal(carriesOperatorSeed(`## Brief\n~~~md\n${OPERATOR_SEED_HEADING}\n~~~`), false);
  assert.equal(carriesOperatorSeed(null), false);
});

test("a brief that only quotes the seed heading in prose or in a fenced block does not spare its shared run", (t) => {
  const env = makeQueue(t, "shared-slug-quoted");
  const keeper = seedRow(env, { status: "done", prUrl: PR_74, prompt: `## Brief\nthe runtime writes ${OPERATOR_SEED_HEADING} right after the brief` });
  const fenced = seedRow(env, { status: "cancelled", prompt: `## Brief\nthe block:\n\`\`\`\n${OPERATOR_SEED_HEADING}\nRUN_DIR: x\n\`\`\`` });
  assert.equal(sharedSlugPending(openDb(env)), true);

  reopen(env);

  assert.equal(getJob(keeper, env).slug, SHARED);
  assert.equal(getJob(fenced, env).slug, null);
  assert.equal(sharedSlugPending(openDb(env)), false);
});

test("a run whose job carries an applied seed block stays excluded even when another brief quotes the heading", (t) => {
  const env = makeQueue(t, "shared-slug-applied");
  const quoting = seedRow(env, { status: "done", prUrl: PR_74, prompt: `## Brief\nsee \`${OPERATOR_SEED_HEADING}\`` });
  const seeded = seedRow(env, { prompt: `## Brief\nfix it\n\n${OPERATOR_SEED_HEADING}\nRUN_DIR: somewhere\nResume from phase: plan` });
  assert.equal(sharedSlugPending(openDb(env)), false);

  reopen(env);

  assert.equal(getJob(quoting, env).slug, SHARED);
  assert.equal(getJob(seeded, env).slug, SHARED);
});

test("the tiered pair whose keeper's brief quotes the seed heading in prose gets its cancelled twin detached", (t) => {
  const env = makeQueue(t, "shared-slug-65-69");
  const tier = "Tier: complex (set by the operator - touches the queue and the runner)\n\n## Brief\n";
  const keeper = seedRow(env, {
    status: "done",
    prUrl: PR_74,
    branch: BRANCH,
    prompt: `${tier}Let the operator hand a run over: \`queue_add run_dir\` writes a \`${OPERATOR_SEED_HEADING}\` block right after the brief.`,
  });
  const twin = seedRow(env, {
    status: "cancelled",
    prUrl: PR_74,
    branch: BRANCH,
    prompt: `${tier}Rename the lease column of the worker table.`,
    result: JSON.stringify({ repairedFrom: "state.json", cancelledFrom: "done" }),
  });
  logPipelineRun({ project: "alpha", slug: SHARED, tier: "complex", outcome: "pr_opened", phases: [] }, env);
  openDb(env).prepare("UPDATE pipeline_runs SET job_id = ? WHERE project = 'alpha' AND slug = ?").run(keeper, SHARED);
  const before = snapshot(env, keeper);

  reopen(env);

  assert.deepEqual(snapshot(env, keeper), before);
  const row = snapshot(env, twin);
  assert.deepEqual({ slug: row.slug, pr_url: row.pr_url, branch: row.branch, status: row.status }, { slug: null, pr_url: null, branch: null, status: "cancelled" });
  assert.deepEqual(JSON.parse(row.result), { repairedFrom: "state.json", cancelledFrom: "done", runSlugDetached: SHARED, runSlugKeptBy: keeper, prUrlDetached: PR_74 });
  assert.match(row.result, new RegExp(`"runSlugKeptBy":${keeper}[,}]`), "the keeper id was stored as a real number");

  reopen(env);
  assert.deepEqual(snapshot(env, twin), row, "a second open migrated again");
});

test("the keeper is the job its pipeline run points at, even when it is the newer one", (t) => {
  const env = makeQueue(t, "shared-slug-linked");
  const older = seedRow(env, { status: "cancelled" });
  const linked = seedRow(env, { status: "done", prUrl: PR_74 });
  logPipelineRun({ project: "alpha", slug: SHARED, tier: "complex", outcome: "pr_opened", phases: [] }, env);
  openDb(env).prepare("UPDATE pipeline_runs SET job_id = ? WHERE project = 'alpha' AND slug = ?").run(linked, SHARED);

  reopen(env);

  assert.equal(getJob(linked, env).slug, SHARED);
  assert.equal(getJob(older, env).slug, null);
  assert.equal(JSON.parse(getJob(older, env).result).runSlugKeptBy, linked);
});
