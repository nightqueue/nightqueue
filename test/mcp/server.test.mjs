import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { homeDir, queuePausedPath, runnersDir } from "../../src/config/paths.mjs";
import { loadConfig, saveConfig } from "../../src/config/store.mjs";
import { openDb } from "../../src/memory/db.mjs";
import { addJob, claimJobById, getJob, parkJob } from "../../src/memory/jobs.mjs";
import { DB_USER_VERSION } from "../../src/memory/schema.mjs";
import { clockLabel } from "../../src/queue/hints.mjs";
import { writeRunnerRecord } from "../../src/queue/registry.mjs";
import { assertIsolatedEnv, isolatedHostVars } from "../../test-support/host.mjs";
import { makeDir, makeHome, makeProject, seedLegacyV8Home } from "../../test-support/memory.mjs";
import { FAKE_CLAUDE } from "../../test-support/queue-fake.mjs";

const CLI = fileURLToPath(new URL("../../bin/nightshift.mjs", import.meta.url));
const GATED_FINISHED_AT = "2020-01-01 00:00:00";
const HOME_REFUSAL =
  "refused: this command would change the operator's nightshift home from inside job #9; verify against a temporary home (NIGHTSHIFT_HOME=$(mktemp -d)) instead";

const CONTRACT_TOOLS = [
  "context_for_phase",
  "decision_list",
  "decision_recall",
  "decision_save",
  "decision_update",
  "index_recall",
  "index_save",
  "lesson_recall",
  "lesson_save",
  "memory_recall",
  "pipeline_log",
  "queue_add",
  "queue_cancel",
  "queue_close",
  "queue_retry",
  "queue_run",
  "queue_session",
  "queue_status",
  "roadmap_get",
  "roadmap_save",
  "roadmap_update",
  "run_outcome",
  "run_phase_done",
  "run_set",
  "run_terminate",
];

const LESSON = {
  title: "the worker leaks a file descriptor on failure",
  root_cause: "the early return skipped the close",
  solution: "close it in a finally block",
  prevention: "always close the file descriptor in a finally block",
  attempts: 2,
};

// Connects a real stdio client to `nightshift mcp`, closed at the end of the test.
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

test("the server exposes exactly the twenty-five tools of the contract", async (t) => {
  const env = makeHome(t, "mcp-tools");
  const client = await connect(t, env);
  const names = (await client.listTools()).tools.map((tool) => tool.name).sort();
  assert.deepEqual(names, CONTRACT_TOOLS);
  assert.equal(names.length, 25, "the contract list and the server disagree on how many tools there are");
});

test("the server migrates a v8 home to v9 once at boot, before it answers any tool", async (t) => {
  const env = makeHome(t, "mcp-v9-migration");
  makeProject(t, env, "alpha");
  seedLegacyV8Home(env, { rows: 1 });
  const client = await connect(t, env);

  const status = payloadOf(await client.callTool({ name: "queue_status", arguments: {} }));
  assert.equal(status.jobs[0].status, "closed", "the boot never migrated the v8 home");

  const db = openDb(env);
  assert.equal(db.prepare("PRAGMA user_version").get().user_version, DB_USER_VERSION);
  assert.equal(db.prepare("PRAGMA table_info(jobs)").all().some((column) => column.name === "pr_checked_at"), false);
});

test("the handshake carries the instructions that teach the backlog model", async (t) => {
  const env = makeHome(t, "mcp-instructions");
  const client = await connect(t, env);

  const instructions = client.getInstructions();
  assert.equal(typeof instructions, "string", "the server answered the handshake without instructions");
  assert.ok(instructions.length > 0, "the instructions came back empty");
  for (const idea of [
    "backlog",
    "self-contained",
    "numbered stages",
    "Do not start jobs as they are queued",
    "`queue_run` without `job_id`",
    "queue_retry",
    "queue_status",
  ]) {
    assert.ok(instructions.includes(idea), `\`${idea}\` is missing from the instructions:\n${instructions}`);
  }
});

test("the queue_add tool states the job-cutting rule on the tool and on the prompt field", async (t) => {
  const env = makeHome(t, "mcp-queue-add-rule");
  const client = await connect(t, env);
  const tools = (await client.listTools()).tools;

  const add = tools.find((tool) => tool.name === "queue_add");
  assert.ok(add, "the queue_add tool is missing");
  for (const word of ["self-contained", "stages"]) {
    assert.ok(add.description.includes(word), `\`${word}\` is missing from the queue_add description`);
    assert.ok(
      add.inputSchema.properties.prompt.description?.includes(word),
      `\`${word}\` is missing from the description of the prompt parameter`,
    );
  }

  const status = tools.find((tool) => tool.name === "queue_status");
  assert.ok(status.description.startsWith("State of the queue"), "queue_status must not be touched");
  assert.ok(status.description.includes("notice_md"), "queue_status does not say where the reason of a gate lives");
  assert.ok(status.description.includes("queue_retry"), "queue_status does not point at the way to answer a gate");
});

