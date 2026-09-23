import assert from "node:assert/strict";
import { realpathSync, rmSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { defaultContext, run } from "../../src/cli/index.mjs";
import { addProject } from "../../src/config/projects.mjs";
import { loadConfig, saveConfig } from "../../src/config/store.mjs";
import { openDb } from "../../src/memory/db.mjs";
import { addJob, claimJobById } from "../../src/memory/jobs.mjs";
import { recordRunFields } from "../../src/queue/run-state.mjs";
import { makeHome } from "../../test-support/memory.mjs";
import { addWorktree, gitVars, publishedCheckout } from "../../test-support/worktrees.mjs";

const CLI = fileURLToPath(new URL("../../bin/nightshift.mjs", import.meta.url));

// A home whose project `alpha` is a real published checkout.
function makeSessionHome(t, name) {
  const { checkout } = publishedCheckout(t, name);
  const env = { ...makeHome(t, name), ...gitVars() };
  saveConfig(addProject(loadConfig(env, { warn: () => {} }), { path: checkout, name: "alpha" }).config, env);
  return { env, checkout };
}

// A job whose row already recorded the session and attempt of its last try, at the given status.
function jobWithSession(home, { slug, status, session, attempt, worktree = null }) {
  const id = addJob({ project: "alpha", prompt: `work of ${slug}` }, home.env).id;
  claimJobById(id, { worker: "w1", cap: null }, home.env);
  openDb(home.env)
    .prepare("UPDATE jobs SET status = ?, slug = ?, attempts = ?, last_session_id = ?, last_session_attempt = ? WHERE id = ?")
    .run(status, slug, attempt, session, attempt, id);
  if (worktree) recordRunFields({ project: "alpha", slug, fields: { worktree }, env: home.env });
  return id;
}

// Runs `nightshift queue session ...` in this process, capturing stdout and stderr.
async function runQueueSession(env, argv, extraCtx = {}) {
  const out = [];
  const err = [];
  const code = await run(argv, { ...defaultContext(), env, out: (line) => out.push(line), err: (line) => err.push(line), ...extraCtx });
  return { code, out, err };
}

test("`queue session --print` on a job with three attempts opens the third attempt's session", async (t) => {
  const home = makeSessionHome(t, "session-three-attempts");
  const worktree = addWorktree(home.checkout, "feat+three-attempts");
  const id = jobWithSession(home, { slug: "three-attempts", status: "done", session: "sess-attempt-3", attempt: 3, worktree: worktree.path });

  const result = await runQueueSession(home.env, ["queue", "session", String(id), "--print"]);

  assert.equal(result.code, 0, result.err.join("\n"));
  assert.deepEqual(result.out, [
    `job ${id} · attempt 3 · session sess-attempt-3 · cwd ${worktree.path}`,
    `cd '${worktree.path}' && nightshift open --resume sess-attempt-3`,
  ]);
});

test("`queue session` falls back to the checkout and says so when the run's worktree was released", async (t) => {
  const home = makeSessionHome(t, "session-worktree-released");
  const worktree = addWorktree(home.checkout, "feat+released");
  const id = jobWithSession(home, { slug: "released", status: "done", session: "sess-released", attempt: 1, worktree: worktree.path });
  rmSync(worktree.path, { recursive: true, force: true });

  const result = await runQueueSession(home.env, ["queue", "session", String(id), "--print"]);

  assert.equal(result.code, 0, result.err.join("\n"));
  assert.deepEqual(result.out, [
    `job ${id} · attempt 1 · session sess-released · cwd ${realpathSync(home.checkout)} (worktree released, using the checkout)`,
    `cd '${realpathSync(home.checkout)}' && nightshift open --resume sess-released`,
  ]);
});

test("`queue session` refuses a running job, and a pending one too", async (t) => {
  const home = makeSessionHome(t, "session-refusals");
  const running = jobWithSession(home, { slug: "running-run", status: "running", session: "sess-running", attempt: 1 });
  const pending = addJob({ project: "alpha", prompt: "never ran" }, home.env).id;

  const runningResult = await runQueueSession(home.env, ["queue", "session", String(running)]);
  assert.equal(runningResult.code, 1);
  assert.match(runningResult.err.join("\n"), /is running \(worker .*\) and its runner owns the session/);

  const pendingResult = await runQueueSession(home.env, ["queue", "session", String(pending)]);
  assert.equal(pendingResult.code, 1);
  assert.match(pendingResult.err.join("\n"), /has not run yet; there is no session to resume/);
});

test("`queue session` refuses a job that recorded no session", async (t) => {
  const home = makeSessionHome(t, "session-no-session");
  const id = addJob({ project: "alpha", prompt: "blocked before it reached the agent" }, home.env).id;
  openDb(home.env).prepare("UPDATE jobs SET status = 'failed' WHERE id = ?").run(id);

  const result = await runQueueSession(home.env, ["queue", "session", String(id)]);

  assert.equal(result.code, 1);
  assert.match(result.err.join("\n"), /recorded no session; it never reached the agent/);
});

test("`queue session` resumes through the operator launcher in the resolved cwd, through the injected spawn", async (t) => {
  const home = makeSessionHome(t, "session-exec");
  const worktree = addWorktree(home.checkout, "feat+exec");
  const id = jobWithSession(home, { slug: "exec-run", status: "done", session: "sess-exec", attempt: 1, worktree: worktree.path });
  const calls = [];

  const result = await runQueueSession(home.env, ["queue", "session", String(id)], {
    resolveBinImpl: () => ({ bin: "/opt/claude/claude", via: "test" }),
    spawnSyncImpl: (bin, args, options) => {
      calls.push({ bin, args, options });
      return args[0] === "--help" ? { status: 0, stdout: "  --agent <agent>  Agent for the current session\n" } : { status: 0 };
    },
  });

  assert.equal(result.code, 0, result.err.join("\n"));
  const session = calls.filter((call) => call.args.includes("--resume"));
  assert.equal(session.length, 1);
  const [claude] = session;
  assert.equal(claude.bin, "/opt/claude/claude");
  assert.equal(claude.args[claude.args.indexOf("--agent") + 1], "nightshift:nightshift-operator");
  assert.equal(claude.args[claude.args.indexOf("--resume") + 1], "sess-exec");
  assert.equal(claude.options.env.NIGHTSHIFT_MODE, "operator");
  assert.equal(claude.options.cwd, worktree.path);
  assert.equal(claude.options.stdio, "inherit");
  assert.ok(calls.some((call) => call.bin === "git" && call.args.join(" ") === "worktree prune"), "git worktree prune did not run first");
});

test("MCP queue_session returns the attempt, session and cwd of the last attempt, and never execs", async (t) => {
  const home = makeSessionHome(t, "session-mcp");
  const worktree = addWorktree(home.checkout, "feat+mcp-session");
  const id = jobWithSession(home, { slug: "mcp-session", status: "done", session: "sess-mcp", attempt: 2, worktree: worktree.path });
  const transport = new StdioClientTransport({ command: process.execPath, args: [CLI, "mcp"], env: home.env, stderr: "pipe" });
  const client = new Client({ name: "nightshift-tests", version: "0.0.0" });
  await client.connect(transport);
  t.after(() => client.close());

  const result = await client.callTool({ name: "queue_session", arguments: { job_id: id } });

  assert.notEqual(result.isError, true, JSON.stringify(result));
  const payload = JSON.parse(result.content.map((block) => block.text).join("\n"));
  assert.deepEqual(payload, { job_id: id, attempt: 2, session: "sess-mcp", cwd: worktree.path, worktree_released: false });
});

test("MCP queue_session refuses a running job by name, with no session field leaked", async (t) => {
  const home = makeSessionHome(t, "session-mcp-refusal");
  const id = jobWithSession(home, { slug: "mcp-running", status: "running", session: "sess-mcp-running", attempt: 1 });
  const transport = new StdioClientTransport({ command: process.execPath, args: [CLI, "mcp"], env: home.env, stderr: "pipe" });
  const client = new Client({ name: "nightshift-tests", version: "0.0.0" });
  await client.connect(transport);
  t.after(() => client.close());

  const result = await client.callTool({ name: "queue_session", arguments: { job_id: id } });

  assert.equal(result.isError, true);
  assert.match(result.content.map((block) => block.text).join("\n"), /is running \(worker .*\) and its runner owns the session/);
});
