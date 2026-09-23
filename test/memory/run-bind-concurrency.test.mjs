import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { openDb } from "../../src/memory/db.mjs";
import { makeDir, makeHome, makeProject } from "../../test-support/memory.mjs";

const JOBS_MODULE_URL = new URL("../../src/memory/jobs.mjs", import.meta.url).href;
const WRITERS = 4;
const SLUGS = 60;

// Source of the child-process script: it tries to bind one job to every run slug, in order, and reports what it got.
function buildBinderSource(moduleUrl) {
  return [
    `import { addJob } from ${JSON.stringify(moduleUrl)};`,
    "",
    "const [, , slugCount] = process.argv;",
    "const bound = [];",
    "const errors = [];",
    "for (let index = 0; index < Number(slugCount); index += 1) {",
    "  try {",
    "    addJob({ project: 'alpha', prompt: '## Brief\\nfix it', slug: `run-${index}` }, process.env);",
    "    bound.push(`run-${index}`);",
    "  } catch (err) {",
    "    errors.push(String(err && err.message ? err.message : err));",
    "  }",
    "}",
    'process.stdout.write(JSON.stringify({ bound, errors }) + "\\n");',
  ].join("\n");
}

// Spawns one real OS process racing the others to bind the same run slugs.
function runBinder(scriptPath, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath, String(SLUGS)], { env, stdio: ["ignore", "pipe", "pipe"] });
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

test(`${WRITERS} real OS processes binding the same ${SLUGS} run slugs leave exactly one open job per run`, async (t) => {
  const env = makeHome(t, "run-bind-race");
  makeProject(t, env, "alpha");
  const scriptPath = join(makeDir(t, "run-bind-race-script"), "run-bind-writer.mjs");
  writeFileSync(scriptPath, buildBinderSource(JOBS_MODULE_URL), "utf8");

  const results = await Promise.all(Array.from({ length: WRITERS }, () => runBinder(scriptPath, env)));
  const reports = results.map((result) => {
    assert.equal(result.code, 0, result.stderr);
    return JSON.parse(result.stdout);
  });

  for (const report of reports) {
    for (const message of report.errors) assert.match(message, /^job #\d+ already runs from /);
  }
  assert.equal(reports.flatMap((report) => report.bound).length, SLUGS);
  const rows = openDb(env).prepare("SELECT slug, COUNT(*) AS jobs FROM jobs WHERE project = 'alpha' GROUP BY slug").all();
  assert.equal(rows.length, SLUGS);
  for (const row of rows) assert.equal(row.jobs, 1, `run ${row.slug} is bound to ${row.jobs} jobs`);
});