test("a lesson saved through the server comes back in the recall, without its embedding", async (t) => {
  const env = makeHome(t, "mcp-lesson");
  makeProject(t, env, "alpha");
  const client = await connect(t, env);

  const saved = payloadOf(await client.callTool({ name: "lesson_save", arguments: { ...LESSON, project: "alpha" } }));
  assert.equal(saved.ok, true);
  assert.equal(saved.deduped, false);
  assert.deepEqual(saved.incomplete, []);

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

test("lesson_save with attempts: 1 is accepted and stored as null, never rejected", async (t) => {
  const env = makeHome(t, "mcp-lesson-attempts-one");
  makeProject(t, env, "alpha");
  const client = await connect(t, env);
  const saved = payloadOf(
    await client.callTool({ name: "lesson_save", arguments: { ...LESSON, attempts: 1, project: "alpha" } }),
  );
  assert.equal(saved.ok, true);
  assert.equal(saved.attempts, null);
});

test("an explicit null in any optional field of the memory tools is accepted, never an error", async (t) => {
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

  const raised = payloadOf(
    await client.callTool({
      name: "pipeline_log",
      arguments: {
        project: "alpha",
        slug: "raise-the-tier",
        tier: "complex",
        tier_operator: "simple",
        tier_raise_reason: "stack trace in the claim path",
        outcome: "pr_opened",
      },
    }),
  );
  const rows = openDb(env).prepare("SELECT * FROM pipeline_runs ORDER BY id").all();
  const stored = rows.find((row) => row.id === raised.runId);
  assert.deepEqual(
    { tier: stored.tier, operator: stored.tier_operator, reason: stored.tier_raise_reason },
    { tier: "complex", operator: "simple", reason: "stack trace in the claim path" },
  );
  const plain = rows.find((row) => row.slug === "fix-the-worker");
  assert.deepEqual({ operator: plain.tier_operator, reason: plain.tier_raise_reason }, { operator: null, reason: null });

  const badTier = await client.callTool({
    name: "pipeline_log",
    arguments: { project: "alpha", slug: "fix-the-worker", tier: "simple", tier_operator: "urgent", outcome: "pr_opened" },
  });
  assert.equal(badTier.isError, true);
  assert.doesNotMatch(textOf(badTier), /\.mjs:\d+/);
});

test("outside a job, a `pipeline_log` that names no run is refused by both fields and records nothing", async (t) => {
  const env = makeHome(t, "mcp-runs-orphan");
  makeProject(t, env, "alpha");
  const client = await connect(t, env);

  const orphan = await client.callTool({ name: "pipeline_log", arguments: { tier: "simple", outcome: "pr_opened" } });
  assert.equal(orphan.isError, true);
  assert.match(textOf(orphan), /`project`/);
  assert.match(textOf(orphan), /`slug`/);
  assert.doesNotMatch(textOf(orphan), /\.mjs:\d+/);

  const noTier = await client.callTool({ name: "pipeline_log", arguments: { project: "alpha", slug: "no-tier-anywhere", outcome: "pr_opened" } });
  assert.equal(noTier.isError, true);
  assert.match(textOf(noTier), /`tier` is required/);
  assert.match(textOf(noTier), /run_set/);

  assert.deepEqual(openDb(env).prepare("SELECT id FROM pipeline_runs").all(), [], "a refused call left an orphan row behind");

  const named = payloadOf(await client.callTool({ name: "pipeline_log", arguments: { slug: "no-project-at-all", tier: "simple", outcome: "no_commit" } }));
  assert.ok(Number.isInteger(named.runId), "a call naming only the slug still records its run");
});

test("the running server does not hold the configuration lock of the home", async (t) => {
  const env = makeHome(t, "mcp-lock");
  const client = await connect(t, env);
  assert.equal((await client.listTools()).tools.length, CONTRACT_TOOLS.length);

  const repo = makeDir(t, "mcp-lock-repo");
  mkdirSync(join(repo, ".git"), { recursive: true });
  const result = spawnSync(process.execPath, [CLI, "init", repo, "--name", "locked", "--no-gh"], {
    env: assertIsolatedEnv({ ...env, ...isolatedHostVars(makeDir(t, "mcp-lock-host")) }),
    encoding: "utf8",
  });
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.match(result.stdout, /registered project `locked`/);
});

// A directory that looks like a git repository, without calling git.
function makeRepo(t, name) {
  const dir = makeDir(t, name);
  mkdirSync(join(dir, ".git"), { recursive: true });
  return dir;
}

// Parsed config.json of a home.
function readConfig(env) {
  return JSON.parse(readFileSync(join(homeDir(env), "config.json"), "utf8"));
}

// A home whose queue is paused, so a detached runner started by a test never claims anything.
function makeQueueHome(t, name) {
  const env = makeHome(t, name);
  makeProject(t, env, "alpha");
  env.NIGHTSHIFT_CLAUDE_BIN = FAKE_CLAUDE;
  writeFileSync(queuePausedPath(env), `${new Date().toISOString()}\n`);
  return env;
}

test("queue_add enqueues by project NAME and refuses a path or a project nobody registered", async (t) => {
  const env = makeQueueHome(t, "mcp-queue-add");
  const client = await connect(t, env);

  const queued = payloadOf(await client.callTool({ name: "queue_add", arguments: { project: "alpha", prompt: "fix the worker", priority: 2, timeout_s: 600 } }));
  assert.deepEqual(queued, {
    ok: true,
    id: 1,
    project: "alpha",
    priority: 2,
    timeoutS: 600,
    hint: "queued job #1 for `alpha` (1 pending). 0 runners online - pending jobs will wait until `nightshift queue run` starts one.",
  });
  assert.equal(getJob(1, env).prompt, "fix the worker");

  const second = payloadOf(await client.callTool({ name: "queue_add", arguments: { project: "alpha", prompt: "fix the parser" } }));
  assert.equal(second.hint, "queued job #2 for `alpha` (2 pending). 0 runners online - pending jobs will wait until `nightshift queue run` starts one.");

  const add = (await client.listTools()).tools.find((tool) => tool.name === "queue_add");
  assert.deepEqual(Object.keys(add.inputSchema.properties).sort(), ["cwd", "max_attempts", "priority", "project", "prompt", "register", "roadmap_item_id", "tier", "timeout_s"]);
  assert.ok(add.description.includes("start the whole batch later with `queue_run`"), add.description);

  const byPath = await client.callTool({ name: "queue_add", arguments: { project: "/tmp/alpha", prompt: "fix the worker" } });
  assert.equal(byPath.isError, true);
  assert.match(textOf(byPath), /pass the registered project NAME, not a path/);

  const unknown = await client.callTool({ name: "queue_add", arguments: { project: "ghost", prompt: "fix the worker" } });
  assert.equal(unknown.isError, true);
  assert.match(textOf(unknown), /unknown project `ghost`/);

  const outOfRange = await client.callTool({ name: "queue_add", arguments: { project: "alpha", prompt: "fix it", priority: 42 } });
  assert.equal(outOfRange.isError, true);
  assert.doesNotMatch(textOf(outOfRange), /\.mjs:\d+/);
});

test("queue_add carries the operator's tier, echoes it only when there is one, and refuses an unknown value", async (t) => {
  const env = makeQueueHome(t, "mcp-queue-add-tier");
  const client = await connect(t, env);

  const tiered = payloadOf(
    await client.callTool({ name: "queue_add", arguments: { project: "alpha", prompt: "fix the worker", tier: "complex" } }),
  );
  assert.equal(tiered.tier, "complex");
  assert.equal(getJob(tiered.id, env).tier, "complex");

  const plain = payloadOf(await client.callTool({ name: "queue_add", arguments: { project: "alpha", prompt: "fix the parser" } }));
  assert.equal("tier" in plain, false, "a job with no tier echoed a `tier` key");
  assert.equal(getJob(plain.id, env).tier, null);

  const unknown = await client.callTool({ name: "queue_add", arguments: { project: "alpha", prompt: "fix it", tier: "urgent" } });
  assert.equal(unknown.isError, true);
  assert.doesNotMatch(textOf(unknown), /\.mjs:\d+/);
  assert.equal(getJob(3, env), null, "the refused tier still queued a job");
});

test("queue_add resolves the project of the caller `cwd`, and answers needs_registration for a repository nobody registered", async (t) => {
  const env = makeQueueHome(t, "mcp-queue-add-cwd");
  const registered = readConfig(env).projects.alpha.path;
  const repo = makeRepo(t, "mcp-queue-add-repo");
  const client = await connect(t, env);

  const known = payloadOf(await client.callTool({ name: "queue_add", arguments: { cwd: registered, prompt: "fix the worker" } }));
  assert.equal(known.project, "alpha");
  assert.equal(known.id, 1);

  const offered = payloadOf(await client.callTool({ name: "queue_add", arguments: { cwd: repo, prompt: "fix the parser" } }));
  assert.deepEqual(Object.keys(offered).sort(), ["cwd", "hint", "needs_registration", "org", "suggested_name"]);
  assert.equal(offered.needs_registration, true);
  assert.equal(offered.cwd, repo);
  assert.equal(offered.org, "default");
  assert.ok(offered.hint.includes("call queue_add again with the same `cwd` and `register: true`"), offered.hint);
  assert.equal(getJob(2, env), null, "the offer queued a job");
  assert.equal(readConfig(env).projects[offered.suggested_name], undefined, "the offer registered the repository");

  const missing = await client.callTool({ name: "queue_add", arguments: { prompt: "fix the worker" } });
  assert.equal(missing.isError, true);
  assert.match(textOf(missing), /pass the registered project NAME in `project`, or the absolute path of the working directory in `cwd`/);

  const relative = await client.callTool({ name: "queue_add", arguments: { cwd: "./somewhere", prompt: "fix the worker" } });
  assert.equal(relative.isError, true);
  assert.match(textOf(relative), /absolute path of the working directory in `cwd`/);

  const outside = await client.callTool({ name: "queue_add", arguments: { cwd: makeDir(t, "mcp-queue-add-bare"), prompt: "fix it", register: true } });
  assert.equal(outside.isError, true);
  assert.match(textOf(outside), /it is not inside a git repository/);
});

test("queue_add registers the repository of the `cwd` only with register: true, and never from inside a job", async (t) => {
  const env = makeQueueHome(t, "mcp-queue-add-register");
  const repo = makeRepo(t, "mcp-queue-register-repo");
  const inJob = await connect(t, { ...env, NIGHTSHIFT_JOB_ID: "7" });

  const refused = await inJob.callTool({ name: "queue_add", arguments: { cwd: repo, prompt: "fix the worker", register: true } });
  assert.equal(refused.isError, true);
  assert.match(textOf(refused), /refusing to register .* from inside job `7`: an unattended run never registers a project/);
  assert.equal(getJob(1, env), null, "an unattended run queued a job through the registration branch");
  assert.deepEqual(Object.keys(readConfig(env).projects), ["alpha"], "an unattended run registered a project");

  const client = await connect(t, env);
  const queued = payloadOf(await client.callTool({ name: "queue_add", arguments: { cwd: repo, prompt: "fix the worker", register: true } }));
  const name = queued.project;
  const entry = readConfig(env).projects[name];
  assert.ok(entry, `\`${name}\` is missing from the config`);
  assert.equal(entry.org, "default");
  assert.equal(getJob(queued.id, env).prompt, "fix the worker");
  assert.ok(queued.hint.startsWith(`registered project \`${name}\` (${entry.path}). queued job #${queued.id}`), queued.hint);

  const again = payloadOf(await client.callTool({ name: "queue_add", arguments: { cwd: repo, prompt: "fix the parser" } }));
  assert.equal(again.project, name, "the registered repository was offered for registration again");
  assert.equal(again.needs_registration, undefined);
});

test("queue_add and queue_cancel refuse the home of the runner from inside a job, and accept a temporary one", async (t) => {
  const env = makeQueueHome(t, "mcp-home-guard");
  const id = addJob({ project: "alpha", prompt: "fix the worker" }, env).id;
  const inJob = await connect(t, { ...env, NIGHTSHIFT_JOB_ID: "9", NIGHTSHIFT_JOB_HOME: homeDir(env) });

  for (const call of [
    { name: "queue_add", arguments: { project: "alpha", prompt: "an acceptance test job created from inside a verifier" } },
    { name: "queue_cancel", arguments: { job_id: id, reason: "test artifact of an acceptance run" } },
  ]) {
    const refused = await inJob.callTool(call);
    assert.equal(refused.isError, true, textOf(refused));
    assert.ok(textOf(refused).includes(HOME_REFUSAL), textOf(refused));
  }
  assert.equal(getJob(id, env).status, "pending", "a refused tool call still moved the job of the operator");
  assert.equal(getJob(id + 1, env), null, "a refused tool call still queued a job in the home of the operator");
  assert.ok(payloadOf(await inJob.callTool({ name: "queue_status", arguments: {} })).counts, "the refusal ended the session");

  const temp = makeQueueHome(t, "mcp-home-guard-temp");
  const allowed = await connect(t, { ...temp, NIGHTSHIFT_JOB_ID: "9", NIGHTSHIFT_JOB_HOME: homeDir(env) });
  const queued = payloadOf(await allowed.callTool({ name: "queue_add", arguments: { project: "alpha", prompt: "verify the acceptance of this change" } }));
  assert.equal(getJob(queued.id, temp).prompt, "verify the acceptance of this change");
  const cancelled = payloadOf(await allowed.callTool({ name: "queue_cancel", arguments: { job_id: queued.id } }));
  assert.equal(cancelled.job.status, "cancelled");
  assert.equal(getJob(id + 1, env), null, "a call isolated in a temporary home reached the home of the operator");
});

test("queue_status never returns the prompt and truncates the free text at five hundred code points", async (t) => {
  const env = makeQueueHome(t, "mcp-queue-status");
  const id = addJob({ project: "alpha", prompt: "a prompt no tool may ever return" }, env).id;
  addJob({ project: "alpha", prompt: "another one" }, env);
  openDb(env)
    .prepare("UPDATE jobs SET notice_md = ?, result = ? WHERE id = ?")
    .run(`${"n".repeat(600)}`, `${"r".repeat(600)}`, id);
  const client = await connect(t, env);

  const one = payloadOf(await client.callTool({ name: "queue_status", arguments: { job_id: id } }));
  assert.equal("prompt" in one.job, false, "queue_status leaked the prompt");
  assert.equal(one.job.notice_md, "n".repeat(600), "the detail of one job cut the notice, which is where a gate is answered from");
  assert.equal(one.job.result, "r".repeat(600));

  const listed = payloadOf(await client.callTool({ name: "queue_status", arguments: { limit: null, job_id: null } }));
  assert.deepEqual(listed.jobs.map((job) => job.id), [2, 1]);
  assert.equal(listed.jobs.find((job) => job.id === id).notice_md, `${"n".repeat(500)}...`, "the listing stopped truncating the free text");
  const cutRow = listed.jobs.find((job) => job.id === id);
  assert.deepEqual({ notice: cutRow.notice_truncated, result: cutRow.result_truncated }, { notice: true, result: true }, "a cut row carries no flag");
  const fitRow = listed.jobs.find((job) => job.id !== id);
  assert.equal("notice_truncated" in fitRow || "result_truncated" in fitRow, false, "a row whose text fits carries a truncated key");
  const pointer = `#${id} text cut at 500 characters - read it whole with nightshift queue status ${id}`;
  assert.deepEqual(listed.suggestions, [pointer]);
  assert.ok(listed.hint.endsWith(pointer), listed.hint);
  assert.equal("notice_truncated" in one.job, false, "the detail of one job was flagged as cut");
  assert.equal(listed.counts.pending, 2);
  for (const job of listed.jobs) assert.equal("prompt" in job, false, "the listing leaked a prompt");
  assert.deepEqual(listed.runner, {
    running: false,
    pid: null,
    mode: null,
    jobId: null,
    intervalS: null,
    startedAt: null,
    logPath: null,
    runtimeDir: null,
    detached: null,
    pausedUntil: null,
    rateLimit: null,
    window: null,
  });
  assert.deepEqual(listed.runners, [], "a home with no runner answered with one");

  const startedAt = "2026-09-08T21:04:11.000Z";
  const runtimeDir = "/tmp/runtime/versions/1.0.0-20260911T031500Z";
  writeRunnerRecord({ pid: process.pid, startedAt, mode: "watch", intervalS: 30, logPath: "/tmp/runner.log", runtimeDir }, env);
  const watched = payloadOf(await client.callTool({ name: "queue_status", arguments: { limit: null, job_id: null } }));
  assert.deepEqual(watched.runner, {
    running: true,
    pid: process.pid,
    mode: "watch",
    jobId: null,
    intervalS: 30,
    startedAt,
    logPath: "/tmp/runner.log",
    runtimeDir,
    detached: null,
    pausedUntil: null,
    rateLimit: null,
    window: null,
  });
  assert.deepEqual(watched.runners, [watched.runner], "the deprecated `runner` key is not the first entry of `runners`");
  assert.equal("runner" in payloadOf(await client.callTool({ name: "queue_status", arguments: { job_id: id } })), false, "the detail of a job grew a runner");

  const unknown = await client.callTool({ name: "queue_status", arguments: { job_id: 99 } });
  assert.equal(unknown.isError, true);
  assert.match(textOf(unknown), /unknown job `99`/);
});

test("queue_status returns a gate notice near three kilobytes whole, and clips it with a pointer in the listing", async (t) => {
  const env = makeQueueHome(t, "mcp-queue-status-big-gate-notice");
  const id = addJob({ project: "alpha", prompt: "fix the worker" }, env).id;
  const points = Array.from(
    { length: 8 },
    (_, i) => `- **C${i + 1}:** ${"the plan departs from the brief on a point that needs a human call before it ships. ".repeat(5)}`,
  );
  const notice = ["## Requires user confirmation", "", ...points, "", `Answer with: nightshift queue retry ${id} --note "<your answer>"`].join("\n");
  assert.ok(Array.from(notice).length > 2900, "setup: the notice must be close to three kilobytes");
  openDb(env).prepare("UPDATE jobs SET status = 'gate', notice_md = ? WHERE id = ?").run(notice, id);
  const client = await connect(t, env);

  const one = payloadOf(await client.callTool({ name: "queue_status", arguments: { job_id: id } }));
  assert.equal(one.job.notice_md, notice, "the detail of one job cut a gate notice that has no length cap");

  const listed = payloadOf(await client.callTool({ name: "queue_status", arguments: { limit: null, job_id: null } }));
  const row = listed.jobs.find((job) => job.id === id);
  assert.equal(row.notice_md, `${Array.from(notice).slice(0, 500).join("")}...`, "the listing did not clip the gate notice");
  assert.equal(row.notice_truncated, true);
  assert.ok(listed.suggestions.includes(`#${id} text cut at 500 characters - read it whole with nightshift queue status ${id}`), listed.suggestions.join("\n"));
});

test("queue_status refuses instead of answering with no runner for a registry it could not read", async (t) => {
  const env = makeQueueHome(t, "mcp-queue-status-unreadable");
  addJob({ project: "alpha", prompt: "fix the worker" }, env);
  rmSync(runnersDir(env), { recursive: true, force: true });
  writeFileSync(runnersDir(env), "not a directory");
  const client = await connect(t, env);

  const refused = await client.callTool({ name: "queue_status", arguments: { limit: null, job_id: null } });

  assert.equal(refused.isError, true, textOf(refused));
  assert.match(textOf(refused), /the runner registry cannot be listed/);
});

const MERGE_SHA = "d3605a5a4d7aaec342d649135cdbd128a042e29d";

// Marks a job as delivered with the URL of its pull request.
function deliver(env, id) {
  openDb(env).prepare("UPDATE jobs SET status = 'done', pr_url = ? WHERE id = ?").run(`https://github.com/acme/api/pull/${id}`, id);
  return id;
}

// The `gh pr view` calls the fake gh of a home recorded so far.
function prViewCalls(env) {
  const log = env.NIGHTSHIFT_FAKE_GH_LOG;
  if (!existsSync(log)) return [];
  return readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)).filter((call) => call[0] === "pr");
}

