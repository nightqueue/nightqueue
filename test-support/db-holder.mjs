import { statSync } from "node:fs";
import { dbShmPath } from "../src/config/paths.mjs";
import { openDb } from "../src/memory/db.mjs";

// Rewrites the prompt of the oldest job through the held connection for every `write <text>` line read on stdin, answering `written` once each is committed.
function writeOnRequest(db) {
  const update = db.prepare("UPDATE jobs SET prompt = ? WHERE id = (SELECT MIN(id) FROM jobs)");
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    for (const line of chunk.split("\n")) {
      if (!line.startsWith("write ")) continue;
      update.run(line.slice("write ".length));
      process.stdout.write("written\n");
    }
  });
}

// Opens the database of NIGHTQUEUE_HOME, says which shared-memory file it is attached to and keeps the connection open until this process is killed.
function main() {
  const db = openDb(process.env);
  db.prepare("SELECT COUNT(*) AS n FROM jobs").get();
  const stats = statSync(dbShmPath(process.env), { bigint: true });
  process.stdout.write(`${JSON.stringify({ ready: true, pid: process.pid, ino: String(stats.ino), dev: String(stats.dev) })}\n`);
  writeOnRequest(db);
  setInterval(() => {}, 60000);
}

try {
  main();
} catch (err) {
  process.stderr.write(`HOLDER_ERROR: ${err?.message ?? String(err)}\n`);
  process.exit(1);
}
