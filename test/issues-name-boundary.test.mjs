import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, sep } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

/**
 * The tracker is named issues (v21). Only the migration modules, the published decisions and the tests that build or
 * inspect a pre-v21 database, or replay a recording, may still spell its old name - each of those at a pinned line count,
 * so a new occurrence fails and so does a stale exemption.
 */

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const OLD_NAME = new RegExp(["road", "map"].join(""), "i");
const WALKED = ["src", "test", "plugin", "docs", "scripts", "README.md"];
const EXEMPT_DIRS = [`${join("src", "memory", "migration")}${sep}`, `${join("docs", "decisions")}${sep}`];

const TEST_EXEMPT = Object.freeze({
  "test/cli-decisions-org.test.mjs": { count: 1, reason: "seeds a v5 tracker row before the first migration" },
  "test/memory/db.test.mjs": { count: 2, reason: "legacy DDL and a legacy-home seed row" },
  "test/memory/issue-search.test.mjs": { count: 2, reason: "imports and calls the v16 legacy seeding builder" },
  "test/memory/issues-migration-v17.test.mjs": { count: 9, reason: "builds and inspects a v16/v17 database" },
  "test/memory/migration-v18.test.mjs": { count: 5, reason: "seeds what a v17 build wrote" },
  "test/memory/migration-v19.test.mjs": { count: 2, reason: "seeds a v18 database" },
  "test/memory/migration-v20.test.mjs": { count: 35, reason: "builds and inspects the v19/v20 shape" },
  "test/qa/doctor-v19-orphan-pending.qa.test.mjs": { count: 1, reason: "plants an orphan in a v19 home" },
  "test/queue/fixtures/job-42/03-plan.md": { count: 1, reason: "recorded run, kept verbatim" },
  "test/queue/fixtures/job-42/attempt1-result.jsonl": { count: 1, reason: "recorded transcript, kept verbatim" },
  "test/queue/fixtures/job-49/attempt1-abandoned-command-tail.jsonl": { count: 1, reason: "recorded transcript, kept verbatim" },
});

// Lists every file under a path of the repository, as a path relative to its root.
function filesUnder(path) {
  const absolute = join(ROOT, path);
  let entries;
  try {
    entries = readdirSync(absolute, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOTDIR") return [path];
    throw new Error(`cannot walk ${path}: ${error.message}`);
  }
  return entries.flatMap((entry) => (entry.isDirectory() ? filesUnder(join(path, entry.name)) : [join(path, entry.name)]));
}

// Counts the lines of one file that spell the old name.
function matchingLines(path) {
  return readFileSync(join(ROOT, path), "utf8")
    .split("\n")
    .filter((line) => OLD_NAME.test(line)).length;
}

// Maps every walked, non-exempt-directory file that spells the old name to its line count.
function occurrences() {
  const found = {};
  for (const path of WALKED.flatMap(filesUnder)) {
    if (EXEMPT_DIRS.some((dir) => path.startsWith(dir))) continue;
    const count = matchingLines(path);
    if (count > 0) found[path.split(sep).join("/")] = count;
  }
  return found;
}

test("the pattern catches the old name in any case and lets the new one pass", () => {
  const word = ["road", "map"].join("");
  for (const sample of [word, word.toUpperCase(), `${word}_items`, `Related ${word} items`]) assert.ok(OLD_NAME.test(sample), sample);
  for (const sample of ["issues", "issue_comments", "## Issue", "issue_id"]) assert.ok(!OLD_NAME.test(sample), sample);
});

test("no file outside the exemptions spells the old tracker name", () => {
  const strays = Object.keys(occurrences()).filter((path) => !(path in TEST_EXEMPT));
  assert.deepEqual(strays, [], `old tracker name found in: ${strays.join(", ")}`);
});

test("each exempt file spells the old name exactly its pinned number of times", () => {
  const found = occurrences();
  const drift = Object.entries(TEST_EXEMPT)
    .filter(([path, { count }]) => found[path] !== count)
    .map(([path, { count }]) => `${path}: pinned ${count}, found ${found[path] ?? 0}`);
  assert.deepEqual(drift, [], drift.join("; "));
});