// Asks queue_status until the pull request of its first job reads `state`, within five seconds, and returns that answer.
async function pollPrState(client, state) {
  const deadline = Date.now() + 5000;
  for (;;) {
    const answer = payloadOf(await client.callTool({ name: "queue_status", arguments: {} }));
    if (answer.jobs[0]?.pr_state === state || Date.now() > deadline) return answer;
    await new Promise((done) => setTimeout(done, 100));
  }
}

test("queue_status never writes a delivered job whose pull request is merged, and asks gh from inside a job too without writing", async (t) => {
  const base = makeQueueHome(t, "mcp-queue-merged");
  deliver(base, addJob({ project: "alpha", prompt: "fix the worker" }, base).id);
  const env = { ...base, ...isolatedHostVars(makeDir(t, "mcp-queue-merged-host")), NIGHTSHIFT_FAKE_GH_PR_STATE: "MERGED", NIGHTSHIFT_FAKE_GH_PR_SHA: MERGE_SHA };
  delete env.NIGHTSHIFT_NO_PR_CHECK;

  const client = await connect(t, env);
  const first = payloadOf(await client.callTool({ name: "queue_status", arguments: {} }));
  assert.equal(first.jobs[0].pr_state, "unknown", "the first answer waited for gh instead of answering from the cache");
  assert.deepEqual(first.suggestions, []);
  assert.deepEqual(first.sections.map((section) => section.name), ["jobs", "counts", "runners", "advisories"]);
  assert.ok(first.sections.every((section) => section.ok && Number.isInteger(section.ms)), JSON.stringify(first.sections));

  const listed = await pollPrState(client, "merged");
  assert.equal(listed.jobs[0].pr_state, "merged", "the refresh fired after the answer never landed in the cache");
  assert.deepEqual(listed.suggestions, ["#1 PR merged - close it with nightshift queue close 1"]);
  assert.ok(listed.hint.endsWith("#1 PR merged - close it with nightshift queue close 1"), listed.hint);
  assert.equal(listed.jobs[0].status, "done");
  assert.equal(listed.counts.done, 1);
  assert.equal(listed.counts.closed, 0);
  assert.equal(listed.counts.merged, undefined, "the retired merged status is still counted");
  assert.equal("merged_at" in listed.jobs[0], false);
  assert.equal("merge_sha" in listed.jobs[0], false);
  const detail = payloadOf(await client.callTool({ name: "queue_status", arguments: { job_id: 1 } }));
  assert.deepEqual({ status: detail.job.status, pr_state: detail.job.pr_state }, { status: "done", pr_state: "merged" });
  assert.equal("merged_at" in detail.job, false);
  assert.equal("merge_sha" in detail.job, false);
  assert.equal(prViewCalls(env).length, 1, "a merged pull request was asked about again instead of cached");

  const inJob = await connect(t, { ...env, NIGHTSHIFT_JOB_ID: "7", NIGHTSHIFT_FAKE_GH_LOG: join(makeDir(t, "mcp-queue-merged-job"), "gh.log") });
  assert.equal((await pollPrState(inJob, "merged")).jobs[0].pr_state, "merged", "a job session never asked gh");

  const row = getJob(1, env);
  assert.equal(row.status, "done");
  assert.equal("merged_at" in row, false, "the jobs row still carries the dropped merged_at column");
  assert.equal("merge_sha" in row, false, "the jobs row still carries the dropped merge_sha column");
});

