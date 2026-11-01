import assert from "node:assert/strict";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { runDir } from "../../src/config/paths.mjs";
import { openDb } from "../../src/memory/db.mjs";
import { addJob, getJob } from "../../src/memory/jobs.mjs";
import { prepareJobWorktree } from "../../src/queue/job-worktree.mjs";
import { readRunState } from "../../src/queue/resume.mjs";
import { ensureProject, makeDir, makeHome, registerCheckout } from "../../test-support/memory.mjs";
import { useFakeClaude } from "../../test-support/queue-fake.mjs";
import { SLUG } from "../../test-support/streams.mjs";
import { git, gitVars, makeDirty, publishedCheckout, registeredWorktrees } from "../../test-support/worktrees.mjs";

const CLI = fileURLToPath(new URL("../../bin/nightqueue.mjs", import.meta.url));
const BRANCH = `worktree-${SLUG}`;

// A gated job placed by the runtime on its own worktree, with one commit its branch never pushed.
async function placedGateJob(t, name) {
  const { checkout } = publishedCheckout(t, name);
  const env = { ...makeHome(t, name), ...gitVars() };
  registerCheckout(env, { path: checkout, name: "alpha" });
  useFakeClaude(env, makeDir(t, `${name}-plan`), []);
  const projectId = ensureProject(env, "alpha");
  const id = addJob({ projectId, prompt: "fix the worker" }, env).id;
  openDb(env).prepare("UPDATE jobs SET status = 'gate', slug = ?, notice_md = 'why it stopped', finished_at = datetime('now') WHERE id = ?").run(SLUG, id);
  const placed = await prepareJobWorktree({ job: { id, project_id: projectId, slug: SLUG }, checkout, baseBranch: "main", env });
  assert.equal(placed.ok, true, placed.message);
  git(["-C", placed.path, "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-q", "-m", "wip(fix-the-worker): terminated at qa"]);
  const path = readRunState({ projectId, slug: SLUG, env }).worktree;
  return { env, id, checkout, path, runPath: runDir(projectId, SLUG, env), commit: git(["-C", path, "rev-parse", "HEAD"]).trim() };
}

// A real stdio MCP client against `nightqueue mcp`, closed at the end of the test.
async function connect(t, env) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [CLI, "mcp"], env, stderr: "pipe" });
  const client = new Client({ name: "retry-fresh-test", version: "0.0.0" });
  await client.connect(transport);
  t.after(() => client.close());
  return client;
}

// The text blocks of a tool answer, joined.
function textOf(result) {
  return result.content.map((block) => block.text).join("\n");
}

// Tells whether git still registers the worktree of the run.
function isRegistered(run) {
  return registeredWorktrees(run.checkout).some((path) => realpathSync(path) === realpathSync(run.path));
}

test("queue_retry with fresh on a clean unpushed gated worktree removes it, keeps the branch with its commit, names it, and leaves the row pending", async (t) => {
  const run = await placedGateJob(t, "mcp-fresh-clean");
  const client = await connect(t, run.env);

  const result = await client.callTool({ name: "queue_retry", arguments: { job_id: run.id, note: "start over", fresh: true, run: null } });

  assert.notEqual(result.isError, true, textOf(result));
  const answer = JSON.parse(textOf(result));
  assert.deepEqual(answer.worktree, { path: run.path, status: "removed" });
  assert.equal(answer.keptBranch, BRANCH);
  assert.equal(answer.job.status, "pending");
  assert.equal(getJob(run.id, run.env).status, "pending");
  assert.equal(existsSync(run.path), false, "the worktree stayed on disk");
  assert.equal(git(["-C", run.checkout, "rev-parse", BRANCH]).trim(), run.commit, "the kept branch lost its commit");
});

test("the queue_retry description names every refusal of fresh and the kept run directory", async (t) => {
  const client = await connect(t, makeHome(t, "mcp-fresh-description"));

  const { tools } = await client.listTools();
  const { description } = tools.find((tool) => tool.name === "queue_retry");

  for (const word of [/detached/, /locked/, /unreadable/, /runDir/]) assert.match(description, word);
});

test("queue_retry with fresh on a dirty worktree refuses with the exact text and writes nothing", async (t) => {
  const run = await placedGateJob(t, "mcp-fresh-dirty");
  makeDirty(run.path);
  const rowBefore = getJob(run.id, run.env);
  const stateBefore = readFileSync(join(run.runPath, "state.json"), "utf8");
  const client = await connect(t, run.env);

  const refused = await client.callTool({ name: "queue_retry", arguments: { job_id: run.id, note: "start over", fresh: true, run: null } });

  assert.equal(refused.isError, true, "a dirty fresh retry was not refused over MCP");
  assert.ok(textOf(refused).includes(`the worktree has uncommitted changes at ${run.path}; commit or stash them, or retry without --fresh`), textOf(refused));
  assert.deepEqual(getJob(run.id, run.env), rowBefore, "a refused fresh retry wrote to the job row");
  assert.equal(readFileSync(join(run.runPath, "state.json"), "utf8"), stateBefore, "a refused fresh retry changed the run directory");
  assert.equal(isRegistered(run), true, "a refused fresh retry removed the worktree");
  assert.equal(existsSync(join(run.path, "uncommitted.txt")), true, "the uncommitted file was removed");
});
