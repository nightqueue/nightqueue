import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const SRC = fileURLToPath(new URL("../../src", import.meta.url));
const DEFINITION = join(SRC, "memory", "db.mjs");
const CALL = /closeDb\s*\(/;

// Every `.mjs` file under a directory, at any depth.
function sourceFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.isFile() && entry.name.endsWith(".mjs") ? [path] : [];
  });
}

test("no production code closes the cached connection of a home", () => {
  const offenders = sourceFiles(SRC)
    .filter((path) => path !== DEFINITION && CALL.test(readFileSync(path, "utf8")))
    .map((path) => relative(SRC, path));

  assert.deepEqual(
    offenders,
    [],
    `\`closeDb\` is test-only: a close SQLite believes is the last one deletes \`-shm\`/\`-wal\`, and a filesystem that does not enforce the advisory lock of a live connection lets that happen under a runner still attached to them (found in ${offenders.join(", ")})`,
  );
});
