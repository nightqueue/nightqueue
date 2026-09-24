import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { closeDb } from "../src/memory/db.mjs";
import { saveRoadmapItem } from "../src/memory/roadmap.mjs";
import { makeHome, makeProject } from "./../test-support/memory.mjs";

const CLI = fileURLToPath(new URL("../bin/nightshift.mjs", import.meta.url));
const LONG_TITLE = "keep the roadmap readable when a reader closes the pipe early ".repeat(4);

// A home whose project roadmap holds `count` items with long titles.
function roadmapHome(t, name, count) {
  const env = makeHome(t, name);
  makeProject(t, env, "alpha");
  for (let index = 0; index < count; index += 1) saveRoadmapItem({ type: "improvement", project: "alpha", title: `${LONG_TITLE}${index}` }, env);
  closeDb(env);
  return env;
}

// Runs `nightshift roadmap` and closes its stdout after the first chunk, the way `| head -1` does.
function readFirstChunkOnly(env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", CLI, "roadmap", "--project", "alpha"], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let first = "";
    let stderr = "";
    child.stdout.once("data", (chunk) => {
      first = String(chunk);
      child.stdout.destroy();
    });
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("exit", (code) => resolve({ code, first, stderr }));
  });
}

test("nightshift roadmap survives a reader that closes the pipe after more than 64KB of output", async (t) => {
  const env = roadmapHome(t, "roadmap-epipe-large", 2000);
  const { code, first, stderr } = await readFirstChunkOnly(env);
  assert.match(first, /^todo:/);
  assert.doesNotMatch(stderr, /EPIPE/);
  assert.equal(code, 0, stderr);
});

test("nightshift roadmap with a small output still exits 0 when the reader closes early", async (t) => {
  const env = roadmapHome(t, "roadmap-epipe-small", 3);
  const { code, first, stderr } = await readFirstChunkOnly(env);
  assert.match(first, /^todo:/);
  assert.doesNotMatch(stderr, /EPIPE/);
  assert.equal(code, 0, stderr);
});
