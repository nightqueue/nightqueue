import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { defaultContext, run } from "../../src/cli/index.mjs";
import { openDb } from "../../src/memory/db.mjs";
import { addJob } from "../../src/memory/jobs.mjs";
import { isolatedHostVars } from "../../test-support/host.mjs";
import { makeDir, makeHome, makeProject } from "../../test-support/memory.mjs";

// ACCEPTANCE of decisions #24/#25: a follow behind a gh that takes 2s to fail redraws as often as one with the checks off.

const CLI = fileURLToPath(new URL("../../bin/nightqueue.mjs", import.meta.url));
const REDRAW = "\u001b[0J";
const RUN_MS = 22_000;
const SLOW_GH_MS = 2_000;
const PR_FIELDS = "state,mergedAt,mergeCommit,mergeable,isDraft";

// A home with one project and the jobs of the test written straight into the table; the ids come back in order.
function seedHome(t, name, jobs) {
  const env = { ...makeHome(t, name), NO_COLOR: "1" };
  makeProject(t, env, "alpha");
  return {
    env,
    ids: jobs.map(({ status, prUrl = null }) => {
      const id = addJob({ project: "alpha", prompt: "fix the worker" }, env).id;
      openDb(env).prepare("UPDATE jobs SET status = ?, pr_url = ? WHERE id = ?").run(status, prUrl, id);
      return id;
    }),
  };
}

// The same home behind the fake gh, which sleeps before it fails because no pull request state was given to it.
function withSlowFailingGh(t, env, name) {
  const slow = { ...env, ...isolatedHostVars(makeDir(t, `${name}-host`)), NIGHTQUEUE_FAKE_GH_SLEEP_MS: String(SLOW_GH_MS) };
  delete slow.NIGHTQUEUE_NO_PR_CHECK;
  return slow;
}

// Runs `queue status --follow <s>` in this process on a fake terminal that keeps every frame with the instant it was drawn.
function startFollow(env, intervalS) {
  const frames = [];
  const errors = [];
  const ctx = {
    ...defaultContext(),
    env,
    out: () => {},
    err: (line) => errors.push(line),
    stdout: {
      isTTY: true,
      columns: 200,
      write: (text) => {
        if (text.includes(REDRAW)) frames.push({ at: Date.now(), text });
      },
    },
  };
  const startedAt = Date.now();
  const done = run(["queue", "status", "--follow", String(intervalS)], ctx).then((code) => ({ code, elapsedMs: Date.now() - startedAt }));
  return { frames, errors, done };
}

// The `gh pr view` calls the fake gh of a home recorded so far.
function prViewCalls(env) {
  const log = env.NIGHTQUEUE_FAKE_GH_LOG;
  if (!log || !existsSync(log)) return [];
  return readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)).filter((call) => call[0] === "pr" && call[1] === "view");
}

// Waits until a condition holds, polling, and tells whether it did before the deadline.
async function waitFor(condition, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) return false;
    await new Promise((done) => setTimeout(done, 50));
  }
  return true;
}

// Runs the real CLI as a second OS process and resolves with its exit code and the instant it exited.
function runCliProcess(env, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { env, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("exit", (code) => resolve({ code, stderr, exitedAt: Date.now() }));
  });
}

// Runs `queue status --follow 2` on a fake clock moved by every read and every sleep, stopping after `ticks` sleeps.
async function runOnFakeClock(env, { stepMs, ticks = 3 }) {
  let clock = 1_000_000;
  const requested = [];
  const frames = [];
  const ctx = {
    ...defaultContext(),
    env,
    out: () => {},
    err: () => {},
    stdout: { isTTY: true, columns: 200, write: (text) => text.includes(REDRAW) && frames.push(text) },
    now: () => {
      const at = clock;
      clock += stepMs;
      return at;
    },
    sleep: async (ms) => {
      requested.push(ms);
      clock += ms;
      if (requested.length >= ticks) process.kill(process.pid, "SIGINT");
      await new Promise((done) => setTimeout(done, 20));
    },
  };
  const code = await run(["queue", "status", "--follow", "2"], ctx);
  return { code, requested, frames };
}

test("the follow sleeps what is left of its interval and prints the cadence it achieved", async (t) => {
  const { env } = seedHome(t, "cadence-fake-clock", [{ status: "done", prUrl: "https://github.com/acme/repo/pull/1" }]);

  const fast = await runOnFakeClock(env, { stepMs: 10 });
  assert.equal(fast.code, 0);
  assert.ok(fast.requested.length >= 3, `the follow slept ${fast.requested.length} times`);
  for (const ms of fast.requested) assert.ok(ms >= 0 && ms < 2000 && ms > 1500, `a sleep of ${ms}ms is not what is left of a 2s interval`);
  assert.match(fast.frames[0], /achieved every - \(asked 2s\)/, "the first frame claims a cadence it could not have measured");
  for (const frame of fast.frames.slice(1)) assert.match(frame, /achieved every 2\.0s \(asked 2s\)/);
  assert.match(fast.frames[0], /read \d+ms: jobs \d+ms, counts \d+ms, runners \d+ms, advisories \d+ms/);

  const slow = await runOnFakeClock(env, { stepMs: 500 });
  assert.equal(slow.code, 0);
  assert.deepEqual([...new Set(slow.requested)], [0], "a read slower than the interval still slept on top of it");
});

