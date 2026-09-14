import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

/**
 * `src/store/` is the only path from the rest of `src/` to SQLite, and `src/memory/` is the store's
 * private implementation: outside those two directories nothing opens a connection and nothing
 * prepares a statement. What stays importable from `src/memory/` is only what never touches a
 * connection - the constants of `jobs.mjs` and `orgs.mjs`, the pure helpers of `schema.mjs`,
 * `project-name.mjs` and `scope.mjs`, and the view functions. A future offender is answered by
 * moving that code behind the store, never by qualifying these regexes.
 */

const SRC = fileURLToPath(new URL("../src", import.meta.url));
const ALLOWED_DIRS = ["store", "memory"];
const IMPORTS_DB = [/from\s+["'][^"']*memory\/db\.mjs["']/, /import\(\s*["'][^"']*memory\/db\.mjs["']/];
const PREPARES = [/\.prepare\(/];

// Every `.mjs` file under a directory, at any depth.
function sourceFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.isFile() && entry.name.endsWith(".mjs") ? [path] : [];
  });
}

// Every source file the boundary applies to: all of `src/`, except the store and its implementation.
function guardedFiles() {
  return sourceFiles(SRC)
    .map((path) => relative(SRC, path))
    .filter((path) => !ALLOWED_DIRS.includes(path.split(sep)[0]));
}

// The guarded files whose text matches any of the forms the boundary forbids: a static `import ... from`, an `export ... from` and a dynamic `import()` are three distinct ones.
function offenders(patterns) {
  return guardedFiles().filter((path) => {
    const source = readFileSync(join(SRC, path), "utf8");
    return patterns.some((pattern) => pattern.test(source));
  });
}

test("no file outside src/store/ and src/memory/ imports the connection module", () => {
  const found = offenders(IMPORTS_DB);
  assert.deepEqual(
    found,
    [],
    `\`src/memory/db.mjs\` opens and migrates SQLite: it belongs to the store alone. Import the constants and the pure helpers from \`src/memory/{schema,project-name,scope}.mjs\`, and reach every operation through \`openStore(env)\` (found in ${found.join(", ")})`,
  );
});

test("no file outside src/store/ and src/memory/ prepares a statement", () => {
  const found = offenders(PREPARES);
  assert.deepEqual(
    found,
    [],
    `raw SQL lives next to the tables it queries, in \`src/memory/\`, and is reached through a store method: no file outside the boundary may prepare a statement (found in ${found.join(", ")})`,
  );
});