test("queue_status answers with the nudge that matches the state of the queue, leading with the live-runner count, and never on the detail of a job", async (t) => {
  const env = makeQueueHome(t, "mcp-queue-hint");
  const client = await connect(t, env);

  const empty = payloadOf(await client.callTool({ name: "queue_status", arguments: {} }));
  assert.equal(empty.runnersOnline, 0);
  assert.equal(
    empty.hint,
    "0 runners online - pending jobs will wait until `nightshift queue run` starts one",
    "an empty queue with no runner stayed silent about it",
  );

  const first = addJob({ project: "alpha", prompt: "fix the worker" }, env).id;
  const one = payloadOf(await client.callTool({ name: "queue_status", arguments: {} }));
  assert.equal(one.hint, "0 runners online - pending jobs will wait until `nightshift queue run` starts one");

  addJob({ project: "alpha", prompt: "fix the parser" }, env);
  const two = payloadOf(await client.callTool({ name: "queue_status", arguments: {} }));
  assert.equal(two.hint, "0 runners online - pending jobs will wait until `nightshift queue run` starts one");

  claimJobById(first, { worker: "host:4242", cap: 4 }, env);
  const claimed = payloadOf(await client.callTool({ name: "queue_status", arguments: {} }));
  assert.equal(
    claimed.hint,
    "0 runners online - a job is running under a one-shot runner, nothing will pick up the pending jobs after it - start a drain with `nightshift queue run`",
  );

  const detail = payloadOf(await client.callTool({ name: "queue_status", arguments: { job_id: first } }));
  assert.deepEqual(Object.keys(detail), ["job"], "the detail of a job grew a hint");

  const watchedEnv = makeQueueHome(t, "mcp-queue-hint-watch");
  addJob({ project: "alpha", prompt: "fix the worker" }, watchedEnv);
  writeRunnerRecord(
    { pid: process.pid, startedAt: new Date().toISOString(), mode: "watch", intervalS: 30, logPath: "/tmp/runner.log" },
    watchedEnv,
  );
  const watchedClient = await connect(t, watchedEnv);
  const watched = payloadOf(await watchedClient.callTool({ name: "queue_status", arguments: {} }));
  assert.equal(watched.runnersOnline, 1);
  assert.equal(watched.hint, "1 runner online - 1 pending after this one", "a live watcher was told to start a second batch");

  const added = payloadOf(await watchedClient.callTool({ name: "queue_add", arguments: { project: "alpha", prompt: "fix the parser" } }));
  assert.match(added.hint, /1 runner online - it will be picked up\.$/, "queue_add did not report the live watcher");
});