test("a follow whose jobs cannot be read says so on one stable line and keeps polling", async (t) => {
  const { env } = seedHome(t, "cadence-unreadable-jobs", [{ status: "pending" }]);
  openDb(env).exec("ALTER TABLE jobs RENAME TO jobs_gone");
  const out = [];
  let ticks = 0;
  const ctx = {
    ...defaultContext(),
    env,
    out: (line) => out.push(line),
    err: () => {},
    stdout: { isTTY: false, columns: 200, write: () => {} },
    sleep: async () => {
      ticks += 1;
      if (ticks >= 3) process.kill(process.pid, "SIGINT");
      await new Promise((done) => setTimeout(done, 20));
    },
  };

  const code = await run(["queue", "status", "--follow", "1"], ctx);

  assert.equal(code, 0);
  assert.ok(ticks >= 3, `the follow stopped polling after ${ticks} ticks`);
  const failures = out.filter((line) => line.startsWith("jobs: cannot be read ("));
  assert.equal(failures.length, 1, `the failure line was not stable on a pipe:\n${out.join("\n")}`);
  assert.match(failures[0], /no such table: jobs/);
});

test("a follow behind a gh that takes 2s to fail redraws as often as one with the checks off, and asks gh once per pull request", { timeout: 60_000 }, async (t) => {
  const prJobs = [1, 2, 3].map((n) => ({ status: "done", prUrl: `https://github.com/acme/repo/pull/${n}` }));
  const slow = withSlowFailingGh(t, seedHome(t, "cadence-slow-gh", prJobs).env, "cadence-slow-gh");
  const off = seedHome(t, "cadence-no-pr-check", prJobs).env;
  assert.equal(off.NIGHTQUEUE_NO_PR_CHECK, "1");

  const withGh = startFollow(slow, 2);
  const withoutGh = startFollow(off, 2);
  const stopper = setTimeout(() => process.kill(process.pid, "SIGINT"), RUN_MS);
  t.after(() => clearTimeout(stopper));
  const [slowRun, offRun] = await Promise.all([withGh.done, withoutGh.done]);
  t.diagnostic(`redraws: slow gh=${withGh.frames.length} checks off=${withoutGh.frames.length}; elapsed ${slowRun.elapsedMs}/${offRun.elapsedMs}ms`);

  assert.equal(slowRun.code, 0, withGh.errors.join("\n"));
  assert.equal(offRun.code, 0, withoutGh.errors.join("\n"));
  assert.ok(withGh.frames.length >= 10, `the follow behind a slow gh redrew ${withGh.frames.length} times in ${RUN_MS}ms`);
  assert.ok(withoutGh.frames.length >= 10, `the follow with the checks off redrew ${withoutGh.frames.length} times in ${RUN_MS}ms`);
  for (const [label, outcome] of [["slow gh", slowRun], ["checks off", offRun]]) {
    assert.ok(outcome.elapsedMs < RUN_MS + 2_000 + 1_500, `${label}: the stop took ${outcome.elapsedMs - RUN_MS}ms past the signal`);
  }
  for (const [label, follow] of [["slow gh", withGh], ["checks off", withoutGh]]) {
    assert.match(follow.frames.at(-1).text, /achieved every 2\.\ds \(asked 2s\)/, `${label}: the last footer does not state the cadence it achieved`);
  }
  const calls = prViewCalls(slow);
  assert.equal(calls.length, 3, `gh was asked ${calls.length} times: the refresh is not deduped or its cooldown is off`);
  for (const call of calls) assert.equal(call[4], PR_FIELDS, `gh was asked for the wrong fields: ${call.join(" ")}`);
  assert.deepEqual(prViewCalls(off), [], "the follow with the checks off asked gh");
});

test("a retry issued from another process shows up in the next frame of a running follow", { timeout: 30_000 }, async (t) => {
  const seeded = seedHome(t, "cadence-cross-process", [{ status: "failed" }, { status: "done", prUrl: "https://github.com/acme/repo/pull/9" }]);
  const env = withSlowFailingGh(t, seeded.env, "cadence-cross-process");
  const [failed] = seeded.ids;
  const pendingRow = new RegExp(`^#${failed}\\s+○ pending`, "m");

  const follow = startFollow(env, 1);
  let signalled = false;
  const stop = () => {
    if (signalled) return;
    signalled = true;
    process.kill(process.pid, "SIGINT");
  };
  t.after(stop);
  assert.ok(await waitFor(() => follow.frames.length >= 1, 5_000), "the follow never drew its first frame");

  const retried = await runCliProcess(env, ["queue", "retry", String(failed)]);
  assert.equal(retried.code, 0, retried.stderr);
  const shown = await waitFor(() => follow.frames.some((frame) => frame.at >= retried.exitedAt && pendingRow.test(frame.text)), 5_000);
  stop();
  const outcome = await follow.done;

  assert.equal(outcome.code, 0, follow.errors.join("\n"));
  assert.ok(shown, "no frame ever showed the retried job as pending");
  const after = follow.frames.filter((frame) => frame.at >= retried.exitedAt);
  const index = after.findIndex((frame) => pendingRow.test(frame.text));
  assert.ok(index <= 1, `the retry showed up only ${index + 1} frames after it was committed`);
  assert.ok(after[index].at - retried.exitedAt <= 1_000 + 1_500, `the retry showed up ${after[index].at - retried.exitedAt}ms after it was committed`);
});
