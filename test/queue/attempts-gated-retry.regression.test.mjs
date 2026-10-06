import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultContext, run } from "../../src/cli/index.mjs";
import { openDb } from "../../src/memory/db.mjs";
import { addJob, claimJobById, finishJob, getJob, jobView, retryJob } from "../../src/memory/jobs.mjs";
import { ensureProject, makeHome, makeProject } from "../../test-support/memory.mjs";

const WORKER = "host:4242";

// Runs `queue status` with the given arguments and answers the lines it printed.
async function statusLines(env, args = []) {
  const out = [];
  const ctx = { ...defaultContext(), env, out: (line) => out.push(line), err: () => {}, stdout: { isTTY: false, columns: 200 } };
  assert.equal(await run(["queue", "status", ...args], ctx), 0, out.join("\n"));
  return out;
}

// Asserts the attempt history, totals and times of the gated-then-finished job.
function assertTwoAttempts(id, env) {
  const view = jobView(getJob(id, env));
  assert.equal(view.started_at, view.attempts_log[0].started_at);
  assert.equal(view.attempt_started_at, null);
  assert.deepEqual(view.attempts_log.map((row) => row.outcome), ["gate", "done"]);
  assert.deepEqual(view.attempts_log.map((row) => row.tokens_out), [110, 53]);
  assert.equal(view.tokens_out, 163);
  assert.ok(Math.abs(view.cost_usd - 0.0365) < 1e-9, `cost ${view.cost_usd}`);
  assert.equal(view.active_s, 900, "active_s must exclude the gate wait");
  assert.equal(view.wall_s, 2700);
}

test("gated, retried (no --fresh) and finished job keeps both attempts, summed totals and active time", async (t) => {
  const env = makeHome(t, "gated-retry");
  makeProject(t, env, "alpha");
  const id = addJob({ projectId: ensureProject(env, "alpha"), prompt: "fix the worker", maxAttempts: 3 }, env).id;
  const claim = () => assert.ok(claimJobById(id, { worker: WORKER, cap: 4 }, env));

  claim();
  const gated = { worker: WORKER, status: "gate", result: { status: "gate", exitCode: 0 }, noticeMd: "q?", usage: { tokensIn: 10, tokensOut: 110, costUsd: 0.032 } };
  assert.equal(finishJob(id, gated, env), true);
  retryJob(id, { note: "blue" }, env);
  claim();
  const done = { worker: WORKER, status: "done", result: { status: "done", exitCode: 0 }, usage: { tokensIn: 5, tokensOut: 53, costUsd: 0.0045 } };
  assert.equal(finishJob(id, done, env), true);

  const db = openDb(env);
  db.prepare("UPDATE job_attempts SET started_at = '2026-10-06 10:00:00', finished_at = '2026-10-06 10:10:00' WHERE job_id = ? AND attempt = 1").run(id);
  db.prepare("UPDATE job_attempts SET started_at = '2026-10-06 10:40:00', finished_at = '2026-10-06 10:45:00' WHERE job_id = ? AND attempt = 2").run(id);
  db.prepare("UPDATE jobs SET started_at = '2026-10-06 10:00:00', finished_at = '2026-10-06 10:45:00' WHERE id = ?").run(id);
  assertTwoAttempts(id, env);

  const table = await statusLines(env);
  assert.match(table.find((line) => line.startsWith(`J-${id} `)) ?? "", /\b15m00s\b/);
  const detail = await statusLines(env, [`J-${id}`]);
  assert.ok(detail.includes("active_s        15m00s (900 s)"), detail.join("\n"));

  assert.equal(finishJob(id, done, env), false, "a replayed finish is refused");
  assertTwoAttempts(id, env);
});
