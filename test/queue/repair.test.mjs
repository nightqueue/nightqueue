import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { jobLogPath, logsDir, runDir } from "../../src/config/paths.mjs";
import { openDb } from "../../src/memory/db.mjs";
import { addJob, claimJobById, finishJob, getJob, listMergeCandidates } from "../../src/memory/jobs.mjs";
import { isoToSqlite } from "../../src/memory/schema.mjs";
import { MERGE_SWEEP_LIMIT } from "../../src/queue/merged.mjs";
import { reconcileFromWitness } from "../../src/queue/reconcile.mjs";
import { reclassifyFromLog } from "../../src/queue/repair.mjs";
import { readRunState } from "../../src/queue/resume.mjs";
import { makeHome, makeProject } from "../../test-support/memory.mjs";
import { attemptMarker, gateStream, intermediateDeliveryStream, PR_URL } from "../../test-support/streams.mjs";

const CLI = fileURLToPath(new URL("../../bin/nightshift.mjs", import.meta.url));
const WORKER = "host:1000";
const CAP = 4;
const SLUG = "fix-the-worker";
const NOTICE = "The pull request is open and the checks are green.";
const CLEAN_ENDING = { status: "gate", prUrl: null, exitCode: 0, timedOut: false, idleTimedOut: false, attempts: 1 };

// A home with one registered project and the queue table ready.
function makeQueue(t, name) {
  const env = makeHome(t, name);
  makeProject(t, env, "alpha");
  return env;
}

// Runs the real CLI in its own process, with the isolated home of the test.
function runCli(env, args) {
  return spawnSync(process.execPath, [CLI, ...args], { env, encoding: "utf8" });
}

// Writes the accumulated stream of a job where the runtime persists it.
function writeJobLog(env, id, log) {
  mkdirSync(logsDir(env), { recursive: true });
  writeFileSync(jobLogPath(id, env), log);
}

// Writes the state.json of the run, with the witness the runner left: the same wrong outcome the row carries.
function writeRunState(env, { slug = SLUG, terminal = { status: "gate", prUrl: null, finishedAt: "2026-09-14T21:00:00Z" } } = {}) {
  const dir = runDir("alpha", slug, env);
  mkdirSync(dir, { recursive: true });
  const state = { schemaVersion: 1, slug, project: "alpha", resumeCount: 0, phases: [{ phase: "triage", artifact: "01-triage.md", verdict: "ok" }], terminal };
  writeFileSync(join(dir, "state.json"), `${JSON.stringify(state, null, 2)}\n`);
  return join(dir, "state.json");
}

// A job that ended the way the bug records it: `gate`, no pull request, and its whole stream on disk.
function finishedJob(env, { status = "gate", result = CLEAN_ENDING, log = intermediateDeliveryStream(), slug = SLUG } = {}) {
  const id = addJob({ project: "alpha", prompt: "fix the worker" }, env).id;
  claimJobById(id, { worker: WORKER, cap: CAP }, env);
  openDb(env).prepare("UPDATE jobs SET slug = ? WHERE id = ?").run(slug, id);
  finishJob(id, { worker: WORKER, status, result, noticeMd: NOTICE }, env);
  if (log !== null) writeJobLog(env, id, log);
  return id;
}

test("`queue repair` turns a job that really opened a pull request into done, and rewrites the witness to match", (t) => {
  const env = makeQueue(t, "repair-cli");
  const id = finishedJob(env);
  const statePath = writeRunState(env);
  assert.equal(getJob(id, env).pr_url, null, "setup: the row already carried the pull request");

  const repaired = runCli(env, ["queue", "repair", String(id)]);
  assert.equal(repaired.status, 0, repaired.stderr);
  assert.match(repaired.stdout, new RegExp(`job #${id} re-classified from \`gate\` to \`done\``));
  assert.ok(repaired.stdout.includes(PR_URL), repaired.stdout);

  const row = getJob(id, env);
  assert.equal(row.status, "done");
  assert.equal(row.pr_url, PR_URL);
  assert.equal(JSON.parse(row.result).reclassifiedFrom, "gate");
  assert.deepEqual(readRunState({ project: "alpha", slug: SLUG, env }).terminal.status, "done");
  assert.deepEqual(readRunState({ project: "alpha", slug: SLUG, env }).terminal.prUrl, PR_URL);

  const after = readFileSync(statePath, "utf8");
  const again = runCli(env, ["queue", "repair", String(id)]);
  assert.equal(again.status, 1, "a job already corrected was re-classified a second time");
  assert.match(again.stderr, /is `done`; only a `gate` or a `failed` job is re-classified/);
  assert.equal(readFileSync(statePath, "utf8"), after, "the refused repair rewrote the run directory");
  assert.equal(getJob(id, env).pr_url, PR_URL);
});

test("the repaired row survives the automatic reconciliation: the file and the row say the same thing", async (t) => {
  const env = makeQueue(t, "repair-reconcile");
  const id = finishedJob(env);
  writeRunState(env);

  assert.equal((await reclassifyFromLog({ id, env })).to, "done");
  assert.deepEqual((await reconcileFromWitness(env)).repaired, [], "a finished job was repaired again by the sweep");
  assert.equal(getJob(id, env).status, "done");
  assert.equal(readRunState({ project: "alpha", slug: SLUG, env }).terminal.status, "done");
});

