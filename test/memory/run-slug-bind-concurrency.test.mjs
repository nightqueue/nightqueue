import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { addJob, claimJobById, getJob } from "../../src/memory/jobs.mjs";
import { slugCandidates } from "../../src/queue/spawn.mjs";
import { makeDir, makeHome, makeProject } from "../../test-support/memory.mjs";

const JOBS_MODULE_URL = new URL("../../src/memory/jobs.mjs", import.meta.url).href;
const WRITERS = 4;
const BASE = "fix-the-worker-of-the-queue";

// Source of the child-process script: it waits for the barrier file, then claims a run slug for its own job and reports what it got.
function buildBinderSource(moduleUrl) {
  return [
    'import { existsSync } from "node:fs";',
    `import { bindRunSlug } from ${JSON.stringify(moduleUrl)};`,
    "",
    "const [, , id, worker, barrier, candidates] = process.argv;",
    "while (!existsSync(barrier)) await new Promise((done) => setTimeout(done, 2));",
    "const bound = bindRunSlug(Number(id), { worker, candidates: JSON.parse(candidates) }, process.env);",
    'process.stdout.write(JSON.stringify(bound) + "\\n");',
  ].join("\n");
}

// Spawns one real OS process that races the others to bind its job to the same run slugs.
function runBinder(scriptPath, env, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
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

test(`${WRITERS} real OS processes binding their jobs to the same run slugs at once never share one`, async (t) => {
  const env = makeHome(t, "run-slug-bind-race");
  makeProject(t, env, "alpha");
  const dir = makeDir(t, "run-slug-bind-race-script");
  const scriptPath = join(dir, "run-slug-binder.mjs");
  const barrier = join(dir, "go");
  writeFileSync(scriptPath, buildBinderSource(JOBS_MODULE_URL), "utf8");
  const candidates = JSON.stringify(slugCandidates(BASE, 0));
  const jobs = Array.from({ length: WRITERS }, (_, index) => {
    const id = addJob({ project: "alpha", prompt: "fix the worker of the queue" }, env).id;
    claimJobById(id, { worker: `host:${index}`, cap: null }, env);
    return { id, worker: `host:${index}` };
  });

  const racing = jobs.map((job) => runBinder(scriptPath, env, [String(job.id), job.worker, barrier, candidates]));
  writeFileSync(barrier, "");
  const results = await Promise.all(racing);

  const slugs = results.map((result) => {
    assert.equal(result.code, 0, result.stderr);
    const bound = JSON.parse(result.stdout);
    assert.equal(bound.status, "bound");
    return bound.slug;
  });
  assert.deepEqual([...slugs].sort(), [BASE, `${BASE}-2`, `${BASE}-3`, `${BASE}-4`]);
  assert.deepEqual(jobs.map((job) => getJob(job.id, env).slug), slugs);
});
