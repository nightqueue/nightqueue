import { statSync } from "node:fs";
import { dbShmPath } from "../src/config/paths.mjs";
import { openDb } from "../src/memory/db.mjs";

// Opens the database of NIGHTQUEUE_HOME, says which shared-memory file it is attached to and keeps the connection open until this process is killed.
function main() {
  const db = openDb(process.env);
  db.prepare("SELECT COUNT(*) AS n FROM jobs").get();
  const stats = statSync(dbShmPath(process.env), { bigint: true });
  process.stdout.write(`${JSON.stringify({ ready: true, pid: process.pid, ino: String(stats.ino), dev: String(stats.dev) })}\n`);
  setInterval(() => {}, 60000);
}

try {
  main();
} catch (err) {
  process.stderr.write(`HOLDER_ERROR: ${err?.message ?? String(err)}\n`);
  process.exit(1);
}
