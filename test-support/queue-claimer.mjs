import { acquire, concurrencyCap } from "../src/queue/claim.mjs";

const [, , capRaw, jobRaw, startAtRaw] = process.argv;

// Waits the given number of milliseconds.
function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms));
}

// Waits for the shared start instant, so the two claimers really race over the same rows.
async function waitForBarrier() {
  const startAt = Number(startAtRaw);
  if (!Number.isFinite(startAt)) return;
  const remaining = startAt - Date.now();
  if (remaining > 0) await sleep(remaining);
}

// Reads the cap token: `config` is the ceiling the home configured (possibly none), anything else a positive integer.
function parseCap(raw) {
  if (raw === "config") return concurrencyCap(process.env);
  const cap = Number(raw);
  if (!Number.isInteger(cap) || cap <= 0) throw new Error(`invalid cap: ${String(raw)}`);
  return cap;
}

// Tries exactly ONE claim and prints the job it took, or the reason the queue refused it.
async function main() {
  const cap = parseCap(capRaw);
  const jobId = jobRaw === undefined || jobRaw === "" || jobRaw === "any" ? null : Number(jobRaw);
  await waitForBarrier();
  const claimed = await acquire({ jobId, cap, env: process.env });
  process.stdout.write(`${JSON.stringify({ id: claimed.job?.id ?? null, reason: claimed.reason, worker: claimed.job?.worker ?? null })}\n`);
}

try {
  await main();
} catch (err) {
  process.stderr.write(`CLAIMER_ERROR: ${err?.message ?? String(err)}\n`);
  process.exitCode = 1;
}
