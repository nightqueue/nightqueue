#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";

const PLAN_PATH = String(process.env.NIGHTQUEUE_FAKE_PLAN ?? "");
const COUNTER_PATH = `${PLAN_PATH}.attempt`;
const CALLS_PATH = `${PLAN_PATH}.calls.jsonl`;

// Reads the plan file that tells this fake what to print, how long to hold and how to exit.
function readPlan() {
  if (!PLAN_PATH) throw new Error("NIGHTQUEUE_FAKE_PLAN is not set");
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
function recordCall(plan) {
  const call = { pid: process.pid, argv: process.argv.slice(2), jobId: process.env.NIGHTQUEUE_JOB_ID ?? null, claim: process.env.NIGHTQUEUE_JOB_CLAIM ?? null, cwd: process.cwd() };
  if (typeof plan.probePath === "string") call.probeExisted = existsSync(plan.probePath);
  if (typeof plan.probeReadPath === "string") call.probedText = existsSync(plan.probeReadPath) ? readFileSync(plan.probeReadPath, "utf8") : null;
  if (typeof plan.probeStatusOf === "string") call.probedStatus = gitOut(plan.probeStatusOf, ["status", "--porcelain"]);
  appendFileSync(CALLS_PATH, `${JSON.stringify(call)}\n`);
}

// Runs git in a directory with an identity of its own, answering its output.
function gitOut(cwd, args) {
  const identity = ["-c", "user.name=fake", "-c", "user.email=fake@example.invalid", "-c", "commit.gpgsign=false"];
  return execFileSync("git", [...identity, ...args], { cwd, encoding: "utf8" });
}

// Refuses to write anywhere outside the system temp dir, so a fake never touches the enclosing repository or a real home.
function assertInTempDir(dir) {
  const root = realpathSync(tmpdir());
  if (!realpathSync(dir).startsWith(root + sep)) throw new Error(`refusing to write outside ${root}: the directory is ${dir}`);
}

// The run directory the runner handed this session in its prompt.
function promptRunDir() {
  const argv = process.argv.slice(2);
  const found = /^RUN_DIR: (.+)$/m.exec(String(argv[argv.indexOf("-p") + 1] ?? ""));
  if (!found) throw new Error("the attempt records a run state but its prompt hands over no RUN_DIR");
  return found[1];
}

// Merges what this attempt's pipeline recorded into the state.json of its run, the way `run_outcome`, `run publish` and `run_terminate` keep every other field.
function recordRunState(change) {
  const dir = promptRunDir();
  assertInTempDir(dir);
  const path = join(dir, "state.json");
  const state = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
  const outcome = change.outcome ? { outcome: { ...state.outcome, ...change.outcome } } : {};
  writeFileSync(`${path}.tmp`, JSON.stringify({ ...state, ...change, ...outcome }));
  renameSync(`${path}.tmp`, path);
}

// Writes one file in the working directory and commits it, the way a run leaves its work on its branch.
function commitFile(name) {
  assertInTempDir(process.cwd());
  writeFileSync(name, `work of ${process.pid}\n`);
  gitOut(process.cwd(), ["add", name]);
  gitOut(process.cwd(), ["commit", "-q", "-m", `feat: add ${name}`]);
}

// Waits the given number of milliseconds.
function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms));
}

// Plays one attempt: the first slice of the stream, a silent hold, the rest, and a last silent hold before the exit.
async function play(step) {
  if (step.runState) recordRunState(step.runState);
  if (typeof step.commitFile === "string") commitFile(step.commitFile);
  if (Array.isArray(step.exec)) execFileSync(process.execPath, step.exec, { stdio: ["ignore", "ignore", "pipe"] });
  if (step.stdout) process.stdout.write(step.stdout);
  if (step.stderr) process.stderr.write(step.stderr);
  if (step.holdMs) await sleep(step.holdMs);
  if (step.tail) process.stdout.write(step.tail);
  if (step.afterHoldMs) await sleep(step.afterHoldMs);
  process.exitCode = Number.isInteger(step.exitCode) ? step.exitCode : 0;
}

// Runs the fake CLI: it never touches the network and never reads the real Claude configuration.
async function main() {
  const plan = readPlan();
  recordCall(plan);
  await play(plan.attempts[nextAttempt(plan.attempts.length)]);
}

try {
  await main();
} catch (err) {
  process.stderr.write(`FAKE_CLAUDE_ERROR: ${err?.message ?? String(err)}\n`);
  process.exitCode = 97;
}
