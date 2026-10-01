import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { addIssueComment, queueIssue, saveIssue } from "../src/memory/issues.mjs";
import { makeHome, makeProject, projectIdOf } from "../test-support/memory.mjs";

const CLI = fileURLToPath(new URL("../bin/nightqueue.mjs", import.meta.url));

// Runs the real CLI in its own process, with the isolated home of the test.
function runCli(env, args, cwd) {
  return spawnSync(process.execPath, [CLI, ...args], { env, cwd, encoding: "utf8" });
}

test("`nightqueue issues show <ref>` prints the item in full and its thread in order", async (t) => {
  const env = makeHome(t, "cli-issue-show");
  const cwd = makeProject(t, env, "alpha");
  const detail = `line one\n${"x".repeat(700)}`;
  const item = saveIssue({ type: "bug", projectId: projectIdOf(env, "alpha"), title: "the worker leaks", detail }, env);
  const { job } = await queueIssue({ id: item.id }, env);
  addIssueComment({ id: item.id, body: "seen twice\nin prod" }, env);

  const shown = runCli(env, ["issues", "show", item.ref], cwd);
  assert.equal(shown.status, 0, shown.stderr);
  const lines = shown.stdout.trimEnd().split("\n");
  assert.equal(lines[0], `${item.ref} [bug] in_progress p5`);
  assert.ok(shown.stdout.includes(detail), "the detail was truncated");
  const thread = lines.slice(lines.indexOf("comments:") + 1);
  assert.match(thread[0], new RegExp(` J-${job.id} queued$`));
  assert.equal(thread[1], `    J-${job.id} queued`);
  assert.match(thread[2], / operator note$/);
  assert.deepEqual(thread.slice(3), ["    seen twice", "    in prod"]);

  const json = JSON.parse(runCli(env, ["issues", "show", item.ref, "--json"], cwd).stdout);
  assert.deepEqual(json.comments.map((comment) => comment.kind), ["queued", "note"]);

  const unknown = runCli(env, ["issues", "show", "AP-404"], cwd);
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /unknown issue `AP-404`/);
  const malformed = runCli(env, ["issues", "show", "one"], cwd);
  assert.equal(malformed.status, 1);
  assert.match(malformed.stderr, /expected an issue ref \(`<KEY>-<number>`\), got `one`/);
});
