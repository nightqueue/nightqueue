import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { jobLogPath, logsDir, runDir } from "../../src/config/paths.mjs";
import { openDb } from "../../src/memory/db.mjs";
import { addJob, claimJobById, finishJob, getJob } from "../../src/memory/jobs.mjs";
import { makeHome, makeProject } from "../../test-support/memory.mjs";
import { GATE_MARKER, noticeText, resultEvent, slugEvent, systemInitEvent, toNdjson } from "../../test-support/streams.mjs";

const CLI = fileURLToPath(new URL("../../bin/nightqueue.mjs", import.meta.url));
const WORKER = "host:1000";
const CAP = 4;
const SLUG = "fix-the-worker";
const CLEAN_ENDING = { status: "gate", prUrl: null, exitCode: 0, timedOut: false, idleTimedOut: false, attempts: 1 };

// The digest the pipeline recorded in the row before the fix: short, and the shape the original bug preserved forever.
const SHORT_SUMMARY =
  "The migration script finished but left three open items for review before merging: the column rename, the backfill job status and the feature flag rollout still need one more careful look from the team.";

// The three unresolved decisions job #28's run actually wrote in its own `## Notice`, each one a `Still open:` line.
const STILL_OPEN_LINES = [
  "Still open: whether the old `customer_ref` column keeps accepting writes for one more release while the new `customer_id` foreign key backfills in the background across every environment, staging included, before the cutover window opens for good.",
  "Still open: whether the backfill job that copies 2.1M rows from `legacy_customers` should run inside the same migration transaction or as a separate, resumable batch job with its own retry policy and its own dedicated alerting channel end to end.",
  "Still open: whether the `customer_ref_migration` feature flag should default to on for internal accounts before the public rollout, given the staging soak test only covered the read paths so far and never exercised a single write under real production load.",
];

// The full body of the `## Notice` the run wrote, ~1.5k code points long, three `Still open:` decisions the pipeline never summarized right;
// the heading itself is part of that body, the shape the runtime now requires of a valid gate notice.
const LONG_NOTICE = [
  GATE_MARKER,
  "",
  "The migration for the customer identity rewrite is ready, but three decisions need a human call before this can merge safely, and none of them are obvious from the diff alone or from the passing test suite:",
  "",
  ...STILL_OPEN_LINES,
  "",
  'None of these block the tests from passing locally, but each one changes production behavior in a way the pipeline should not decide alone. Please pick a direction for each item and reply with `nightqueue queue retry <id> --note "..."` so the run can continue with the chosen path once the team has settled all three open questions listed above, in any order that works for the on-call reviewer, and please keep the reply short enough to fit a single retry note without needing a follow-up round of questions from this side.',
].join("\n");

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

// Writes the accumulated stream of a job where the runtime persists it: init, slug, and a final `result` carrying the gate marker plus the whole `## Notice`.
function writeJobLog(env, id) {
  mkdirSync(logsDir(env), { recursive: true });
  const log = toNdjson([
    systemInitEvent(),
    slugEvent(SLUG),
    resultEvent({ text: noticeText(LONG_NOTICE) }),
  ]);
  writeFileSync(jobLogPath(id, env), log);
}

// Writes the state.json the pipeline itself recorded: the outcome carries the SAME short summary the row got, job #28's exact shape.
function writeSummarizedOutcome(env) {
  const dir = runDir("alpha", SLUG, env);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "state.json");
  const state = {
    schemaVersion: 1,
    slug: SLUG,
    phases: [],
    outcome: { status: "gate", notice: SHORT_SUMMARY, updatedAt: new Date().toISOString() },
  };
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`);
  return path;
}

// A job seeded exactly the way the bug left it: the row's notice_md is the short summary, the log and state.json both carry the long notice.
function seedBuggyJob(env) {
  const id = addJob({ project: "alpha", prompt: "fix the worker" }, env).id;
  claimJobById(id, { worker: WORKER, cap: CAP }, env);
  openDb(env).prepare("UPDATE jobs SET slug = ? WHERE id = ?").run(SLUG, id);
  finishJob(id, { worker: WORKER, status: "gate", result: CLEAN_ENDING, noticeMd: SHORT_SUMMARY }, env);
  writeJobLog(env, id);
  writeSummarizedOutcome(env);
  return id;
}

test("job #28's exact shape: `queue repair` replaces the short recorded summary with the full `## Notice` of the run, and `queue status` prints it whole", (t) => {
  const env = makeQueue(t, "notice-precedence-28");
  const id = seedBuggyJob(env);

  assert.equal(getJob(id, env).notice_md, SHORT_SUMMARY, "setup: the row carries the pre-fix short summary, not the run's own notice");
  assert.ok([...SHORT_SUMMARY].length < 210, "setup: the recorded summary is short, job-28-shaped");
  assert.ok([...LONG_NOTICE].length > 1400, "setup: the run's own notice is long, job-28-shaped");
  for (const line of STILL_OPEN_LINES) assert.ok(LONG_NOTICE.includes(line), "setup: the long notice carries its three `Still open:` decisions");

  const repaired = runCli(env, ["queue", "repair", String(id)]);
  assert.equal(repaired.status, 0, repaired.stderr);

  const row = getJob(id, env);
  assert.equal(row.status, "gate", "the repair must not change the status, only the notice");
  assert.equal(row.notice_md, LONG_NOTICE, "the run's own `## Notice` must win over the short summary the pipeline recorded");
  assert.notEqual(row.notice_md, SHORT_SUMMARY, "the short summary must not survive the repair");

  const detailJson = runCli(env, ["queue", "status", String(id), "--json"]);
  assert.equal(detailJson.status, 0, detailJson.stderr);
  const job = JSON.parse(detailJson.stdout).job;
  assert.equal(job.notice_md, LONG_NOTICE, "`queue status --json` must answer the FULL notice, not a prefix and not the summary");
  assert.equal(job.notice_md.endsWith("..."), false, "the json notice must not be truncated");

  const detailText = runCli(env, ["queue", "status", String(id)]);
  assert.equal(detailText.status, 0, detailText.stderr);
  for (const line of STILL_OPEN_LINES) {
    assert.ok(detailText.stdout.includes(line), `the plain-text detail must print the decision line: ${line.slice(0, 40)}...`);
  }
  assert.equal(detailText.stdout.includes(SHORT_SUMMARY), false, "the plain-text detail must not still show the short summary");
});
