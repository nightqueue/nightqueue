import { startQueueRunner } from "../src/queue/start.mjs";

const [, , modeRaw, startAtRaw, holdRaw] = process.argv;

// Waits the given number of milliseconds.
function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms));
}

// Waits for the shared start instant, so the two starters really race over the same pidfile.
async function waitForBarrier() {
  const startAt = Number(startAtRaw);
  if (!Number.isFinite(startAt)) return;
  const remaining = startAt - Date.now();
  if (remaining > 0) await sleep(remaining);
}

// Stands in for the detached child: it never spawns anything, and answers with a pid that is alive for as long as this process is.
function fakeSpawn() {
  return { pid: process.pid, unref: () => {} };
}

// Tries exactly ONE start and prints what the guard decided, then stays alive so the loser really sees a live runner.
async function main() {
  const jobId = modeRaw === "once" ? 1 : null;
  const watchIntervalS = modeRaw === "watch" ? 5 : null;
  await waitForBarrier();
  const started = await startQueueRunner({ jobId, watchIntervalS, env: process.env, spawnImpl: fakeSpawn });
  process.stdout.write(`${JSON.stringify({ ...started, own: process.pid })}\n`);
  await sleep(Math.max(0, Number(holdRaw) || 0));
}

try {
  await main();
} catch (err) {
  process.stderr.write(`STARTER_ERROR: ${err?.message ?? String(err)}\n`);
  process.exitCode = 1;
}
