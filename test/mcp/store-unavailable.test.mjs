import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { homeDir } from "../../src/config/paths.mjs";
import { createServer } from "../../src/mcp/tools.mjs";
import { TOOL_CONTRACT } from "../../src/mcp/tool-contract.mjs";
import { closeDb, openDb } from "../../src/memory/db.mjs";
import { addJob } from "../../src/memory/jobs.mjs";
import { readRunState } from "../../src/queue/resume.mjs";
import { recordJobBlock } from "../../src/queue/run-state.mjs";
import { ensureProject, makeHome, makeProject } from "../../test-support/memory.mjs";
import { makeSickHome, makeUnreadableHome, unreadableSkip } from "../../test-support/sick-home.mjs";

const CLI = fileURLToPath(new URL("../../bin/nightqueue.mjs", import.meta.url));
const WARNING = /^nightqueue memory unavailable \(SQLITE_NOTADB at .+\): run `nightqueue doctor --fix`$/;

// The real tool server and a client wired together in-process, so every call shares one server instance.
async function connectInProcess(t, env) {
  const server = createServer(env);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "nightqueue-tests-sick", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  t.after(async () => {
    await client.close();
    await server.close();
  });
  return client;
}

// Plain text of a tool result.
function textOf(result) {
  return result.content.map((block) => block.text).join("\n");
}

// A home with a registered project, turned into fixture (iii) - the main file replaced by text.
function sickHome(t, name) {
  const env = makeHome(t, name);
  const repo = makeProject(t, env, "alpha");
  const sick = makeSickHome(env);
  return { env, repo, sick };
}

// Asserts a tool answered the store-unavailable error, with its code, home, hint and contract.
function assertStoreUnavailable(result, env) {
  assert.equal(result.isError, true, textOf(result));
  assert.deepEqual(JSON.parse(textOf(result)), {
    ok: false,
    error: "store-unavailable",
    code: "SQLITE_NOTADB",
    home: homeDir(env),
    hint: "nightqueue doctor --fix",
    message: `the nightqueue database at ${join(homeDir(env), "nightqueue.db")} is unavailable (SQLITE_NOTADB: file is not a database); run \`nightqueue doctor --fix\``,
    contract: TOOL_CONTRACT,
  });
}

test("queue_status and lesson_recall on fixture (iii) answer store-unavailable, and the same server serves after restore", async (t) => {
  const { env, sick } = sickHome(t, "mcp-sick-tools");
  const client = await connectInProcess(t, env);

  assertStoreUnavailable(await client.callTool({ name: "queue_status", arguments: {} }), env);
  assertStoreUnavailable(await client.callTool({ name: "lesson_recall", arguments: { project: "alpha" } }), env);

  sick.restore();
  const status = await client.callTool({ name: "queue_status", arguments: {} });
  assert.notEqual(status.isError, true, textOf(status));
  assert.ok(JSON.parse(textOf(status)).counts, textOf(status));
  const lessons = await client.callTool({ name: "lesson_recall", arguments: { project: "alpha" } });
  assert.notEqual(lessons.isError, true, textOf(lessons));
});

test("three tool calls fired concurrently on fixture (iii) all answer store-unavailable, and the server still serves after restore", async (t) => {
  const { env, sick } = sickHome(t, "mcp-sick-concurrent");
  const client = await connectInProcess(t, env);

  const answers = await Promise.all([
    client.callTool({ name: "queue_status", arguments: {} }),
    client.callTool({ name: "lesson_recall", arguments: { project: "alpha" } }),
    client.callTool({ name: "memory_recall", arguments: { project: "alpha" } }),
  ]);
  for (const answer of answers) assertStoreUnavailable(answer, env);

  sick.restore();
  const after = await Promise.all([
    client.callTool({ name: "queue_status", arguments: {} }),
    client.callTool({ name: "lesson_recall", arguments: { project: "alpha" } }),
    client.callTool({ name: "memory_recall", arguments: { project: "alpha" } }),
  ]);
  for (const answer of after) assert.notEqual(answer.isError, true, textOf(answer));
});