// The pause region of a runner of this home, as the runner itself would have merged it into its own registration.
function pauseRegion(resetsAt) {
  return {
    pausedAt: new Date().toISOString(),
    pausedUntil: new Date(resetsAt.getTime() + 60_000).toISOString(),
    resetsAt: resetsAt.toISOString(),
    type: "five_hour",
    utilization: 0.99,
  };
}

test("a runner waiting out a rate limit is what queue_status and queue_add say, instead of asking for a batch that would only sleep", async (t) => {
  const env = makeQueueHome(t, "mcp-queue-hint-rate-limit");
  const resetsAt = new Date(Date.now() + 3600_000);
  writeRunnerRecord(
    { pid: process.pid, startedAt: new Date().toISOString(), mode: "watch", intervalS: 30, logPath: "/tmp/runner.log", rateLimit: pauseRegion(resetsAt) },
    env,
  );
  const client = await connect(t, env);
  const pause = `the runner is paused until ${clockLabel(resetsAt.getTime())} (5h limit, resets in 1h00)`;

  const empty = payloadOf(await client.callTool({ name: "queue_status", arguments: {} }));
  assert.equal(empty.hint, `1 runner online - nothing is pending — ${pause}.`);
  assert.equal(empty.runner.pausedUntil, new Date(resetsAt.getTime() + 60_000).toISOString());

  const queued = payloadOf(await client.callTool({ name: "queue_add", arguments: { project: "alpha", prompt: "fix the worker" } }));
  assert.equal(queued.hint, `queued job #1 for \`alpha\` (1 pending). 1 runner online - nothing to start: ${pause}; it claims again by itself when the limit resets.`);

  const pending = payloadOf(await client.callTool({ name: "queue_status", arguments: {} }));
  assert.equal(pending.hint, `1 runner online - 1 pending job waiting — ${pause}.`);
});

