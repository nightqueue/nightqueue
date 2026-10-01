import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { onStdoutError } from "../src/cli/index.mjs";
import { closeDb } from "../src/memory/db.mjs";
import { saveIssue } from "../src/memory/issues.mjs";
import { makeHome, makeProject, projectIdOf } from "./../test-support/memory.mjs";

const CLI = fileURLToPath(new URL("../bin/nightqueue.mjs", import.meta.url));
const LONG_TITLE = "keep the roadmap readable when a reader closes the pipe early ".repeat(4);

// A home whose project roadmap holds `count` items with long titles.
function issuesHome(t, name, count) {
  const env = makeHome(t, name);
  makeProject(t, env, "alpha");
  for (let index = 0; index < count; index += 1) saveIssue({ type: "improvement", projectId: projectIdOf(env, "alpha"), title: `${LONG_TITLE}${index}` }, env);
  closeDb(env);
  return env;
}

// Runs `nightqueue roadmap` and closes its stdout after the first chunk, the way `| head -1` does.
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

test("nightqueue roadmap survives a reader that closes the pipe after more than 64KB of output", async (t) => {
  const env = issuesHome(t, "roadmap-epipe-large", 2000);
  const { code, first, stderr } = await readFirstChunkOnly(env);
  assert.match(first, /^todo:/);
  assert.doesNotMatch(stderr, /EPIPE/);
  assert.equal(code, 0, stderr);
});

test("the stdout guard drops output for a reader gone with EPIPE, ENOTCONN or ECONNRESET, and rethrows any other error", () => {
  for (const code of ["EPIPE", "ENOTCONN", "ECONNRESET"]) assert.doesNotThrow(() => onStdoutError(Object.assign(new Error(`write ${code}`), { code })), code);
  const other = Object.assign(new Error("write EIO"), { code: "EIO" });
  assert.throws(() => onStdoutError(other), (err) => err === other);
});

test("nightqueue roadmap with a small output still exits 0 when the reader closes early", async (t) => {
  const env = issuesHome(t, "roadmap-epipe-small", 3);
  const { code, first, stderr } = await readFirstChunkOnly(env);
  assert.match(first, /^todo:/);
  assert.doesNotMatch(stderr, /EPIPE/);
  assert.equal(code, 0, stderr);
});