test("context_for_phase on fixture (iii) answers an empty block plus one warning line, not an error", async (t) => {
  const { env } = sickHome(t, "mcp-sick-phase");
  const client = await connectInProcess(t, env);

  const result = await client.callTool({ name: "context_for_phase", arguments: { target: "coder", project: "alpha" } });
  assert.notEqual(result.isError, true, textOf(result));
  const payload = JSON.parse(textOf(result));
  assert.equal(payload.block, "");
  assert.equal(payload.project, "alpha");
  assert.match(payload.warning, WARNING);
  assert.equal(payload.contract, TOOL_CONTRACT);
});

test("a nightqueue mcp subprocess started on fixture (iii) answers initialize and tools/list and stays alive", async (t) => {
  const { env, sick } = sickHome(t, "mcp-sick-subprocess");
  const transport = new StdioClientTransport({ command: process.execPath, args: [CLI, "mcp"], env, stderr: "pipe" });
  let stderr = "";
  transport.stderr?.on("data", (chunk) => {
    stderr += chunk;
  });
  const client = new Client({ name: "nightqueue-tests-sick-stdio", version: "0.0.0" });
  await client.connect(transport);
  t.after(() => client.close());

  const tools = (await client.listTools()).tools;
  assert.ok(tools.length > 0, "the server listed no tool");
  assertStoreUnavailable(await client.callTool({ name: "queue_status", arguments: {} }), env);
  const warnings = stderr.split("\n").filter((line) => WARNING.test(line));
  assert.equal(warnings.length, 1, stderr);

  sick.restore();
  const status = await client.callTool({ name: "queue_status", arguments: {} });
  assert.notEqual(status.isError, true, textOf(status));
});

test("a nightqueue mcp subprocess on a database it cannot open (CANTOPEN) answers initialize and tools/list with one stderr warning", { skip: unreadableSkip() }, async (t) => {
  const env = makeHome(t, "mcp-cantopen-subprocess");
  makeProject(t, env, "alpha");
  makeUnreadableHome(t, env);
  const transport = new StdioClientTransport({ command: process.execPath, args: [CLI, "mcp"], env, stderr: "pipe" });
  let stderr = "";
  transport.stderr?.on("data", (chunk) => {
    stderr += chunk;
  });
  const client = new Client({ name: "nightqueue-tests-cantopen-stdio", version: "0.0.0" });
  await client.connect(transport);
  t.after(() => client.close());

  assert.ok((await client.listTools()).tools.length > 0, "the server listed no tool");
  const warnings = stderr.split("\n").filter((line) => /^nightqueue memory unavailable \(SQLITE_CANTOPEN at .+\): run `nightqueue doctor --fix`$/.test(line));
  assert.equal(warnings.length, 1, stderr);
});

