import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { openDb } from "../../src/memory/db.mjs";
import { makeDir, makeHome, makeProject } from "../../test-support/memory.mjs";

const ROADMAP_MODULE_URL = new URL("../../src/memory/roadmap.mjs", import.meta.url).href;
const WRITERS = 4;
const DURATION_MS = 1500;

// Source of the child-process script, generated (not checked in) so this file stays the only PoC on disk.
function buildWriterSource(moduleUrl) {
  return [
    `import { saveRoadmapItem } from ${JSON.stringify(moduleUrl)};`,
    "",
    "const [, , project, priorityRaw, label, durationRaw] = process.argv;",
    "const deadline = Date.now() + Number(durationRaw);",
    "let written = 0;",
    "const positions = [];",
    "const errors = [];",
    "while (Date.now() < deadline) {",
    "  try {",
    "    const row = saveRoadmapItem({ type: 'improvement', project, priority: Number(priorityRaw), title: `${label}-${written}` }, process.env);",
    "    positions.push(row.position);",
    "    written += 1;",
    "  } catch (err) {",
    '    errors.push(String(err && err.message ? err.message : err));',
    "  }",
    "}",
    'process.stdout.write(JSON.stringify({ written, positions, errors }) + "\\n");',
  ].join("\n");
}

// Writes the generated writer script into a throwaway directory, cleaned up with the rest of the test.
function writeChildScript(dir) {
  const scriptPath = join(dir, "roadmap-race-writer.mjs");
  writeFileSync(scriptPath, buildWriterSource(ROADMAP_MODULE_URL), "utf8");
  return scriptPath;
}

// Spawns one real OS process hammering saveRoadmapItem into the same (project, priority) group.
function runWriter(scriptPath, env, project, priority, label, durationMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath, project, String(priority), label, String(durationMs)], {
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
  `${WRITERS} real OS processes racing saveRoadmapItem into the same priority group for ${DURATION_MS}ms ` +
    "(many thousands of attempts, not a single shot) never leave a duplicate or gapped position",
  async (t) => {
    const env = makeHome(t, "roadmap-race");
    makeProject(t, env, "alpha");
    const scriptDir = makeDir(t, "roadmap-race-script");
    const scriptPath = writeChildScript(scriptDir);

    const labels = Array.from({ length: WRITERS }, (_, index) => `W${index}`);
    const results = await Promise.all(
      labels.map((label) => runWriter(scriptPath, env, "alpha", 5, label, DURATION_MS)),
    );

    results.forEach((result, index) => {
      assert.equal(result.code, 0, `writer ${labels[index]} exited ${result.code} (stderr: ${result.stderr})`);
    });

    const parsed = results.map((result) => JSON.parse(result.stdout.trim().split("\n").pop()));
    parsed.forEach((data, index) => {
      assert.deepEqual(
        data.errors,
        [],
        `writer ${labels[index]} saw an error mid-race (should never happen: no UNIQUE constraint guards ` +
          `roadmap position): ${data.errors.join("; ")}`,
      );
    });

    const totalWritten = parsed.reduce((sum, data) => sum + data.written, 0);
    assert.ok(
      totalWritten >= WRITERS * 10,
      `writers produced too few rows (${totalWritten}) to meaningfully exercise the race window`,
    );

    const db = openDb(env);
    const rows = db
      .prepare("SELECT position FROM roadmap_items WHERE project IS ? AND priority = ? ORDER BY position")
      .all("alpha", 5);
    assert.equal(
      rows.length,
      totalWritten,
      `expected ${totalWritten} rows (one per successful write), found ${rows.length} — a write vanished`,
    );

    const positions = rows.map((row) => row.position);
    const distinctPositions = new Set(positions);
    assert.equal(
      distinctPositions.size,
      positions.length,
      `two concurrent writers landed on the SAME position — duplicates found: ${positions.join(",")}`,
    );
    assert.deepEqual(
      positions,
      Array.from({ length: totalWritten }, (_, index) => index + 1),
      "positions are not the contiguous permutation 1..N expected of a correctly serialized append",
    );
  },
);
