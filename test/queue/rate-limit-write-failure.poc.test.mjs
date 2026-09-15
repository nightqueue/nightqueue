import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { test } from "node:test";
import { jobLogPath, runnerRegistryPath } from "../../src/config/paths.mjs";
import { addJob, getJob } from "../../src/memory/jobs.mjs";
import { pauseFromEvent, readOwnPause, recordOwnPause } from "../../src/queue/rate-limit.mjs";
import { writeRunnerRecord } from "../../src/queue/registry.mjs";
import { runCycle } from "../../src/queue/runner.mjs";
import { extractRateLimitFromEventLine } from "../../src/queue/stream.mjs";
import { makeDir, makeHome, makeProject } from "../../test-support/memory.mjs";
import { useFakeClaude } from "../../test-support/queue-fake.mjs";
import { doneStream, PR_URL, rateLimitEvent, systemInitEvent, toNdjson } from "../../test-support/streams.mjs";

// A git double for the preflight: a clean checkout of the default branch.
function fakeGit() {
  const answers = { status: "", "rev-parse": "main", "symbolic-ref": "origin/main" };
  return ({ args }) => `${answers[args[0]] ?? ""}\n`;
}

// The rejection the stream carries, and the pause the runner decides from it - the same chain `captureRateLimit` runs.
function rejectionPause(event) {
  return pauseFromEvent(extractRateLimitFromEventLine(JSON.stringify(event)));
}

test("a registry write that fails leaves the child's own protection reading no pause at all, even though the run believed one was armed", async (t) => {
  const idleTimeoutS = 0.7;
  const silenceMs = 2000;
  const env = makeHome(t, "rate-limit-write-failure");
  makeProject(t, env, "alpha");
  const event = rateLimitEvent({ status: "rejected", rateLimitType: "five_hour", fiveHour: 0.99 });
  useFakeClaude(env, makeDir(t, "rate-limit-write-failure-plan"), [{ stdout: toNdjson([systemInitEvent({}), event]), holdMs: silenceMs, tail: doneStream(), exitCode: 0 }]);
  writeRunnerRecord({ pid: process.pid, startedAt: new Date().toISOString(), mode: "drain" }, env);

  const pause = rejectionPause(event);
  assert.ok(pause, "the rejection event armed no pause to test the write failure with");
  assert.ok(Date.parse(pause.pausedUntil) > Date.now(), "the fixture's pause is already over, so the run has nothing left to wait out");
  assert.ok(silenceMs > idleTimeoutS * 1000, "the fixture does not keep the child silent longer than the idle timeout");

  // Simulates the registry write failing mid-run the way a lock timeout, a full disk or a
  // permission error would: the very file `recordOwnPause` merges into disappears under it.
  rmSync(runnerRegistryPath(process.pid, env), { force: true });
  await assert.rejects(recordOwnPause(pause, env), "the write did not fail the way a full disk or a permission error would");

  // The production path, seam included: `runAttempts` builds the child's pause signal itself.
  const id = addJob({ project: "alpha", prompt: "fix the worker" }, env).id;
  const cycle = await runCycle({ jobId: id, env, deps: { gitImpl: fakeGit(), idleTimeoutS, stopPollMs: 500 } });

  assert.equal(readOwnPause(env), null, "the durable record shows a pause after the write meant to persist it failed");
  assert.deepEqual(
    cycle.processed,
    [{ id, status: "done", prUrl: PR_URL, attempts: 1 }],
    "the child was killed by the idle timer while the run believed a rate-limit pause was protecting it",
  );
  assert.equal(getJob(id, env).status, "done");
  const log = readFileSync(jobLogPath(id, env), "utf8");
  assert.match(log, /the rate limit pause could not be recorded, so only this run waits it out: /, "the failed write was swallowed instead of being said out loud");
  assert.match(log, /=== rate limit until \S+ @ \S+ ===/, "the job log says nothing about the wait the run did");
});
