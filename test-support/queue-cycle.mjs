import { runCycle } from "../src/queue/runner.mjs";

const [, , startAtRaw] = process.argv;

// Waits the given number of milliseconds.
function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms));
}

// Waits for the shared start instant, so the runner processes really start their cycles together.
async function waitForBarrier() {
  const startAt = Number(startAtRaw);
  if (!Number.isFinite(startAt)) return;
  const remaining = startAt - Date.now();
  if (remaining > 0) await sleep(remaining);
}

// Runs ONE cycle of a runner in this process and prints the jobs it processed and why it stopped.
async function main() {
  await waitForBarrier();
  const { processed, reason } = await runCycle({ env: process.env });
  process.stdout.write(`${JSON.stringify({ processed, reason })}\n`);
}

try {
  await main();
} catch (err) {
  process.stderr.write(`CYCLE_ERROR: ${err?.message ?? String(err)}\n`);
  process.exitCode = 1;
}
