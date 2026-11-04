import assert from "node:assert/strict";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { openDb } from "../../src/memory/db.mjs";
import { lessonRolesOf, pipelineManifest, rolesOf } from "../../src/queue/pipeline-package.mjs";
import { makeHome, makeProject } from "../../test-support/memory.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const LESSON = { title: "a lesson of a role", root_cause: "a cause", solution: "a fix", prevention: "a rule" };

// Connects a real stdio client to the `nightqueue mcp` of one install, closed at the end of the test.
async function connect(t, env, root = ROOT) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(root, "bin", "nightqueue.mjs"), "mcp"], env, stderr: "pipe" });
  const client = new Client({ name: "nightqueue-tests", version: "0.0.0" });
  await client.connect(transport);
  t.after(() => client.close());
  return client;
}

// Plain text of a tool result.
function textOf(result) {
  return result.content.map((block) => block.text).join("\n");
}

// The node_modules the checkout really resolves from: its own, or an ancestor's when the checkout is a worktree nested in another one.
function resolvingNodeModules(root) {
  for (let dir = root; ; dir = dirname(dir)) {
    const candidate = join(dir, "node_modules");
    if (existsSync(join(candidate, "@modelcontextprotocol", "sdk"))) return candidate;
    if (dirname(dir) === dir) throw new Error(`no node_modules with @modelcontextprotocol/sdk above ${root}`);
  }
}

// A throwaway copy of the install whose manifest file `change` rewrites, sharing the node_modules the checkout resolves from.
function installCopy(t, change) {
  const copy = mkdtempSync(join(tmpdir(), "nightqueue-roles-"));
  t.after(() => rmSync(copy, { recursive: true, force: true }));
  for (const entry of ["bin", "src", "plugin", "package.json"]) cpSync(join(ROOT, entry), join(copy, entry), { recursive: true });
  symlinkSync(resolvingNodeModules(ROOT), join(copy, "node_modules"));
  change(join(copy, "plugin", "skills", "resolve", "pipeline", "manifest.json"));
  return copy;
}

// A change of a manifest file that rewrites its JSON through `reshape`.
function reshaped(reshape) {
  return (path) => writeFileSync(path, JSON.stringify(reshape(JSON.parse(readFileSync(path, "utf8")))));
}

const BROKEN_MANIFESTS = [
  ["missing", (path) => rmSync(path), /it is missing/],
  ["not valid JSON", (path) => writeFileSync(path, "{ not json"), /it is not valid JSON/],
  ["with no phases", reshaped(({ phases, ...rest }) => rest), /`phases` is not a list/],
];

const INVALID_MANIFEST_RE = /the pipeline `resolve` has an invalid manifest: .+ \(.*manifest\.json\)/;

// The enum values of one input property of a listed tool, nullable or not.
function enumOf(tools, tool, property) {
  const schema = tools.find((entry) => entry.name === tool).inputSchema.properties[property];
  return schema.enum ?? schema.anyOf?.find((branch) => Array.isArray(branch.enum))?.enum;
}

test("the role enums of the tools equal the manifest's roles, in order", async (t) => {
  const client = await connect(t, makeHome(t, "roles-enums"));
  const { tools } = await client.listTools();
  const manifest = pipelineManifest();
  assert.deepEqual(enumOf(tools, "context_for_agent", "agent"), rolesOf(manifest));
  assert.deepEqual(enumOf(tools, "lesson_save", "target"), lessonRolesOf(manifest));
  assert.deepEqual(enumOf(tools, "lesson_recall", "target"), lessonRolesOf(manifest));
});

test("a role the manifest adds is accepted with no change to the runtime", async (t) => {
  const copy = installCopy(t, reshaped((manifest) => ({ ...manifest, agents: [...manifest.agents, { name: "reviewer", role: "reviewer", lessons: true }] })));
  const client = await connect(t, makeHome(t, "roles-added"), copy);
  const saved = await client.callTool({ name: "lesson_save", arguments: { ...LESSON, target: "reviewer" } });
  assert.notEqual(saved.isError, true, textOf(saved));
  assert.equal(JSON.parse(textOf(saved)).ok, true);
  const context = await client.callTool({ name: "context_for_agent", arguments: { agent: "reviewer" } });
  assert.notEqual(context.isError, true, textOf(context));
  assert.equal(typeof JSON.parse(textOf(context)).block, "string");
});

test("a lesson stored with a target no manifest declares is still recalled without a target", async (t) => {
  const env = makeHome(t, "roles-legacy");
  openDb(env).prepare("INSERT INTO lessons (project_id, title, root_cause, solution, prevention, target) VALUES (NULL, ?, ?, ?, ?, 'legacy-role')").run(LESSON.title, LESSON.root_cause, LESSON.solution, LESSON.prevention);
  const client = await connect(t, env);
  const recalled = await client.callTool({ name: "lesson_recall", arguments: {} });
  assert.notEqual(recalled.isError, true, textOf(recalled));
  assert.ok(textOf(recalled).includes(LESSON.title), textOf(recalled));
});

test("an undeclared target or agent is refused with one line naming every accepted role", async (t) => {
  const client = await connect(t, makeHome(t, "roles-refused"));
  const manifest = pipelineManifest();
  const saved = await client.callTool({ name: "lesson_save", arguments: { ...LESSON, target: "legacy-role" } });
  assert.equal(saved.isError, true);
  for (const role of lessonRolesOf(manifest)) assert.match(textOf(saved), new RegExp(role));
  const context = await client.callTool({ name: "context_for_agent", arguments: { agent: "nobody" } });
  assert.equal(context.isError, true);
  for (const role of rolesOf(manifest)) assert.match(textOf(context), new RegExp(role));
});

// The names of the tools a server lists, sorted.
async function toolNames(client) {
  return (await client.listTools()).tools.map((tool) => tool.name).sort();
}

// Asserts one tool call is refused with the invalid-manifest line, its reason included.
async function assertInvalidManifestRefusal(client, name, args, reason) {
  const answer = await client.callTool({ name, arguments: args });
  assert.equal(answer.isError, true, `${name}: ${textOf(answer)}`);
  assert.equal(textOf(answer).trim().split("\n").length, 1, textOf(answer));
  assert.match(textOf(answer), INVALID_MANIFEST_RE, name);
  assert.match(textOf(answer), reason, name);
}

for (const [label, change, reason] of BROKEN_MANIFESTS) {
  test(`with a manifest ${label} the server lists every tool, the queue and memory tools answer, and the pipeline tools refuse with one line`, async (t) => {
    const healthy = await toolNames(await connect(t, makeHome(t, "roles-healthy")));
    const env = makeHome(t, "roles-broken");
    makeProject(t, env, "alpha");
    const client = await connect(t, env, installCopy(t, change));
    assert.deepEqual(await toolNames(client), healthy);
    for (const [name, args] of [["queue_status", {}], ["lesson_save", LESSON], ["memory_save", { project: "alpha", key: "broken-manifest", value: "kept" }]]) {
      const answer = await client.callTool({ name, arguments: args });
      assert.notEqual(answer.isError, true, `${name}: ${textOf(answer)}`);
    }
    const run = { project: "alpha", slug: "broken-run" };
    await assertInvalidManifestRefusal(client, "run_outcome", { ...run, status: "gate", notice: "a notice" }, reason);
    await assertInvalidManifestRefusal(client, "run_terminate", { ...run, phase: "triage", reason: "a reason" }, reason);
    await assertInvalidManifestRefusal(client, "run_set", { ...run, branch: "a-branch" }, reason);
    await assertInvalidManifestRefusal(client, "context_for_agent", { agent: "coder" }, reason);
  });
}
