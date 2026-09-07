#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

const PLAN_PATH = String(process.env.NIGHTSHIFT_FAKE_PLAN ?? "");
const COUNTER_PATH = `${PLAN_PATH}.attempt`;
const CALLS_PATH = `${PLAN_PATH}.calls.jsonl`;

// Reads the plan file that tells this fake what to print, how long to hold and how to exit.
function readPlan() {
  if (!PLAN_PATH) throw new Error("NIGHTSHIFT_FAKE_PLAN is not set");
  const plan = JSON.parse(readFileSync(PLAN_PATH, "utf8"));
  if (!Array.isArray(plan.attempts) || !plan.attempts.length) throw new Error("the plan has no attempts");
  return plan;
}

// Number of the attempt about to run, counted in a file next to the plan (one job at a time per plan).
function nextAttempt(total) {
  if (total < 2) return 0;
  const current = existsSync(COUNTER_PATH) ? Number(readFileSync(COUNTER_PATH, "utf8")) : 0;
  const attempt = Number.isInteger(current) && current >= 0 ? current : 0;
  writeFileSync(COUNTER_PATH, String(attempt + 1));
  return Math.min(attempt, total - 1);
}

// Records the argv and the job id of this call, so a test can assert the command the runner really built.
function recordCall() {
  const call = { pid: process.pid, argv: process.argv.slice(2), jobId: process.env.NIGHTSHIFT_JOB_ID ?? null, cwd: process.cwd() };
  appendFileSync(CALLS_PATH, `${JSON.stringify(call)}\n`);
}

// Waits the given number of milliseconds.
function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms));
}

// Plays one attempt: the first slice of the stream, a silent hold and then the rest.
async function play(step) {
  if (step.stdout) process.stdout.write(step.stdout);
  if (step.stderr) process.stderr.write(step.stderr);
  if (step.holdMs) await sleep(step.holdMs);
  if (step.tail) process.stdout.write(step.tail);
  process.exitCode = Number.isInteger(step.exitCode) ? step.exitCode : 0;
}

// Runs the fake CLI: it never touches the network and never reads the real Claude configuration.
async function main() {
  const plan = readPlan();
  recordCall();
  await play(plan.attempts[nextAttempt(plan.attempts.length)]);
}

try {
  await main();
} catch (err) {
  process.stderr.write(`FAKE_CLAUDE_ERROR: ${err?.message ?? String(err)}\n`);
  process.exitCode = 97;
}
