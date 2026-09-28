import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { jobLogPath, logsDir, runDir } from "../../src/config/paths.mjs";
import { openDb } from "../../src/memory/db.mjs";
import { addJob, getJob } from "../../src/memory/jobs.mjs";
import { reconcileFromWitness } from "../../src/queue/reconcile.mjs";
import { reclassifyFromLog } from "../../src/queue/repair.mjs";
import { runCycle } from "../../src/queue/runner.mjs";
import { makeDir, makeHome, makeProject } from "../../test-support/memory.mjs";
import { useFakeClaude } from "../../test-support/queue-fake.mjs";
import { assistantEvent, doneStream, gateStream, noticeText, PR_URL, resultEvent, systemInitEvent, toNdjson } from "../../test-support/streams.mjs";

const TIER_HEADER = "Tier: complex (set by the operator - the pipeline may only raise it, with evidence, never lower it)";
const A_FINISHED_AT = "2026-09-23T10:00:00.000Z";

// A git double for the preflight: a clean checkout of the default branch.
function fakeGit() {
  const answers = { status: "", "rev-parse": "main", "symbolic-ref": "origin/main" };
  return ({ args }) => {
    const answer = answers[args[0]];
    if (answer === undefined) throw new Error(`git ${args[0]} failed`);
    return `${answer}\n`;
  };
}

// A home with the project `alpha` registered and the fake `claude` playing the given attempts in order.
function makeRunnerHome(t, name, attempts) {
  const env = makeHome(t, name);
  makeProject(t, env, "alpha");
  useFakeClaude(env, makeDir(t, `${name}-plan`), attempts);
  return env;
}

// The prompt the operator queues at its Step 8: the tier header first, then the brief.
function operatorPrompt(brief) {
  return `${TIER_HEADER}\n\n## Brief\n${brief}\n\n## Success criteria\n- the job ends with a pull request`;
}

// Queues one tiered job the way the operator does.
function queueTiered(env, brief) {
  return addJob({ project: "alpha", prompt: operatorPrompt(brief), tier: "complex" }, env).id;
}

// A run that opens a pull request without ever naming its run, so the job keeps the slug the runtime bound.
function unnamedDoneStream() {
  return toNdjson([systemInitEvent(), assistantEvent(noticeText(), { messageId: "msg_notice" }), resultEvent({ text: `Done. Pull request: ${PR_URL}` })]);
}

// Runs one cycle over a single job with the git reads injected.
function runJobCycle(env, jobId) {
  return runCycle({ jobId, env, deps: { gitImpl: fakeGit() } });
}

// Writes the state.json of a run with the terminal witness a runner left in it, and answers its bytes.
function writeTerminal(env, slug, terminal) {
  const dir = runDir("alpha", slug, env);
  mkdirSync(dir, { recursive: true });
  const text = `${JSON.stringify({ schemaVersion: 1, slug, project: "alpha", resumeCount: 0, phases: [], terminal }, null, 2)}\n`;
  writeFileSync(join(dir, "state.json"), text);
  return text;
}

test("two jobs queued with --tier complex get distinct slugs from their own briefs and distinct run dirs", async (t) => {
  const env = makeRunnerHome(t, "tier-slug-distinct", [
    { stdout: unnamedDoneStream(), exitCode: 0 },
    { stdout: unnamedDoneStream(), exitCode: 0 },
  ]);
  const a = queueTiered(env, "Rename the lease column of the jobs table");
  const b = queueTiered(env, "Drop the retired ship columns after the close migration");

  await runJobCycle(env, a);
  await runJobCycle(env, b);

  const slugA = getJob(a, env).slug;
  const slugB = getJob(b, env).slug;
  assert.equal(slugA, "rename-the-lease-column-of-the");
  assert.equal(slugB, "drop-the-retired-ship-columns-after");
  for (const slug of [slugA, slugB]) assert.equal(slug.startsWith("tier-"), false, `\`${slug}\` was derived from the runtime header`);
  assert.notEqual(runDir("alpha", slugA, env), runDir("alpha", slugB, env));
  assert.equal(existsSync(runDir("alpha", slugA, env)), true);
  assert.equal(existsSync(runDir("alpha", slugB, env)), true);
});

test("two tiered jobs whose briefs share their first six words get the base slug and its -2 variant", async (t) => {
  const env = makeRunnerHome(t, "tier-slug-suffix", [
    { stdout: unnamedDoneStream(), exitCode: 0 },
    { stdout: unnamedDoneStream(), exitCode: 0 },
  ]);
  const a = queueTiered(env, "Fix the worker of the queue when the lease expires");
  const b = queueTiered(env, "Fix the worker of the queue when a session is resumed");

  await runJobCycle(env, a);
  await runJobCycle(env, b);

  assert.equal(getJob(a, env).slug, "fix-the-worker-of-the-queue");
  assert.equal(getJob(b, env).slug, "fix-the-worker-of-the-queue-2");
  assert.equal(existsSync(runDir("alpha", "fix-the-worker-of-the-queue-2", env)), true);
});