test("nightqueue hook session-start on fixture (iii) prints exactly one line and exits 0", (t) => {
  const { env, repo } = sickHome(t, "hook-sick-session-start");
  const input = JSON.stringify({ cwd: repo, session_id: "sick-session" });
  const result = spawnSync(process.execPath, [CLI, "hook", "session-start"], { env, input, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const lines = result.stdout.split("\n").filter((line) => line.trim());
  assert.equal(lines.length, 1, result.stdout);
  assert.match(lines[0], WARNING);
  assert.equal(result.stderr.trim(), "", "the hook reported the store failure as a crash");
});

test("run_set, run_phase_done and run_outcome inside a job with a job block answer ok on fixture (iii); without a block they answer store-unavailable", async (t) => {
  const env = makeHome(t, "mcp-sick-run-tools");
  makeProject(t, env, "alpha");
  const projectId = ensureProject(env, "alpha");
  const blocked = addJob({ projectId, prompt: "fix the worker", slug: "fix-the-worker" }, env).id;
  const bare = addJob({ projectId, prompt: "fix the other", slug: "fix-the-other" }, env).id;
  const block = { id: blocked, projectKey: "AP", itemRef: null, createdAt: new Date().toISOString() };
  assert.equal(recordJobBlock({ projectId, slug: "fix-the-worker", block, env }).status, "written");
  const sick = makeSickHome(env);
  t.after(() => sick.restore());
  const inJob = await connectInProcess(t, { ...env, NIGHTQUEUE_JOB_ID: String(blocked) });

  const answers = await Promise.all([
    inJob.callTool({ name: "run_set", arguments: { type: "bug/error" } }),
    inJob.callTool({ name: "run_phase_done", arguments: { phase: "triage" } }),
    inJob.callTool({ name: "run_outcome", arguments: { status: "gate", notice: "needs an answer" } }),
  ]);

  for (const answer of answers) {
    assert.notEqual(answer.isError, true, textOf(answer));
    assert.deepEqual({ ...JSON.parse(textOf(answer)), path: null, contract: null }, { ok: true, project: "AP", slug: "fix-the-worker", path: null, contract: null });
  }
  const state = readRunState({ projectId, slug: "fix-the-worker", env });
  assert.equal(state.type, "bug/error");
  assert.deepEqual(state.phases.map((entry) => entry.phase), ["triage"]);
  assert.equal(state.outcome.status, "gate");
  assert.equal(state.job.id, blocked);

  const outside = await connectInProcess(t, { ...env, NIGHTQUEUE_JOB_ID: String(bare) });
  for (const name of ["run_set", "run_phase_done", "run_outcome"]) {
    const args = { run_set: { type: "bug/error" }, run_phase_done: { phase: "triage" }, run_outcome: { status: "done" } }[name];
    assertStoreUnavailable(await outside.callTool({ name, arguments: args }), env);
  }
});

// A home stamped v20 with the project `alpha`, closed so the file alone is the whole database.
function v20Home(t, name) {
  const env = makeHome(t, name);
  const repo = makeProject(t, env, "alpha");
  openDb(env).exec("ALTER TABLE jobs DROP COLUMN origin; ALTER TABLE projects DROP COLUMN integrations; PRAGMA user_version = 20;");
  closeDb(env);
  return { env, repo };
}

const OUTDATED_WARNING = /^nightqueue memory unavailable \(SCHEMA_OUTDATED at .+\): database at v20, this nightqueue expects v23: run `nightqueue update`$/;

test("a nightqueue mcp subprocess on a v20 home warns once with the update message, answers SCHEMA_OUTDATED, and never migrates", async (t) => {
  const { env } = v20Home(t, "mcp-outdated-subprocess");
  const before = readFileSync(join(homeDir(env), "nightqueue.db"));
  const transport = new StdioClientTransport({ command: process.execPath, args: [CLI, "mcp"], env, stderr: "pipe" });
  let stderr = "";
  transport.stderr?.on("data", (chunk) => {
    stderr += chunk;
  });
  const client = new Client({ name: "nightqueue-tests-outdated-stdio", version: "0.0.0" });
  await client.connect(transport);
  t.after(() => client.close());

  const result = await client.callTool({ name: "queue_status", arguments: {} });
  const payload = JSON.parse(textOf(result));
  assert.equal(result.isError, true);
  assert.deepEqual({ error: payload.error, code: payload.code, hint: payload.hint }, { error: "store-unavailable", code: "SCHEMA_OUTDATED", hint: "nightqueue update" });
  assert.match(payload.message, /database at v20, this nightqueue expects v23: run `nightqueue update`/);
  assert.equal(stderr.split("\n").filter((line) => OUTDATED_WARNING.test(line)).length, 1, stderr);
  assert.ok(readFileSync(join(homeDir(env), "nightqueue.db")).equals(before), "the MCP server wrote to an older database");
});

test("nightqueue hook session-start on a v20 home prints the one warning line naming `nightqueue update` and exits 0", (t) => {
  const { env, repo } = v20Home(t, "hook-outdated-session-start");
  const input = JSON.stringify({ cwd: repo, session_id: "outdated-session" });
  const result = spawnSync(process.execPath, [CLI, "hook", "session-start"], { env, input, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const lines = result.stdout.split("\n").filter((line) => line.trim());
  assert.equal(lines.length, 1, result.stdout);
  assert.match(lines[0], OUTDATED_WARNING);
});
