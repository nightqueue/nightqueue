import { appendFileSync, existsSync } from "node:fs";
import { claimJobById } from "../src/memory/jobs.mjs";

const [, , name, targetRaw, canaryRaw, outPath, stopPath] = process.argv;
const MAX_RUN_MS = 30000;

// Yields to the event loop between two claims, and nothing more.
function nextTick() {
  return new Promise((done) => setImmediate(done));
}

// Tries to claim one job and appends the claim to the out file when it was taken.
function claimAndRecord(id) {
  const claimed = claimJobById(id, { worker: `${name}:1`, cap: null }, process.env);
  if (claimed) appendFileSync(outPath, `${JSON.stringify({ id: claimed.id, worker: claimed.worker })}\n`);
}

// Claims the target job and then the canary in a tight loop until the stop file appears or the run ceiling passes.
async function main() {
  const target = Number(targetRaw);
  const canary = Number(canaryRaw);
  if (!Number.isInteger(target) || !Number.isInteger(canary) || !outPath || !stopPath) throw new Error(`invalid arguments: ${process.argv.slice(2).join(" ")}`);
  const deadline = Date.now() + MAX_RUN_MS;
  while (!existsSync(stopPath) && Date.now() < deadline) {
    claimAndRecord(target);
    claimAndRecord(canary);
    await nextTick();
  }
}

try {
  await main();
} catch (err) {
  process.stderr.write(`HAMMER_ERROR: ${err?.message ?? String(err)}\n`);
  process.exitCode = 1;
}