test("the repair of one tiered job never reads the state.json of another one, even when its pipeline names the same run", async (t) => {
  const env = makeRunnerHome(t, "tier-slug-repair", [
    { stdout: doneStream({ slug: "shared-run" }), exitCode: 0 },
    { stdout: gateStream({ slug: "shared-run" }), exitCode: 0 },
  ]);
  const a = queueTiered(env, "Rename the lease column of the jobs table");
  const b = queueTiered(env, "Drop the retired ship columns after the close migration");

  await runJobCycle(env, a);
  const stateA = join(runDir("alpha", "shared-run", env), "state.json");
  const bytesA = readFileSync(stateA, "utf8");
  await runJobCycle(env, b);
  await reconcileFromWitness(env);
  await reclassifyFromLog({ id: b, env });

  const rowA = getJob(a, env);
  const rowB = getJob(b, env);
  assert.equal(rowA.slug, "shared-run");
  assert.notEqual(rowB.slug, "shared-run", "the second job was bound to the run of the first one");
  assert.equal(rowB.status, "gate");
  assert.equal(rowB.pr_url, null, "the second job took the pull request of the first one");
  assert.equal(JSON.parse(rowB.result ?? "{}").repairedFrom, undefined);
  assert.equal(readFileSync(stateA, "utf8"), bytesA, "the state.json of the first job was rewritten");
  assert.match(readFileSync(jobLogPath(b, env), "utf8"), /`shared-run` is not free \(job #\d+ holds it\)/);
});

test("a legacy job still sharing a run slug ignores the witness another job stamped there", async (t) => {
  const env = makeHome(t, "tier-slug-legacy");
  makeProject(t, env, "alpha");
  const db = openDb(env);
  const a = queueTiered(env, "Rename the lease column of the jobs table");
  const b = queueTiered(env, "Drop the retired ship columns after the close migration");
  const shared = "tier-complex-set-by-the-operator";
  db.prepare("UPDATE jobs SET slug = ?, status = 'done', pr_url = ?, finished_at = '2026-09-23 10:00:00' WHERE id = ?").run(shared, PR_URL, a);
  db.prepare("UPDATE jobs SET slug = ?, status = 'running', worker = 'dead:1', lease_until = datetime('now', '-1 hour') WHERE id = ?").run(shared, b);
  const bytes = writeTerminal(env, shared, { status: "done", prUrl: PR_URL, finishedAt: A_FINISHED_AT, writtenBy: "runner", pid: 1, jobId: a });

  const outcome = await reconcileFromWitness(env);

  assert.deepEqual(outcome.repaired, [], "the witness of one job repaired another");
  const rowB = getJob(b, env);
  assert.equal(rowB.status, "running");
  assert.equal(rowB.pr_url, null);
  assert.equal(rowB.finished_at, null);
  assert.equal(readFileSync(join(runDir("alpha", shared, env), "state.json"), "utf8"), bytes);
});

test("a legacy gated job re-classified from its log ignores the witness another job stamped in the run it shares", async (t) => {
  const env = makeHome(t, "tier-slug-legacy-reclassify");
  makeProject(t, env, "alpha");
  const db = openDb(env);
  const a = queueTiered(env, "Rename the lease column of the jobs table");
  const b = queueTiered(env, "Drop the retired ship columns after the close migration");
  const shared = "tier-complex-set-by-the-operator";
  const ending = JSON.stringify({ status: "gate", prUrl: null, exitCode: 0, timedOut: false, idleTimedOut: false, attempts: 1 });
  db.prepare("UPDATE jobs SET slug = ?, status = 'done', pr_url = ?, finished_at = '2026-09-23 10:00:00' WHERE id = ?").run(shared, PR_URL, a);
  db.prepare("UPDATE jobs SET slug = ?, status = 'gate', result = ?, finished_at = datetime('now') WHERE id = ?").run(shared, ending, b);
  const bytes = writeTerminal(env, shared, { status: "done", prUrl: PR_URL, finishedAt: A_FINISHED_AT, writtenBy: "runner", pid: 1, jobId: a });
  mkdirSync(logsDir(env), { recursive: true });
  writeFileSync(jobLogPath(b, env), gateStream({ slug: shared }));

  await reclassifyFromLog({ id: b, env });

  const rowB = getJob(b, env);
  assert.equal(rowB.status, "gate");
  assert.equal(rowB.pr_url, null, "the re-classification took the pull request of the other job");
  assert.equal(readFileSync(join(runDir("alpha", shared, env), "state.json"), "utf8"), bytes);
});
