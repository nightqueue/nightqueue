import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { makeDir, makeHome, makeProject } from "../../test-support/memory.mjs";

const CLI = fileURLToPath(new URL("../../bin/shift.mjs", import.meta.url));

const CONTRACT_TOOLS = ["index_recall", "index_save", "lesson_recall", "lesson_save", "memory_recall", "pipeline_log"];

const LESSON = {
  title: "the worker leaks a file descriptor on failure",
  root_cause: "the early return skipped the close",
  solution: "close it in a finally block",
  prevention: "always close the file descriptor in a finally block",
  attempts: 2,
};

// Connects a real stdio client to `shift mcp`, closed at the end of the test.
async function connect(t, env) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [CLI, "mcp"], env, stderr: "pipe" });
  const client = new Client({ name: "nightshift-tests", version: "0.0.0" });
  await client.connect(transport);
  t.after(() => client.close());
  return client;
}

// JSON payload of a successful tool result.
function payloadOf(result) {
  assert.notEqual(result.isError, true, textOf(result));
  return JSON.parse(textOf(result));
}

// Plain text of a tool result.
function textOf(result) {
  return result.content.map((block) => block.text).join("\n");
}

test("the server exposes exactly the six tools of the contract", async (t) => {
  const env = makeHome(t, "mcp-tools");
  const client = await connect(t, env);
  const names = (await client.listTools()).tools.map((tool) => tool.name).sort();
  assert.deepEqual(names, CONTRACT_TOOLS);
});

test("a lesson saved through the server comes back in the recall, without its embedding", async (t) => {
  const env = makeHome(t, "mcp-lesson");
  makeProject(t, env, "alpha");
  const client = await connect(t, env);

  const saved = payloadOf(await client.callTool({ name: "lesson_save", arguments: { ...LESSON, project: "alpha" } }));
  assert.equal(saved.ok, true);
  assert.equal(saved.deduped, false);

  const recalled = payloadOf(
    await client.callTool({
      name: "lesson_recall",
      arguments: { query: "the worker leaks a file descriptor when the run fails", project: "alpha" },
    }),
  );
  const item = recalled.find((row) => row.id === saved.id);
  assert.ok(item, textOf(await client.callTool({ name: "lesson_recall", arguments: { project: "alpha" } })));
  assert.equal(item.title, LESSON.title);
  assert.equal("embedding" in item, false);
  assert.equal("embedding_model" in item, false);

  const tolerant = await client.callTool({
    name: "lesson_recall",
    arguments: { project: "alpha", target: null, exclude_ids: [1, "2", null, {}] },
  });
  assert.notEqual(tolerant.isError, true, textOf(tolerant));
});

test("an explicit null in any optional field of the six tools is accepted, never an error", async (t) => {
  const env = makeHome(t, "mcp-null");
  const repo = makeProject(t, env, "alpha");
  const client = await connect(t, env);
  const calls = [
    { name: "lesson_recall", arguments: { query: null, project: null, target: null, exclude_ids: null } },
    { name: "lesson_save", arguments: { ...LESSON, attempts: null, project: null, target: null } },
    { name: "memory_recall", arguments: { query: null, project: null } },
    {
      name: "index_save",
      arguments: { project: "alpha", repo_root: repo, files: [{ path: "src/a.mjs", responsibility: "runs" }], libs: null },
    },
    { name: "index_recall", arguments: { project: "alpha", repo_root: null, query: null } },
    {
      name: "pipeline_log",
      arguments: {
        project: null,
        slug: "null-tolerance",
        tier: "simple",
        outcome: "no_commit",
        task_type: null,
        gate_stop: null,
        duration_s: null,
        phases: [{ phase: "coder", model: null, status: null, retry: null, duration_s: null, note: null }],
      },
    },
    { name: "pipeline_log", arguments: { slug: "null-phases", tier: "simple", outcome: "no_commit", phases: null } },
  ];
  for (const call of calls) {
    const result = await client.callTool(call);
    assert.notEqual(result.isError, true, `${call.name} rejected an explicit null: ${textOf(result)}`);
  }
});

test("a value outside an enum comes back as a message, never as a stack", async (t) => {
  const env = makeHome(t, "mcp-enum");
  const client = await connect(t, env);
  const rejected = await client.callTool({ name: "lesson_recall", arguments: { target: "orquestrador" } });
  assert.equal(rejected.isError, true);
  const text = textOf(rejected);
  assert.match(text, /triager/);
  assert.doesNotMatch(text, /\.mjs:\d+/);
  assert.doesNotMatch(text, /\n\s+at /);
});

test("the index round trip reports the freshness of the checkout", async (t) => {
  const env = makeHome(t, "mcp-index");
  const repo = makeProject(t, env, "alpha");
  const file = join(repo, "src", "worker.mjs");
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(file, "export const worker = 1;\n");
  const client = await connect(t, env);

  const saved = payloadOf(
    await client.callTool({
      name: "index_save",
      arguments: {
        project: "alpha",
        repo_root: repo,
        files: [{ path: "src/worker.mjs", responsibility: "runs the jobs" }],
        libs: null,
      },
    }),
  );
  assert.deepEqual(saved, { ok: true, files: 1, libs: 0 });

  const fresh = payloadOf(
    await client.callTool({ name: "index_recall", arguments: { project: "alpha", repo_root: repo } }),
  );
  assert.deepEqual(fresh.files.map((entry) => [entry.path, entry.stale, entry.missing]), [
    ["src/worker.mjs", false, false],
  ]);

  writeFileSync(file, "export const worker = 2;\n");
  const future = new Date(Date.now() + 60000);
  utimesSync(file, future, future);
  const stale = payloadOf(
    await client.callTool({ name: "index_recall", arguments: { project: "alpha", repo_root: repo } }),
  );
  assert.equal(stale.files[0].stale, true);
});

test("memory_recall answers empty and pipeline_log holds the contract of its enums", async (t) => {
  const env = makeHome(t, "mcp-runs");
  makeProject(t, env, "alpha");
  const client = await connect(t, env);

  assert.deepEqual(payloadOf(await client.callTool({ name: "memory_recall", arguments: {} })), []);

  const logged = payloadOf(
    await client.callTool({
      name: "pipeline_log",
      arguments: {
        project: "alpha",
        slug: "fix-the-worker",
        tier: "simple",
        task_type: "bug/error",
        outcome: "no_commit",
        gate_stop: "triage",
        duration_s: null,
        phases: [
          { phase: "triager", model: "opus", status: "ok", retry: null, duration_s: 10, note: null },
          { phase: "architect", status: "skipped" },
        ],
      },
    }),
  );
  assert.equal(logged.ok, true);
  assert.equal(logged.phases, 2);
  assert.ok(Number.isInteger(logged.runId));

  const rejected = await client.callTool({
    name: "pipeline_log",
    arguments: { project: "alpha", slug: "fix-the-worker", tier: "simple", outcome: "pr_aberto" },
  });
  assert.equal(rejected.isError, true);
  assert.doesNotMatch(textOf(rejected), /\.mjs:\d+/);
});

test("the running server does not hold the configuration lock of the home", async (t) => {
  const env = makeHome(t, "mcp-lock");
  const client = await connect(t, env);
  assert.equal((await client.listTools()).tools.length, 6);

  const repo = makeDir(t, "mcp-lock-repo");
  mkdirSync(join(repo, ".git"), { recursive: true });
  const result = spawnSync(process.execPath, [CLI, "init", repo, "--name", "locked"], { env, encoding: "utf8" });
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.match(result.stdout, /registered project `locked`/);
});