test("a runner still waiting for its window is what queue_add says, and a paused one wins over it", async (t) => {
  const env = makeQueueHome(t, "mcp-queue-hint-window");
  const fromMs = Date.now() + 3600_000;
  const window = { from: new Date(fromMs).toISOString(), until: new Date(fromMs + 3600_000).toISOString() };
  writeRunnerRecord(
    { pid: process.pid, startedAt: new Date().toISOString(), mode: "watch", intervalS: 30, logPath: "/tmp/runner.log", window },
    env,
  );
  const client = await connect(t, env);
  const waiting = `1 runner waiting for its window (opens ${clockLabel(fromMs)})`;

  const queued = payloadOf(await client.callTool({ name: "queue_add", arguments: { project: "alpha", prompt: "fix the worker" } }));
  assert.equal(queued.hint, `queued job #1 for \`alpha\` (1 pending). ${waiting}; it claims once the window opens.`);

  const status = payloadOf(await client.callTool({ name: "queue_status", arguments: {} }));
  assert.deepEqual(status.runner.window, window, "queue_status did not carry the window of the live runner");

  const resetsAt = new Date(Date.now() + 1800_000);
  writeRunnerRecord({ pid: process.pid, startedAt: new Date().toISOString(), mode: "watch", intervalS: 30, logPath: "/tmp/runner.log", window, rateLimit: pauseRegion(resetsAt) }, env);
  const pausedAndWaiting = payloadOf(await client.callTool({ name: "queue_add", arguments: { project: "alpha", prompt: "fix the parser" } }));
  assert.match(pausedAndWaiting.hint, /nothing to start: the runner is paused/, "the window wait was reported over the nearer rate-limit pause");
  assert.equal(pausedAndWaiting.hint.includes("waiting for its window"), false);
});

test("a backlog parked by a rate limit is what queue_status says, instead of asking for a batch that would claim nothing", async (t) => {
  const env = makeQueueHome(t, "mcp-queue-hint-parked");
  const parked = addJob({ project: "alpha", prompt: "fix the worker" }, env).id;
  const notBefore = new Date(Date.now() + 3600_000).toISOString();
  claimJobById(parked, { worker: "host:4242", cap: 4 }, env);
  assert.equal(parkJob(parked, { worker: "host:4242", notBefore, result: { rateLimited: true, notBefore } }, env), true, "the fixture did not park the job");
  const client = await connect(t, env);

  const waiting = payloadOf(await client.callTool({ name: "queue_status", arguments: {} }));

  assert.equal(waiting.runner.running, false, "the fixture left a live runner behind, so the nudge is not the one under test");
  assert.equal(waiting.hint, `0 runners online - 1 pending job waiting — the rate limit resets at ${clockLabel(Date.parse(notBefore))} (in 1h00); a batch started now claims nothing before that.`);

  addJob({ project: "alpha", prompt: "fix the parser" }, env);
  const mixed = payloadOf(await client.callTool({ name: "queue_status", arguments: {} }));
  assert.equal(mixed.hint, "0 runners online - pending jobs will wait until `nightshift queue run` starts one", "a job that could be claimed right now was held back by the park of another one");
});

test("queue_run comes back at once with the log of the detached runner, inside this home", async (t) => {
  const env = makeQueueHome(t, "mcp-queue-run");
  const client = await connect(t, env);

  const paused = payloadOf(await client.callTool({ name: "queue_run", arguments: { job_id: null } }));
  assert.deepEqual(
    { started: paused.started, pid: paused.pid, reason: paused.waiting?.reason },
    { started: false, pid: null, reason: "paused" },
    "a drain started on a paused queue, where its child would exit on its first cycle",
  );
  assert.match(paused.message, /the queue is paused - nothing will be claimed/);

  rmSync(queuePausedPath(env), { force: true });
  const started = payloadOf(await client.callTool({ name: "queue_run", arguments: { job_id: null } }));

  assert.equal(started.ok, true);
  assert.equal(Number.isInteger(started.pid), true, `no pid: ${JSON.stringify(started)}`);
  assert.equal(started.logPath.startsWith(join(homeDir(env), "logs")), true, `the runner logs outside the home: ${started.logPath}`);
  assert.match(started.logPath, /runner-\d{8}T\d{6}Z\.log$/);
  assert.deepEqual(started.advisories, [], "a start with nothing to warn about answered advice anyway");

  const tool = (await client.listTools()).tools.find((entry) => entry.name === "queue_run");
  assert.ok(
    tool.description.startsWith("starts a detached runner that drains the queue: every pending job, in priority order, until nothing is pending"),
    `the tool does not open on the batch it starts: ${tool.description}`,
  );
  assert.ok(tool.description.includes("DETACHED"), "the tool does not say the runner is detached");
  assert.ok(tool.description.includes("nightshift queue run --stop"), "the tool does not say how a watcher is stopped");
  assert.ok(tool.description.includes("Each runner works one job at a time"), "the tool does not say a runner works one job at a time");
  assert.ok(tool.description.includes("`advisories`"), "the tool does not name the advisories it answers");
});

const ALPHA_ADVISORY =
  "2 runners on `alpha` — parallel jobs on one repository fight over the checkout; a job the preflight releases retries with backoff and burns tokens for no output";