test("the outcome the pipeline recorded in state.json is what the repair believes, even against the stream", async (t) => {
  const env = makeQueue(t, "repair-record");
  const id = finishedJob(env, { log: gateStream({ slug: SLUG }) });
  const dir = runDir("alpha", SLUG, env);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "state.json"),
    JSON.stringify({ schemaVersion: 1, slug: SLUG, phases: [], outcome: { status: "done", prUrl: PR_URL, updatedAt: "2026-09-14T21:00:00Z" } }),
  );

  const outcome = await reclassifyFromLog({ id, env });
  assert.deepEqual({ from: outcome.from, to: outcome.to, prUrl: outcome.prUrl, changed: outcome.changed }, { from: "gate", to: "done", prUrl: PR_URL, changed: true });
});

test("only the LAST attempt of an accumulated log decides: an older delivery never repairs a later failure", async (t) => {
  const env = makeQueue(t, "repair-attempts");
  const log = `${attemptMarker(1)}\n${intermediateDeliveryStream()}${attemptMarker(2)}\n${gateStream({ slug: SLUG })}`;
  const id = finishedJob(env, { log });
  const statePath = writeRunState(env);
  const before = readFileSync(statePath, "utf8");

  const outcome = await reclassifyFromLog({ id, env });
  assert.equal(outcome.changed, false, "the delivery of attempt 1 was read as the outcome of attempt 2");
  assert.equal(getJob(id, env).pr_url, null);

  const answered = runCli(env, ["queue", "repair", String(id)]);
  assert.equal(answered.status, 0, answered.stderr);
  assert.match(answered.stdout, new RegExp(`job #${id} is still \`gate\`; there is nothing to correct`));
  assert.equal(readFileSync(statePath, "utf8"), before, "a repair with nothing to correct rewrote the run directory");
  assert.equal(getJob(id, env).status, "gate");
});

test("a repaired row joins the merged sweep like any delivery, and `queue status` reads it without a single call to gh", async (t) => {
  const env = makeQueue(t, "repair-merge-candidates");
  const id = finishedJob(env);
  writeRunState(env);

  assert.equal((await reclassifyFromLog({ id, env })).to, "done");
  const candidates = listMergeCandidates({ cutoff: isoToSqlite(new Date()), limit: MERGE_SWEEP_LIMIT }, env);
  assert.deepEqual(
    candidates.map((job) => ({ id: job.id, prUrl: job.pr_url })),
    [{ id, prUrl: PR_URL }],
    "the repaired delivery never reached the merged sweep",
  );

  const status = runCli(env, ["queue", "status"]);
  assert.equal(status.status, 0, status.stderr);
  assert.ok(status.stdout.includes(String(id)) && status.stdout.includes("done"), status.stdout);
  assert.equal(getJob(id, env).status, "done", "the status pass moved the repaired row");
});

test("each refusal of `queue repair` names what is missing, and none of them writes anything", async (t) => {
  const env = makeQueue(t, "repair-refusals");

  await assert.rejects(() => reclassifyFromLog({ id: 4242, env }), /unknown job `4242`/);

  const live = addJob({ project: "alpha", prompt: "still running" }, env).id;
  claimJobById(live, { worker: WORKER, cap: CAP }, env);
  writeJobLog(env, live, intermediateDeliveryStream());
  await assert.rejects(() => reclassifyFromLog({ id: live, env }), /is running with a live lease/);
  assert.equal(getJob(live, env).status, "running");

  const delivered = finishedJob(env, { status: "done", result: { ...CLEAN_ENDING, status: "done" } });
  await assert.rejects(() => reclassifyFromLog({ id: delivered, env }), /is `done`; only a `gate` or a `failed` job is re-classified/);

  const noLog = finishedJob(env, { log: null });
  await assert.rejects(() => reclassifyFromLog({ id: noLog, env }), /is not on disk/);
  assert.equal(getJob(noLog, env).status, "gate");

  const noEnding = finishedJob(env, { result: null });
  await assert.rejects(() => reclassifyFromLog({ id: noEnding, env }), /recorded no exit code/);
  assert.equal(getJob(noEnding, env).status, "gate");
});

test("a failed job that had already delivered its pull request keeps the failure and gains the link", async (t) => {
  const env = makeQueue(t, "repair-failed");
  const id = finishedJob(env, { status: "failed", result: { ...CLEAN_ENDING, status: "failed", exitCode: 1 } });
  writeRunState(env, { terminal: { status: "failed", prUrl: null, finishedAt: "2026-09-14T21:00:00Z" } });

  const outcome = await reclassifyFromLog({ id, env });
  assert.deepEqual({ from: outcome.from, to: outcome.to, prUrl: outcome.prUrl }, { from: "failed", to: "failed", prUrl: PR_URL });
  assert.equal(getJob(id, env).status, "failed", "a non-zero exit was turned into a delivery by a log");
  assert.equal(getJob(id, env).pr_url, PR_URL);
});
