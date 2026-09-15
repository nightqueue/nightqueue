import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { jobLogPath, logsDir } from "../../src/config/paths.mjs";
import { openDb } from "../../src/memory/db.mjs";
import { addJob, claimJobById, finishJob } from "../../src/memory/jobs.mjs";
import { reclassifyFromLog } from "../../src/queue/repair.mjs";
import { makeHome, makeProject } from "../../test-support/memory.mjs";
import { intermediateDeliveryStream, PR_URL } from "../../test-support/streams.mjs";

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

// Writes the accumulated stream of a job where the runtime persists it.
function writeJobLog(env, id, log) {
  mkdirSync(logsDir(env), { recursive: true });
  writeFileSync(jobLogPath(id, env), log);
}

// A job that ended `gate`, no pull request on the row, with a real delivery on disk in its log.
function finishedJob(env, { status = "gate", result = CLEAN_ENDING, log = intermediateDeliveryStream(), slug = SLUG } = {}) {
  const id = addJob({ project: "alpha", prompt: "fix the worker" }, env).id;
  claimJobById(id, { worker: WORKER, cap: CAP }, env);
  openDb(env).prepare("UPDATE jobs SET slug = ? WHERE id = ?").run(slug, id);
  finishJob(id, { worker: WORKER, status, result, noticeMd: NOTICE }, env);
  if (log !== null) writeJobLog(env, id, log);
  return id;
}

test("an incidental raw line shaped like an attempt marker, landing after a real delivery, never makes repair discard that delivery", async (t) => {
  const env = makeQueue(t, "repair-marker-injection");
  // Only ONE real attempt boundary; the second "marker" below is stderr/noise incidentally shaped like one, appended AFTER the delivery already happened.
  const log = `${intermediateDeliveryStream()}=== attempt 2 @ 2026-09-14T22:00:00.000Z ===\n`;
  const id = finishedJob(env, { log });

  const outcome = await reclassifyFromLog({ id, env });

  assert.equal(outcome.to, "done", "the incidental marker-shaped line made repair discard a real delivery and mark the job failed instead");
  assert.equal(outcome.prUrl, PR_URL, "the real pull request link was discarded by the marker-shaped decoy line");
});