test("queue_run and queue_retry start nothing when the ceiling is full, and say what the job is waiting for", async (t) => {
  const env = makeQueueHome(t, "mcp-queue-run-waiting");
  rmSync(queuePausedPath(env), { force: true });
  saveConfig({ ...loadConfig(env, { warn: () => {} }), queue: { maxConcurrent: 2 } }, env);
  const id = addJob({ project: "alpha", prompt: "fix the worker" }, env).id;
  for (const prompt of ["hold the first slot", "hold the second slot"]) {
    claimJobById(addJob({ project: "alpha", prompt }, env).id, { worker: `host:${prompt.length}`, cap: 4 }, env);
  }
  writeRunnerRecord({ pid: process.pid, startedAt: new Date().toISOString(), mode: "drain", intervalS: null, logPath: null }, env);
  const client = await connect(t, env);

  const started = payloadOf(await client.callTool({ name: "queue_run", arguments: { job_id: id } }));
  assert.deepEqual(
    { ok: started.ok, started: started.started, pid: started.pid, reason: started.waiting?.reason },
    { ok: true, started: false, pid: null, reason: "cap-reached" },
  );
  assert.match(started.message, /job #1 waiting: concurrency cap reached; 2 of 2 jobs already running/);
  assert.match(started.message, new RegExp(`a live runner \\(pid ${process.pid}, drain\\) will pick it up`));
  assert.equal(existsSync(join(homeDir(env), "logs")), false, "a start that claims nothing opened the log of a runner nobody started");
  assert.deepEqual(started.advisories, [ALPHA_ADVISORY], "a waiting start did not answer the advice of the two live alpha leases");

  const status = payloadOf(await client.callTool({ name: "queue_status", arguments: {} }));
  assert.deepEqual(status.advisories, [ALPHA_ADVISORY]);
  assert.ok(status.hint.endsWith(` ${ALPHA_ADVISORY}`), `the hint does not end with the advisory line: ${status.hint}`);

  assert.equal(payloadOf(await client.callTool({ name: "queue_cancel", arguments: { job_id: id, reason: "not needed" } })).ok, true);
  const retried = payloadOf(await client.callTool({ name: "queue_retry", arguments: { job_id: id, run: true } }));
  assert.deepEqual({ started: retried.started, reason: retried.waiting?.reason }, { started: false, reason: "cap-reached" });
  assert.deepEqual(retried.advisories, [ALPHA_ADVISORY]);
  assert.equal(getJob(id, env).status, "pending", "the retried job is not pending, so no runner will ever claim it");
});

test("queue_run starts a runner even while another one is live, and queue_status lists them all", async (t) => {
  const env = makeQueueHome(t, "mcp-queue-run-parallel");
  rmSync(queuePausedPath(env), { force: true });
  writeRunnerRecord({ pid: process.pid, startedAt: "2026-09-08T21:00:00.000Z", mode: "drain", intervalS: null, logPath: null }, env);
  const client = await connect(t, env);

  const started = payloadOf(await client.callTool({ name: "queue_run", arguments: { job_id: null } }));

  assert.equal(started.started, true, `a start was refused while another runner was live: ${JSON.stringify(started)}`);
  assert.equal(Number.isInteger(started.pid), true);
  const listed = payloadOf(await client.callTool({ name: "queue_status", arguments: {} }));
  assert.equal(listed.runners.some((runner) => runner.pid === process.pid), true, "the live runner left the listing");
  assert.equal(listed.runner.pid, listed.runners[0].pid);
});

test("queue_cancel takes a pending job, a gated one and an orphan, and refuses a live run or a finished one", async (t) => {
  const env = makeQueueHome(t, "mcp-queue-cancel");
  const pending = addJob({ project: "alpha", prompt: "fix the worker" }, env).id;
  const running = addJob({ project: "alpha", prompt: "fix the parser" }, env).id;
  claimJobById(running, { worker: "host:4242", cap: 4 }, env);
  const client = await connect(t, env);

  const refused = await client.callTool({ name: "queue_cancel", arguments: { job_id: running, reason: null } });
  assert.equal(refused.isError, true);
  assert.match(textOf(refused), /is running with a live lease on worker `host:4242`/);
  assert.equal(getJob(running, env).status, "running", "the refused cancel wrote to the row");

  const cancelled = payloadOf(await client.callTool({ name: "queue_cancel", arguments: { job_id: pending, reason: "no longer needed" } }));
  assert.equal(cancelled.job.status, "cancelled");
  assert.equal(cancelled.job.operator_note, "no longer needed");

  const twice = await client.callTool({ name: "queue_cancel", arguments: { job_id: pending } });
  assert.equal(twice.isError, true);
  assert.match(textOf(twice), /already finished with status `cancelled`/);

  openDb(env).prepare("UPDATE jobs SET lease_until = datetime('now', '-120 seconds') WHERE id = ?").run(running);
  const orphan = payloadOf(await client.callTool({ name: "queue_cancel", arguments: { job_id: running } }));
  assert.equal(orphan.job.status, "cancelled");
  assert.equal(orphan.job.worker, null);

  const gated = addJob({ project: "alpha", prompt: "wait for a human" }, env).id;
  openDb(env)
    .prepare("UPDATE jobs SET status = 'gate', finished_at = ?, result = ? WHERE id = ?")
    .run(GATED_FINISHED_AT, '{"status":"gate","prUrl":null}', gated);
  const closed = payloadOf(await client.callTool({ name: "queue_cancel", arguments: { job_id: gated, reason: "the human said no" } }));
  assert.equal(closed.job.status, "cancelled");
  assert.equal(closed.job.operator_note, "the human said no");

  const gatedRow = getJob(gated, env);
  assert.equal(gatedRow.finished_at, GATED_FINISHED_AT, "the cancel overwrote the finish of the gated run");
  assert.deepEqual(JSON.parse(gatedRow.result), { status: "gate", prUrl: null, cancelledFrom: "gate" });
});

test("queue_close closes a failed job and refuses a pending and a running one by name", async (t) => {
  const env = makeQueueHome(t, "mcp-queue-close");
  const done = addJob({ project: "alpha", prompt: "fix the worker" }, env).id;
  openDb(env).prepare("UPDATE jobs SET status = 'done', pr_url = ? WHERE id = ?").run("https://github.com/acme/api/pull/42", done);
  const failed = addJob({ project: "alpha", prompt: "fix the parser" }, env).id;
  openDb(env).prepare("UPDATE jobs SET status = 'failed', finished_at = ? WHERE id = ?").run(GATED_FINISHED_AT, failed);
  const pending = addJob({ project: "alpha", prompt: "wait for a human" }, env).id;
  const running = addJob({ project: "alpha", prompt: "keep running" }, env).id;
  claimJobById(running, { worker: "host:1", cap: 4 }, env);
  const client = await connect(t, env);

  const closed = payloadOf(await client.callTool({ name: "queue_close", arguments: { job_id: done } }));
  assert.equal(closed.ok, true);
  assert.deepEqual({ status: closed.job.status, pr_url: closed.job.pr_url }, { status: "closed", pr_url: "https://github.com/acme/api/pull/42" });
  assert.equal(getJob(done, env).status, "closed");

  const closedFailed = payloadOf(await client.callTool({ name: "queue_close", arguments: { job_id: failed } }));
  assert.equal(closedFailed.job.status, "closed", "a failed job was refused");

  const beforePending = getJob(pending, env);
  const refusedPending = await client.callTool({ name: "queue_close", arguments: { job_id: pending } });
  assert.equal(refusedPending.isError, true);
  assert.match(textOf(refusedPending), /is pending; the queue still owes work for it/);
  assert.deepEqual(getJob(pending, env), beforePending, "the refused close wrote to the pending row");

  const beforeRunning = getJob(running, env);
  const refusedRunning = await client.callTool({ name: "queue_close", arguments: { job_id: running } });
  assert.equal(refusedRunning.isError, true);
  assert.match(textOf(refusedRunning), /is running with a live lease on worker/);
  assert.deepEqual(getJob(running, env), beforeRunning, "the refused close wrote to the running row");
});

test("queue_close refuses the home of the runner from inside a job, like queue_cancel", async (t) => {
  const env = makeQueueHome(t, "mcp-close-home-guard");
  const id = addJob({ project: "alpha", prompt: "fix the worker" }, env).id;
  openDb(env).prepare("UPDATE jobs SET status = 'done' WHERE id = ?").run(id);
  const inJob = await connect(t, { ...env, NIGHTSHIFT_JOB_ID: "9", NIGHTSHIFT_JOB_HOME: homeDir(env) });

  const refused = await inJob.callTool({ name: "queue_close", arguments: { job_id: id } });
  assert.equal(refused.isError, true, textOf(refused));
  assert.ok(textOf(refused).includes(HOME_REFUSAL), textOf(refused));
  assert.equal(getJob(id, env).status, "done", "a refused close still moved the job of the operator");
});

test("queue_retry answers a gate, refuses one without a note and only starts a runner when asked", async (t) => {
  const env = makeQueueHome(t, "mcp-queue-retry");
  const gated = addJob({ project: "alpha", prompt: "wait for a human" }, env).id;
  openDb(env)
    .prepare("UPDATE jobs SET status = 'gate', slug = ?, finished_at = ?, notice_md = ? WHERE id = ?")
    .run("fix-the-worker", GATED_FINISHED_AT, "Rename the column or keep both?", gated);
  const client = await connect(t, env);

  const tool = (await client.listTools()).tools.find((entry) => entry.name === "queue_retry");
  assert.deepEqual(Object.keys(tool.inputSchema.properties).sort(), ["fresh", "job_id", "note", "run"]);
  assert.deepEqual(tool.inputSchema.required, ["job_id"]);
  assert.ok(tool.description.includes("DETACHED"), "the tool does not state how its `run` differs from the CLI");
  assert.equal(
    tool.description.includes("runs the job in the foreground"),
    false,
    "the tool still claims the `--run` of the CLI runs the job in the foreground",
  );

  const refused = await client.callTool({ name: "queue_retry", arguments: { job_id: gated } });
  assert.equal(refused.isError, true);
  assert.match(textOf(refused), /Rename the column or keep both\?/);
  assert.match(textOf(refused), /This job is waiting for a decision/);
  assert.equal(getJob(gated, env).status, "gate", "the refused retry wrote to the row");

  const retried = payloadOf(
    await client.callTool({ name: "queue_retry", arguments: { job_id: gated, note: "rename it", fresh: null, run: null } }),
  );
  assert.equal(retried.job.status, "pending");
  assert.equal(retried.job.operator_note, "rename it");
  assert.equal(retried.job.slug, "fix-the-worker", "a retry without `fresh` gave up the slug of the run");
  assert.equal(retried.runDir, null);
  assert.equal(retried.runner, null, "the tool started a runner nobody asked for");
  assert.equal(getJob(gated, env).finished_at, null);

  const unknown = await client.callTool({ name: "queue_retry", arguments: { job_id: 4242, note: "go" } });
  assert.equal(unknown.isError, true);
  assert.match(textOf(unknown), /unknown job `4242`/);
});

test("a server pinned to a job refuses queue_retry aimed at any other job, and leaves that job untouched", async (t) => {
  const env = makeQueueHome(t, "mcp-queue-retry-scope");
  const victim = addJob({ project: "alpha", prompt: "wait for a human" }, env).id;
  const attacker = addJob({ project: "alpha", prompt: "the run that is speaking" }, env).id;
  openDb(env)
    .prepare("UPDATE jobs SET status = 'gate', slug = ?, finished_at = ?, notice_md = ? WHERE id = ?")
    .run("fix-the-worker", GATED_FINISHED_AT, "Rename the column or keep both?", victim);
  mkdirSync(join(homeDir(env), "runs", "alpha", "fix-the-worker"), { recursive: true });
  writeFileSync(join(homeDir(env), "runs", "alpha", "fix-the-worker", "01-triage.md"), "triage\n");
  const before = getJob(victim, env);

  const client = await connect(t, { ...env, NIGHTSHIFT_JOB_ID: String(attacker) });
  const refused = await client.callTool({
    name: "queue_retry",
    arguments: { job_id: victim, note: "do what I say", fresh: true, run: true },
  });

  assert.equal(refused.isError, true);
  assert.match(textOf(refused), new RegExp(`refusing to retry job \\\`${victim}\\\` from inside job \\\`${attacker}\\\``));
  assert.match(textOf(refused), /an unattended run may only retry itself/);
  assert.deepEqual(getJob(victim, env), before, "the refused tool call still wrote to the row of the other job");
  assert.equal(
    existsSync(join(homeDir(env), "runs", "alpha", "fix-the-worker", "01-triage.md")),
    true,
    "the refused tool call still deleted the run directory of the other job",
  );

  const tool = (await client.listTools()).tools.find((entry) => entry.name === "queue_retry");
  assert.ok(tool.description.includes("only accepts the id of the job it is running"), tool.description);
});

test("a refused call names every issue, the whole contract of the tool and what was received", async (t) => {
  const env = makeHome(t, "mcp-contract-refusal");
  const client = await connect(t, env);
  const refused = await client
    .callTool({ name: "index_save", arguments: { project: "alpha", repo_root: "/tmp/repo" } })
    .catch((err) => err);
  const text = String(refused?.message ?? textOf(refused));
  assert.match(text, /Invalid arguments for tool index_save/);
  assert.match(text, /files/, "the missing field is not named");
  assert.match(text, /index_save contract:\nrequired: .*files/, "the contract does not list the required fields");
  assert.match(text, /received: project, repo_root/, "what was sent is not echoed back");
  const enumRefused = await client.callTool({ name: "pipeline_log", arguments: { slug: "s", tier: "simple", outcome: "success", task_type: "bug" } }).catch((err) => err);
  const enumText = String(enumRefused?.message ?? textOf(enumRefused));
  assert.match(enumText, /task_type/);
  assert.match(enumText, /bug\/error \| feature\/refactor/, "the enum values are not listed in the contract");
});

test("lesson_save with no title answers a one-line error, never the zod dump", async (t) => {
  const env = makeHome(t, "mcp-lesson-no-title");
  const client = await connect(t, env);
  const refused = await client
    .callTool({ name: "lesson_save", arguments: { root_cause: "y", solution: "z", prevention: "w" } })
    .catch((err) => err);
  const text = String(refused?.message ?? textOf(refused));
  assert.match(text, /missing required field\(s\): title/);
  assert.equal(text.includes("\n"), false, `the error is not a single line: ${text}`);
  assert.doesNotMatch(text, /Invalid arguments for tool/, "the zod dump leaked through");
});
