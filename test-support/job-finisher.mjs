import { existsSync } from "node:fs";
import { packageRoot } from "../src/host/paths.mjs";
import { sqliteToIso } from "../src/memory/db.mjs";
import { finishJob, getJob } from "../src/memory/jobs.mjs";
import { writeRunTerminal } from "../src/queue/resume.mjs";

const [, , jobRaw, worker, project, slug, startAtRaw] = process.argv;
const PR_URL = "https://github.com/acme/api/pull/7";

// Waits the given number of milliseconds.
function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms));
}

// Waits for the shared start instant, so the finish really crosses the writes of the other process.
async function waitForBarrier() {
  const startAt = Number(startAtRaw);
  if (!Number.isFinite(startAt)) return;
  const remaining = startAt - Date.now();
  if (remaining > 0) await sleep(remaining);
}

// Loads the job and its connection while the tree of this process is still there, then announces that the finish is armed.
function warmUp(id) {
  if (!getJob(id, process.env)) throw new Error(`unknown job: ${id}`);
  process.stdout.write(`${JSON.stringify({ ready: true, pid: process.pid, runtimeDir: packageRoot() })}\n`);
}

// Writes the witness of the finish next to the run, the five keys the runner writes.
function writeWitness(row) {
  const terminal = {
    status: row.status,
    prUrl: row.pr_url,
    finishedAt: sqliteToIso(row.finished_at),
    writtenBy: packageRoot(),
    pid: process.pid,
  };
  writeRunTerminal({ project, slug, terminal, env: process.env });
  return terminal;
}

// Finishes one job through the tree THIS file belongs to (every import is relative) and prints what it wrote.
async function main() {
  const id = Number(jobRaw);
  if (!Number.isInteger(id) || id <= 0) throw new Error(`invalid job id: ${String(jobRaw)}`);
  warmUp(id);
  await waitForBarrier();
  const finished = finishJob(id, { worker, status: "done", prUrl: PR_URL, result: { finishedBy: "job-finisher" } }, process.env);
  const terminal = writeWitness(getJob(id, process.env));
  process.stdout.write(`${JSON.stringify({ finished, runtimeGone: !existsSync(packageRoot()), ...terminal })}\n`);
}

try {
  await main();
} catch (err) {
  process.stderr.write(`FINISHER_ERROR: ${err?.message ?? String(err)}\n`);
  process.exitCode = 1;
}
