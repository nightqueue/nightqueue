import { openDb } from "../src/memory/db.mjs";
import { reconcileFromWitness } from "../src/queue/reconcile.mjs";

// Terminal columns of every job, read after the repair, so the parent compares the row against the witness it wrote.
function terminalRows(env) {
  return openDb(env).prepare("SELECT id, status, pr_url, finished_at FROM jobs ORDER BY id").all();
}

// Repairs the queue of the home in the environment and reports the rows, together with the timezone offset this process runs under.
function main() {
  const env = process.env;
  const outcome = reconcileFromWitness(env);
  const report = { offsetMinutes: new Date().getTimezoneOffset(), ...outcome, rows: terminalRows(env) };
  process.stdout.write(`${JSON.stringify(report)}\n`);
}

try {
  main();
} catch (err) {
  process.stderr.write(`REPAIRER_ERROR: ${err?.message ?? String(err)}\n`);
  process.exitCode = 1;
}
