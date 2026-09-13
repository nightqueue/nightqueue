import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { openDb } from "../../src/memory/db.mjs";
import { makeDir, makeHome, makeProject } from "../../test-support/memory.mjs";

const DECISIONS_MODULE_URL = new URL("../../src/memory/decisions.mjs", import.meta.url).href;
const WRITERS = 4;
const DURATION_MS = 1500;
const RAW_CONSTRAINT_PATTERN = /UNIQUE constraint failed|SQLITE_CONSTRAINT/i;

// Source of the child-process script, generated (not checked in) so this file stays the only PoC on disk.
function buildWriterSource(moduleUrl) {
  return [
    `import { saveDecision } from ${JSON.stringify(moduleUrl)};`,
    "",
    "const [, , scope, owner, label, durationRaw] = process.argv;",
    "const deadline = Date.now() + Number(durationRaw);",
    "let written = 0;",
    "const numbers = [];",
    "const errors = [];",
    "while (Date.now() < deadline) {",
    "  try {",
    "    const row = saveDecision(",
    "      { [scope]: owner, title: `${label}-${written}`, context: `context ${written}`, decision: `decision ${written}` },",
    "      process.env,",
    "    );",
    "    numbers.push(row.number);",
    "    written += 1;",
    "  } catch (err) {",
    '    errors.push(String(err && err.message ? err.message : err));',
    "  }",
    "}",
    'process.stdout.write(JSON.stringify({ written, numbers, errors }) + "\\n");',
  ].join("\n");
}

// Writes the generated writer script into a throwaway directory, cleaned up with the rest of the test.
function writeChildScript(dir) {
  const scriptPath = join(dir, "decision-race-writer.mjs");
  writeFileSync(scriptPath, buildWriterSource(DECISIONS_MODULE_URL), "utf8");
  return scriptPath;
}

// Spawns one real OS process hammering saveDecision into the same owner.
function runWriter(scriptPath, env, { scope, owner }, label, durationMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath, scope, owner, label, String(durationMs)], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

test(
  `${WRITERS} real OS processes racing saveDecision into the same project for ${DURATION_MS}ms ` +
    "(many thousands of attempts, not a single shot) never surface a raw SQLite UNIQUE-constraint error " +
    "and never hand out a duplicate decision number",
  async (t) => {
    const env = makeHome(t, "decision-race");
    makeProject(t, env, "alpha");
    const scriptDir = makeDir(t, "decision-race-script");
    const scriptPath = writeChildScript(scriptDir);

    const labels = Array.from({ length: WRITERS }, (_, index) => `W${index}`);
    const results = await Promise.all(
      labels.map((label) => runWriter(scriptPath, env, { scope: "project", owner: "alpha" }, label, DURATION_MS)),
    );

    results.forEach((result, index) => {
      assert.equal(result.code, 0, `writer ${labels[index]} exited ${result.code} (stderr: ${result.stderr})`);
    });

    const parsed = results.map((result) => JSON.parse(result.stdout.trim().split("\n").pop()));

    // The correct behavior: a raw driver-level constraint failure must never reach a `saveDecision` caller.
    parsed.forEach((data, index) => {
      const rawConstraintErrors = data.errors.filter((message) => RAW_CONSTRAINT_PATTERN.test(message));
      assert.deepEqual(
        rawConstraintErrors,
        [],
        `writer ${labels[index]} received a raw SQLite UNIQUE-constraint error instead of a friendly, ` +
          `retried or actionable failure (R5's "impossible" claim, disproven): ${rawConstraintErrors.join("; ")}`,
      );
    });

    const totalWritten = parsed.reduce((sum, data) => sum + data.written, 0);
    assert.ok(
      totalWritten >= WRITERS * 10,
      `writers produced too few rows (${totalWritten}) to meaningfully exercise the race window`,
    );

    // The correct behavior: every decision number handed to a caller for this project is unique.
    const allNumbers = parsed.flatMap((data) => data.numbers);
    const distinctNumbers = new Set(allNumbers);
    assert.equal(
      distinctNumbers.size,
      allNumbers.length,
      "two concurrent writers received the SAME decision `number` back from saveDecision",
    );

    const db = openDb(env);
    const rows = db.prepare("SELECT number FROM decisions WHERE project IS ? ORDER BY number").all("alpha");
    assert.equal(rows.length, totalWritten, `expected ${totalWritten} decisions, found ${rows.length}`);
    assert.deepEqual(
      rows.map((row) => row.number),
      Array.from({ length: totalWritten }, (_, index) => index + 1),
      "decision numbers are not the contiguous permutation 1..N expected of a correctly serialized append",
    );
  },
);

test(
  `${WRITERS} real OS processes racing saveDecision into the same ORG never hand out a duplicate org number: ` +
    "the partial unique index is what has to catch it",
  async (t) => {
    const env = makeHome(t, "decision-race-org");
    makeProject(t, env, "alpha", { org: "acme" });
    const scriptPath = writeChildScript(makeDir(t, "decision-race-org-script"));

    const labels = Array.from({ length: WRITERS }, (_, index) => `O${index}`);
    const results = await Promise.all(
      labels.map((label) => runWriter(scriptPath, env, { scope: "org", owner: "acme" }, label, DURATION_MS)),
    );

    results.forEach((result, index) => {
      assert.equal(result.code, 0, `writer ${labels[index]} exited ${result.code} (stderr: ${result.stderr})`);
    });
    const parsed = results.map((result) => JSON.parse(result.stdout.trim().split("\n").pop()));
    for (const [index, data] of parsed.entries()) {
      const raw = data.errors.filter((message) => RAW_CONSTRAINT_PATTERN.test(message));
      assert.deepEqual(raw, [], `writer ${labels[index]} received a raw SQLite constraint error: ${raw.join("; ")}`);
    }

    const numbers = parsed.flatMap((data) => data.numbers);
    assert.ok(numbers.length >= WRITERS * 10, `writers produced too few org rows (${numbers.length})`);
    assert.equal(new Set(numbers).size, numbers.length, "two concurrent writers received the SAME org decision number");
    const stored = openDb(env)
      .prepare("SELECT number FROM decisions WHERE scope = 'org' AND org IS ? ORDER BY number")
      .all("acme")
      .map((row) => row.number);
    assert.deepEqual(stored, Array.from({ length: numbers.length }, (_, index) => index + 1));
    assert.equal(openDb(env).prepare("SELECT COUNT(*) AS total FROM decisions WHERE scope = 'project'").get().total, 0);
  },
);
