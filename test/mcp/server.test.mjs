import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { homeDir, jobLogPath, logsDir, PACKAGE_NAME, queuePausedPath, runnersDir, runtimeCurrentLink, runtimeDir, runtimeVersionsDir } from "../../src/config/paths.mjs";
import { loadConfig, loadSecrets, saveConfig, saveSecrets } from "../../src/config/store.mjs";
import { packageRoot } from "../../src/host/paths.mjs";
import { closeDb, openDb, openDbReadOnly } from "../../src/memory/db.mjs";
import { addJob, claimJobById, getJob, parkJob } from "../../src/memory/jobs.mjs";
import { DB_USER_VERSION } from "../../src/memory/schema.mjs";
import { clockLabel } from "../../src/queue/hints.mjs";
import { writeRunnerRecord } from "../../src/queue/registry.mjs";
import { assertIsolatedEnv, isolatedHostVars } from "../../test-support/host.mjs";
import { ensureProject, makeDir, makeHome, makeProject, projectIdOf, seedClosedJob, seedLegacyV8Home } from "../../test-support/memory.mjs";
import { FAKE_CLAUDE } from "../../test-support/queue-fake.mjs";
import * as registry from "../../src/memory/registry.mjs";

const CLI = fileURLToPath(new URL("../../bin/nightqueue.mjs", import.meta.url));
const GATED_FINISHED_AT = "2020-01-01 00:00:00";
const HOME_REFUSAL =
  "refused: this command would change the operator's nightqueue home from inside J-9; verify against a temporary home (NIGHTQUEUE_HOME=$(mktemp -d)) instead";

const CONTRACT_TOOLS = [
  "connection_call",
  "context_for_phase",
  "index_recall",
  "index_save",
  "lesson_delete",
  "lesson_recall",
  "lesson_save",
  "memory_delete",
  "memory_recall",
  "memory_save",
  "phase_prompt",
  "pipeline_log",
  "project_integrations",
  "project_register",
  "queue_add",
  "queue_cancel",
  "queue_close",
  "queue_retry",
  "queue_run",
  "queue_session",
  "queue_status",
  "queue_stop",
  "run_outcome",
  "run_phase_done",
  "run_set",
  "run_skip",
  "run_terminate",
  "tracker_comment",
  "tracker_create",
  "tracker_issues",
  "tracker_read",
  "tracker_update",
];

const LESSON = {
  title: "the worker leaks a file descriptor on failure",
  root_cause: "the early return skipped the close",
  solution: "close it in a finally block",
  prevention: "always close the file descriptor in a finally block",
  attempts: 2,
};

// Connects a real stdio client to `nightqueue mcp`, closed at the end of the test.
async function connect(t, env) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [CLI, "mcp"], env, stderr: "pipe" });
  const client = new Client({ name: "nightqueue-tests", version: "0.0.0" });
  await client.connect(transport);
  t.after(() => client.close());
  return client;
}

// JSON payload of a successful tool result.
function payloadOf(result) {
  assert.notEqual(result.isError, true, textOf(result));
  return JSON.parse(textOf(result));
}

// A job row without the attempt fields that follow the wall clock while an attempt is open.
function rowAtRest(row) {
  if (!Array.isArray(row?.attempt_rows)) return row;
  return { ...row, attempt_rows: row.attempt_rows.map(({ elapsed_s, end_epoch, ...rest }) => rest) };
}

// Plain text of a tool result.
function textOf(result) {
  return result.content.map((block) => block.text).join("\n");
}

test("the server exposes exactly the thirty-two tools of the contract, none of them a decision tool", async (t) => {
  const env = makeHome(t, "mcp-tools");
  const client = await connect(t, env);
  const names = (await client.listTools()).tools.map((tool) => tool.name).sort();
  assert.deepEqual(names, CONTRACT_TOOLS);
  assert.equal(names.some((name) => name.startsWith("decision_")), false);
  assert.equal(names.length, 32, "the contract list and the server disagree on how many tools there are");
});

const CONNECTION_REFUSAL = "connection_call: refused: `connection_call` POST inside J-7: a call that is not a GET is the operator's call, made only outside a queue run after the person's explicit ok; a run may only GET. Nothing was sent";

test("connection_call with an unknown connection name is a normal no-connection answer with the contract", async (t) => {
  const env = makeHome(t, "mcp-connection-call-none");
  const client = await connect(t, env);
  const answer = payloadOf(await client.callTool({ name: "connection_call", arguments: { connection: "nowhere" } }));
  assert.deepEqual(answer, {
    ok: false,
    error: "no-connection",
    status: null,
    detail: "no stored connection named that way; the person lists them with `nightqueue connection list`",
    contract: 9,
  });
});

test("connection_call DELETE is a normal invalid-input answer, not a schema error", async (t) => {
  const env = makeHome(t, "mcp-connection-call-delete");
  const client = await connect(t, env);
  const answer = payloadOf(await client.callTool({ name: "connection_call", arguments: { connection: "nowhere", method: "DELETE" } }));
  assert.equal(answer.error, "invalid-input");
});

test("inside a queue job a connection_call POST is refused and a GET still answers", async (t) => {
  const env = makeHome(t, "mcp-connection-call-in-job");
  const inJob = await connect(t, { ...env, NIGHTQUEUE_JOB_ID: "7" });
  const refused = await inJob.callTool({ name: "connection_call", arguments: { connection: "nowhere", method: "POST", body: { a: 1 } } });
  assert.equal(refused.isError, true);
  assert.equal(textOf(refused), CONNECTION_REFUSAL);
  assert.equal(payloadOf(await inJob.callTool({ name: "connection_call", arguments: { connection: "nowhere" } })).error, "no-connection");
});

test("the connection_call description states the explicit-ok rule and names no service", async (t) => {
  const env = makeHome(t, "mcp-connection-call-description");
  const client = await connect(t, env);
  const description = (await client.listTools()).tools.find((tool) => tool.name === "connection_call").description;
  assert.ok(description.includes("explicit ok"));
  assert.ok(description.includes("Refused inside a queue job"));
  assert.doesNotMatch(description, /sentry|linear|discord/i);
});

test("tracker_issues with no tracker connection is a normal answer carrying the refusal and the contract", async (t) => {
  const env = makeHome(t, "mcp-tracker-none");
  const client = await connect(t, env);
  const result = await client.callTool({ name: "tracker_issues", arguments: { state: "all", limit: 50, include_filters: true } });
  assert.deepEqual(payloadOf(result), {
    ok: false,
    error: "no-connection",
    provider: "linear",
    hint: 'connect it: echo "$LINEAR_API_KEY" | nightqueue connection add linear --type linear',
    contract: 9,
  });
});

const LINEAR_KEY = "lin_api_secret_0123456789";
const TRACKER_CALLS = {
  tracker_read: { ref: "MK-49" },
  tracker_create: { team: "MK", title: "Fix the login" },
  tracker_comment: { ref: "MK-49", body: "Looked into it." },
  tracker_update: { ref: "MK-49", priority: 2 },
};

// Stores the home-wide linear connection with the fake key.
function storeLinearKey(env) {
  const secrets = loadSecrets(env, { warn: () => {} });
  secrets.connections.linear = { type: "linear", apiKey: LINEAR_KEY };
  saveSecrets(secrets, env);
}

test("every new tracker tool with no tracker connection answers the no-connection refusal with the contract", async (t) => {
  const env = makeHome(t, "mcp-tracker-tools-none");
  const client = await connect(t, env);
  for (const [name, args] of Object.entries(TRACKER_CALLS)) {
    assert.deepEqual(payloadOf(await client.callTool({ name, arguments: args })), {
      ok: false,
      error: "no-connection",
      provider: "linear",
      hint: 'connect it: echo "$LINEAR_API_KEY" | nightqueue connection add linear --type linear',
      contract: 9,
    }, name);
  }
});

test("inside a queue job every tracker write is refused before anything is sent, and the reads still answer", async (t) => {
  const env = makeHome(t, "mcp-tracker-in-job");
  const inJob = await connect(t, { ...env, NIGHTQUEUE_JOB_ID: "7" });
  for (const name of ["tracker_create", "tracker_comment", "tracker_update"]) {
    const refused = await inJob.callTool({ name, arguments: TRACKER_CALLS[name] });
    assert.equal(refused.isError, true, name);
    assert.equal(
      textOf(refused),
      `${name}: refused: \`${name}\` inside J-7: writing to the issue tracker is the operator's call, made only outside a queue run after the person's explicit ok; a run reads it (\`tracker_read\`, \`tracker_issues\`) and never writes. Nothing was sent`,
    );
  }
  assert.equal(payloadOf(await inJob.callTool({ name: "tracker_read", arguments: TRACKER_CALLS.tracker_read })).error, "no-connection");
  assert.equal(payloadOf(await inJob.callTool({ name: "tracker_issues", arguments: {} })).error, "no-connection");
});

test("the write tools state the explicit-ok rule and no tool deletes or archives an issue", async (t) => {
  const env = makeHome(t, "mcp-tracker-descriptions");
  const client = await connect(t, env);
  const tools = (await client.listTools()).tools;
  for (const name of ["tracker_create", "tracker_comment", "tracker_update"]) {
    const description = tools.find((tool) => tool.name === name).description;
    assert.ok(description.includes("getting an explicit ok"), name);
    assert.ok(description.includes("Refused inside a queue job, and nothing is sent"), name);
  }
  assert.ok(!tools.some((tool) => /delete|archive/.test(tool.name) && tool.name.startsWith("tracker_")));
  const issues = tools.find((tool) => tool.name === "tracker_issues");
  assert.deepEqual(Object.keys(issues.inputSchema.properties).sort(), ["include_filters", "label", "limit", "project", "state", "team", "text"]);
});

test("the generic error answer never carries a stored secret: the key is redacted, other text is kept", async (t) => {
  const env = makeHome(t, "mcp-guard-redacts");
  makeProject(t, env, "alpha");
  storeLinearKey(env);
  const client = await connect(t, env);
  const result = await client.callTool({ name: "queue_add", arguments: { project: LINEAR_KEY, prompt: "fix the worker" } });
  assert.equal(result.isError, true);
  assert.ok(!textOf(result).includes(LINEAR_KEY), textOf(result));
  assert.match(textOf(result), /unknown project `\[redacted\]`/);
});

test("a tracker refusal hint that echoes the input never carries a stored secret", async (t) => {
  const env = makeHome(t, "mcp-tracker-hint-redacts");
  storeLinearKey(env);
  const client = await connect(t, env);
  const result = await client.callTool({ name: "tracker_read", arguments: { ref: LINEAR_KEY } });
  assert.ok(!textOf(result).includes(LINEAR_KEY), textOf(result));
  assert.equal(payloadOf(result).error, "invalid-input");
  assert.match(payloadOf(result).hint, /\[redacted\]/);
});

test("the server never migrates a v8 home: a tool answers store-unavailable with the update message and the file stays v8", async (t) => {
  const env = makeHome(t, "mcp-v9-migration");
  makeProject(t, env, "alpha");
  seedLegacyV8Home(env, { rows: 1 });
  closeDb(env);
  const client = await connect(t, env);

  const result = await client.callTool({ name: "queue_status", arguments: {} });
  const status = JSON.parse(result.content[0].text);
  assert.equal(result.isError, true);
  assert.equal(status.error, "store-unavailable");
  assert.equal(status.code, "SCHEMA_OUTDATED");
  assert.equal(status.hint, "nightqueue update");
  assert.match(status.message, /database at v8, this nightqueue expects v26: run `nightqueue update`/);

  const db = openDbReadOnly(env, { anySchema: true });
  t.after(() => db.close());
  assert.equal(db.prepare("PRAGMA user_version").get().user_version, 8);
  assert.equal(DB_USER_VERSION, 26);
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
    "Never queue a job on your own initiative",
    "explicit go",
    "MCP tools only - never the CLI, the database file, the home directory or the project's files",
    "`queue_run` without `job_id`",
    "read `notice_md` whole with `queue_status`",
    "queue_retry` only after the person answers",
    "`queue_close`",
    "`lesson_save` and `memory_save` record what a session learned",
    "offer `/nightqueue:reflect` once: it proposes lessons and memories and saves only the ones the person confirms",
    "both are allowed inside a queue job.",
  ]) {
    assert.ok(instructions.includes(idea), `\`${idea}\` is missing from the instructions:\n${instructions}`);
  }
  for (const removed of ["Queue every task or plan the moment it comes up", "Do not start jobs as they are queued", "issue_id", "the issues are where", "decision"]) {
    assert.equal(instructions.includes(removed), false, `the removed line \`${removed}\` is back in the instructions`);
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

test("the lesson, memory, index, phase and pipeline tools refuse an unknown project NAME, naming the known ones, and write nothing; a path outside every checkout is global", async (t) => {
  const env = makeHome(t, "mcp-lesson-unknown");
  const alpha = makeProject(t, env, "alpha");
  const client = await connect(t, env);
  const count = (table) => openDb(env).prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
  const lessons = () => count("lessons");

  for (const [name, args] of [
    ["lesson_save", { ...LESSON, project: "ghost" }],
    ["lesson_recall", { project: "ghost" }],
    ["memory_recall", { project: "ghost" }],
    ["index_save", { project: "ghost", repo_root: alpha, files: [{ path: "src/a.mjs", responsibility: "the module" }] }],
    ["index_recall", { project: "ghost" }],
    ["context_for_phase", { target: "coder", project: "ghost" }],
    ["phase_prompt", { target: "coder", project: "ghost", slug: "a-run" }],
    ["pipeline_log", { project: "ghost", slug: "a-run", tier: "simple", outcome: "investigated" }],
  ]) {
    const refused = await client.callTool({ name, arguments: args });
    assert.equal(refused.isError, true, name);
    assert.match(textOf(refused), /unknown project `ghost`; known projects: alpha/, name);
  }
  assert.equal(lessons(), 0, "a refused lesson_save wrote a row");
  assert.equal(count("project_index"), 0, "a refused index_save wrote a row");
  assert.equal(count("pipeline_runs"), 0, "a refused pipeline_log wrote a row");

  mkdirSync(join(alpha, "src"));
  const inside = payloadOf(await client.callTool({ name: "lesson_save", arguments: { ...LESSON, project: join(alpha, "src") } }));
  assert.equal(inside.project, "alpha");
  assert.equal(openDb(env).prepare("SELECT project_id FROM lessons WHERE id = ?").get(inside.id).project_id, projectIdOf(env, "alpha"));
  const outside = payloadOf(await client.callTool({ name: "lesson_save", arguments: { ...LESSON, title: "a global lesson", project: makeDir(t, "mcp-outside") } }));
  assert.equal(outside.project, null);
});

test("a deleted lesson is gone from lesson_recall and context_for_phase, and the answer names its id and title", async (t) => {
  const env = makeHome(t, "mcp-lesson-delete");
  makeProject(t, env, "alpha");
  const client = await connect(t, env);
  const saved = payloadOf(await client.callTool({ name: "lesson_save", arguments: { ...LESSON, project: "alpha" } }));
  const ask = { query: "the worker leaks a file descriptor", project: "alpha" };
  assert.ok(payloadOf(await client.callTool({ name: "lesson_recall", arguments: ask })).some((row) => row.id === saved.id));
  assert.match(payloadOf(await client.callTool({ name: "context_for_phase", arguments: { ...ask, target: "coder" } })).block, new RegExp(`\\[L${saved.id}\\]`));

  const deleted = payloadOf(await client.callTool({ name: "lesson_delete", arguments: { id: `L${saved.id}`, project: "alpha" } }));
  assert.deepEqual([deleted.id, deleted.title], [saved.id, LESSON.title]);
  assert.equal(payloadOf(await client.callTool({ name: "lesson_recall", arguments: ask })).some((row) => row.id === saved.id), false);
  assert.doesNotMatch(payloadOf(await client.callTool({ name: "context_for_phase", arguments: { ...ask, target: "coder" } })).block, /file descriptor/);
  assert.equal(openDb(env).prepare("SELECT COUNT(*) AS n FROM lessons_fts WHERE lessons_fts MATCH 'descriptor'").get().n, 0);
});

test("a deleted memory is gone from memory_recall, and the plain number and the M prefix both name it", async (t) => {
  const env = makeHome(t, "mcp-memory-delete");
  makeProject(t, env, "alpha");
  const client = await connect(t, env);
  const first = payloadOf(await client.callTool({ name: "memory_save", arguments: { project: "alpha", key: "queue usage", value: "zebra quagga" } }));
  const second = payloadOf(await client.callTool({ name: "memory_save", arguments: { project: "alpha", key: "other fact", value: "okapi wombat" } }));
  const deleted = payloadOf(await client.callTool({ name: "memory_delete", arguments: { id: first.ref, project: "alpha" } }));
  assert.deepEqual([deleted.id, deleted.key], [first.id, "queue usage"]);
  assert.equal(payloadOf(await client.callTool({ name: "memory_recall", arguments: { query: "zebra", project: "alpha" } })).some((row) => row.id === first.id), false);
  payloadOf(await client.callTool({ name: "memory_delete", arguments: { id: second.id, project: "alpha" } }));
  assert.equal(openDb(env).prepare("SELECT COUNT(*) AS n FROM memory").get().n, 0);
});

test("a delete from inside a queue job is refused and deletes nothing", async (t) => {
  const env = makeHome(t, "mcp-delete-in-job");
  makeProject(t, env, "alpha");
  const outside = await connect(t, env);
  const lesson = payloadOf(await outside.callTool({ name: "lesson_save", arguments: { ...LESSON, project: "alpha" } }));
  const memory = payloadOf(await outside.callTool({ name: "memory_save", arguments: { project: "alpha", key: "k", value: "v" } }));
  const inJob = await connect(t, { ...env, NIGHTQUEUE_JOB_ID: "7" });
  for (const [name, id] of [["lesson_delete", lesson.id], ["memory_delete", memory.id]]) {
    const refused = await inJob.callTool({ name, arguments: { id, project: "alpha" } });
    assert.equal(refused.isError, true, name);
    assert.match(textOf(refused), new RegExp(`refused: \`${name}\` inside J-7`), name);
  }
  assert.equal(openDb(env).prepare("SELECT COUNT(*) AS n FROM lessons").get().n, 1);
  assert.equal(openDb(env).prepare("SELECT COUNT(*) AS n FROM memory").get().n, 1);
});

test("a delete with the id of another project, or an unknown id, is refused and deletes nothing", async (t) => {
  const env = makeHome(t, "mcp-delete-refused");
  makeProject(t, env, "alpha");
  makeProject(t, env, "beta");
  const client = await connect(t, env);
  const lesson = payloadOf(await client.callTool({ name: "lesson_save", arguments: { ...LESSON, project: "alpha" } }));
  const memory = payloadOf(await client.callTool({ name: "memory_save", arguments: { project: "alpha", key: "k", value: "v" } }));
  const cases = [
    ["lesson_delete", { id: lesson.id, project: "beta" }, /belongs to project `alpha`.*nothing deleted/],
    ["memory_delete", { id: memory.id, project: "beta" }, /belongs to project `alpha`.*nothing deleted/],
    ["lesson_delete", { id: 999, project: "alpha" }, /unknown lesson `L999`; nothing deleted/],
    ["memory_delete", { id: "M999", project: "alpha" }, /unknown memory `M999`; nothing deleted/],
    ["lesson_delete", { id: "x1", project: "alpha" }, /expected a lesson id/],
  ];
  for (const [name, args, message] of cases) {
    const refused = await client.callTool({ name, arguments: args });
    assert.equal(refused.isError, true, name);
    assert.match(textOf(refused), message, name);
  }
  assert.equal(openDb(env).prepare("SELECT COUNT(*) AS n FROM lessons").get().n, 1);
  assert.equal(openDb(env).prepare("SELECT COUNT(*) AS n FROM memory").get().n, 1);
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
  assert.deepEqual(saved, { ok: true, files: 1, libs: 0, contract: 9 });

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

// The registry row of a project of a home, or undefined when the registry holds none.
function registeredProject(env, name) {
  return registry.projectByName(openDb(env), name) ?? undefined;
}

// The names of the registered projects of a home.
function registeredNames(env) {
  return registry.listProjects(openDb(env)).map((project) => project.name);
}

// A home whose queue is paused, so a detached runner started by a test never claims anything.
function makeQueueHome(t, name) {
  const env = makeHome(t, name);
  makeProject(t, env, "alpha");
  env.NIGHTQUEUE_CLAUDE_BIN = FAKE_CLAUDE;
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
    ref: "J-1",
    project: "alpha",
    priority: 2,
    timeoutS: 600,
    origin: [],
    hint: "queued J-1 for `alpha` (1 pending). 0 runners online - pending jobs will wait until `nightqueue queue run` starts one.",
    contract: 9,
  });
  assert.equal(getJob(1, env).prompt, "fix the worker");

  const second = payloadOf(await client.callTool({ name: "queue_add", arguments: { project: "alpha", prompt: "fix the parser" } }));
  assert.equal(second.hint, "queued J-2 for `alpha` (2 pending). 0 runners online - pending jobs will wait until `nightqueue queue run` starts one.");

  const add = (await client.listTools()).tools.find((tool) => tool.name === "queue_add");
  assert.deepEqual(Object.keys(add.inputSchema.properties).sort(), [
    "cwd",
    "key",
    "max_attempts",
    "origin",
    "priority",
    "project",
    "prompt",
    "register",
    "start_branch",
    "start_worktree",
    "tier",
    "timeout_s",
    "title",
  ]);
  assert.ok(add.description.includes("start the whole batch later with `queue_run`"), add.description);

  const byPath = await client.callTool({ name: "queue_add", arguments: { project: "/tmp/alpha", prompt: "fix the worker" } });
  assert.equal(byPath.isError, true);
  assert.match(textOf(byPath), /unknown project `\/tmp\/alpha`; known projects: alpha/);

  const unknown = await client.callTool({ name: "queue_add", arguments: { project: "ghost", prompt: "fix the worker" } });
  assert.equal(unknown.isError, true);
  assert.match(textOf(unknown), /unknown project `ghost`/);

  const outOfRange = await client.callTool({ name: "queue_add", arguments: { project: "alpha", prompt: "fix it", priority: 42 } });
  assert.equal(outOfRange.isError, true);
  assert.doesNotMatch(textOf(outOfRange), /\.mjs:\d+/);
});

test("queue_add refuses a prompt that depends on another job before resolving or queueing anything", async (t) => {
  const env = makeQueueHome(t, "mcp-queue-add-dependent");
  const client = await connect(t, env);

  for (const project of ["alpha", "ghost"]) {
    const refused = await client.callTool({ name: "queue_add", arguments: { project, prompt: "Add the export button after J-12." } });
    assert.equal(refused.isError, true);
    assert.equal(
      textOf(refused).includes(
        "This brief depends on another job's pull request. A job must be self-contained: fold this work into that job (as a stage) or make it independent. Nothing was changed. Matched: `after J-12`.",
      ),
      true,
      textOf(refused),
    );
  }
  assert.equal(getJob(1, env), null, "a refused prompt was queued");

  const fenced = payloadOf(
    await client.callTool({ name: "queue_add", arguments: { project: "alpha", prompt: "Fix the log line.\n\n```\nrun after J-12\n```\n" } }),
  );
  assert.equal(fenced.id, 1);
});

test("queue_retry refuses a closed job as finished and writes nothing", async (t) => {
  const env = makeQueueHome(t, "mcp-queue-retry-closed");
  const id = seedClosedJob(env);
  const before = getJob(id, env);
  const client = await connect(t, env);

  const refused = await client.callTool({ name: "queue_retry", arguments: { job_id: id, note: "again" } });
  assert.equal(refused.isError, true);
  assert.match(textOf(refused), new RegExp(`J-${id} is closed: a finished job does not resume; queue a new one`));
  assert.deepEqual(getJob(id, env), before, "a refused retry wrote to the closed job");
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

test("queue_add carries a starting point, echoes it, and refuses both at once without queueing", async (t) => {
  const env = makeQueueHome(t, "mcp-queue-add-start");
  const client = await connect(t, env);

  const onBranch = payloadOf(await client.callTool({ name: "queue_add", arguments: { project: "alpha", prompt: "finish it", start_branch: " feat/x " } }));
  assert.equal(onBranch.start_branch, "feat/x");
  assert.equal("start_worktree" in onBranch, false);
  assert.equal(getJob(onBranch.id, env).start_branch, "feat/x");

  const inWorktree = payloadOf(await client.callTool({ name: "queue_add", arguments: { project: "alpha", prompt: "finish it", start_worktree: "/tmp/wt" } }));
  assert.equal(inWorktree.start_worktree, "/tmp/wt");
  assert.equal(getJob(inWorktree.id, env).start_worktree, "/tmp/wt");

  const plain = payloadOf(await client.callTool({ name: "queue_add", arguments: { project: "alpha", prompt: "fix the parser" } }));
  assert.equal("start_branch" in plain, false);
  assert.equal(getJob(plain.id, env).start_branch, null);

  const both = await client.callTool({ name: "queue_add", arguments: { project: "alpha", prompt: "x", start_branch: "feat/x", start_worktree: "/tmp/wt" } });
  assert.equal(both.isError, true);
  assert.match(textOf(both), /either a start branch or a start worktree, not both/);
  assert.equal(getJob(4, env), null, "the refused starting point still queued a job");
});

test("queue_add resolves the project of the caller `cwd`, and answers needs_registration for a repository nobody registered", async (t) => {
  const env = makeQueueHome(t, "mcp-queue-add-cwd");
  const registered = registeredProject(env, "alpha").path;
  const repo = makeRepo(t, "mcp-queue-add-repo");
  const client = await connect(t, env);

  const known = payloadOf(await client.callTool({ name: "queue_add", arguments: { cwd: registered, prompt: "fix the worker" } }));
  assert.equal(known.project, "alpha");
  assert.equal(known.id, 1);

  const offered = payloadOf(await client.callTool({ name: "queue_add", arguments: { cwd: repo, prompt: "fix the parser" } }));
  assert.deepEqual(Object.keys(offered).sort(), ["contract", "cwd", "hint", "needs_registration", "org", "suggested_key", "suggested_name"].sort());
  assert.match(offered.suggested_key, /^[A-Z][A-Z0-9]{1,4}$/);
  assert.ok(offered.hint.includes(`with key \`${offered.suggested_key}\``), offered.hint);
  assert.ok(offered.hint.includes("plus `key` when the user chose another key"), offered.hint);
  assert.equal(offered.needs_registration, true);
  assert.equal(offered.cwd, repo);
  assert.equal(offered.org, "default");
  assert.ok(offered.hint.includes("call queue_add again with the same `cwd` and `register: true`"), offered.hint);
  assert.equal(getJob(2, env), null, "the offer queued a job");
  assert.equal(registeredProject(env, offered.suggested_name), undefined, "the offer registered the repository");

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
  const inJob = await connect(t, { ...env, NIGHTQUEUE_JOB_ID: "7" });

  const refused = await inJob.callTool({ name: "queue_add", arguments: { cwd: repo, prompt: "fix the worker", register: true } });
  assert.equal(refused.isError, true);
  assert.match(textOf(refused), /refusing to register .* from inside job `7`: an unattended run never registers a project/);
  assert.equal(getJob(1, env), null, "an unattended run queued a job through the registration branch");
  assert.deepEqual(registeredNames(env), ["alpha"], "an unattended run registered a project");

  const client = await connect(t, env);
  const queued = payloadOf(await client.callTool({ name: "queue_add", arguments: { cwd: repo, prompt: "fix the worker", register: true } }));
  const name = queued.project;
  const entry = registeredProject(env, name);
  assert.ok(entry, `\`${name}\` is missing from the registry`);
  assert.equal(entry.org, "default");
  assert.equal(getJob(queued.id, env).prompt, "fix the worker");
  assert.ok(queued.hint.startsWith(`registered project \`${name}\` (${entry.path}). queued J-${queued.id}`), queued.hint);

  const again = payloadOf(await client.callTool({ name: "queue_add", arguments: { cwd: repo, prompt: "fix the parser" } }));
  assert.equal(again.project, name, "the registered repository was offered for registration again");
  assert.equal(again.needs_registration, undefined);

  const chosenRepo = makeRepo(t, "mcp-queue-register-key-repo");
  const invalid = await client.callTool({ name: "queue_add", arguments: { cwd: chosenRepo, prompt: "fix it", register: true, key: "1x" } });
  assert.equal(invalid.isError, true);
  assert.match(textOf(invalid), /key `1x` is invalid/);
  const offered = payloadOf(await client.callTool({ name: "queue_add", arguments: { cwd: chosenRepo, prompt: "fix it" } }));
  const chosen = payloadOf(await client.callTool({ name: "queue_add", arguments: { cwd: chosenRepo, prompt: "fix it", register: true, key: "mq1" } }));
  assert.equal(registeredProject(env, chosen.project).key, "MQ1");
  assert.notEqual(offered.suggested_key, "MQ1");
});

test("project_register registers the repository with the defaults, and answers an already registered one without writing", async (t) => {
  const env = makeQueueHome(t, "mcp-project-register");
  const repo = makeRepo(t, "mcp-project-register-repo");
  const client = await connect(t, env);

  const created = payloadOf(await client.callTool({ name: "project_register", arguments: { cwd: repo } }));
  const entry = registeredProject(env, created.project);
  assert.ok(entry, "the repository was not registered");
  assert.equal(created.registered, true);
  assert.equal(created.org, "default");
  assert.equal(created.key, entry.key);
  assert.equal(created.path, entry.path);
  assert.equal(created.hint, `registered project ${created.project} (${entry.path}) in org default with key ${entry.key}. Nothing was queued.`);

  const again = payloadOf(await client.callTool({ name: "project_register", arguments: { cwd: repo, name: "other", key: "ot1" } }));
  assert.equal(again.registered, false);
  assert.equal(again.project, created.project);
  assert.match(again.hint, /^already registered project /);
  assert.match(again.hint, /Nothing was queued\.$/);
  assert.deepEqual(registeredNames(env).sort(), ["alpha", created.project].sort(), "an already registered directory wrote a row");

  const chosenRepo = makeRepo(t, "mcp-project-register-chosen");
  const chosen = payloadOf(await client.callTool({ name: "project_register", arguments: { cwd: chosenRepo, name: "chosen", key: "ch1" } }));
  assert.equal(chosen.project, "chosen");
  assert.equal(chosen.key, "CH1");
});

test("project_register refuses an unknown org with the list of orgs, and a directory outside any repository", async (t) => {
  const env = makeQueueHome(t, "mcp-project-register-org");
  const repo = makeRepo(t, "mcp-project-register-org-repo");
  const client = await connect(t, env);

  const unknown = await client.callTool({ name: "project_register", arguments: { cwd: repo, org: "nowhere" } });
  assert.equal(unknown.isError, true);
  assert.match(textOf(unknown), /unknown org `nowhere`; existing orgs: .*default/);
  assert.deepEqual(registeredNames(env), ["alpha"], "a refused org registered a project");

  const outside = await client.callTool({ name: "project_register", arguments: { cwd: makeDir(t, "mcp-project-register-bare") } });
  assert.equal(outside.isError, true);
  assert.match(textOf(outside), /is not inside a git repository/);
});

test("project_register is refused from inside a job", async (t) => {
  const env = makeQueueHome(t, "mcp-project-register-job");
  const repo = makeRepo(t, "mcp-project-register-job-repo");
  const inJob = await connect(t, { ...env, NIGHTQUEUE_JOB_ID: "7" });

  const refused = await inJob.callTool({ name: "project_register", arguments: { cwd: repo } });
  assert.equal(refused.isError, true);
  assert.match(textOf(refused), /refusing to register .* from inside job `7`/);
  assert.deepEqual(registeredNames(env), ["alpha"], "an unattended run registered a project");
});

test("project_register resolves a linked worktree to its main checkout", async (t) => {
  const env = makeQueueHome(t, "mcp-project-register-worktree");
  const main = makeRepo(t, "mcp-project-register-main");
  const linkedGit = join(main, ".git", "worktrees", "wt");
  mkdirSync(linkedGit, { recursive: true });
  writeFileSync(join(linkedGit, "commondir"), "../..\n");
  const linked = makeDir(t, "mcp-project-register-linked");
  writeFileSync(join(linked, ".git"), `gitdir: ${linkedGit}\n`);
  const client = await connect(t, env);

  const answer = payloadOf(await client.callTool({ name: "project_register", arguments: { cwd: linked } }));
  assert.equal(answer.registered, true);
  assert.equal(answer.path, registeredProject(env, answer.project).path);
  assert.equal(answer.path, realpathSync(main));
});

test("queue_add and queue_cancel refuse the home of the runner from inside a job, and accept a temporary one", async (t) => {
  const env = makeQueueHome(t, "mcp-home-guard");
  const id = addJob({ projectId: ensureProject(env, "alpha"), prompt: "fix the worker" }, env).id;
  const inJob = await connect(t, { ...env, NIGHTQUEUE_JOB_ID: "9", NIGHTQUEUE_JOB_HOME: homeDir(env) });

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
  const allowed = await connect(t, { ...temp, NIGHTQUEUE_JOB_ID: "9", NIGHTQUEUE_JOB_HOME: homeDir(env) });
  const queued = payloadOf(await allowed.callTool({ name: "queue_add", arguments: { project: "alpha", prompt: "verify the acceptance of this change" } }));
  assert.equal(getJob(queued.id, temp).prompt, "verify the acceptance of this change");
  const cancelled = payloadOf(await allowed.callTool({ name: "queue_cancel", arguments: { job_id: queued.id } }));
  assert.equal(cancelled.job.status, "cancelled");
  assert.equal(getJob(id + 1, env), null, "a call isolated in a temporary home reached the home of the operator");
});

test("queue_status never returns the prompt and truncates the free text at five hundred code points", async (t) => {
  const env = makeQueueHome(t, "mcp-queue-status");
  const id = addJob({ projectId: ensureProject(env, "alpha"), prompt: "a prompt no tool may ever return" }, env).id;
  addJob({ projectId: ensureProject(env, "alpha"), prompt: "another one" }, env);
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
  const pointer = `J-${id} text cut at 500 characters - read it whole with nightqueue queue status J-${id}`;
  assert.deepEqual(listed.suggestions, [pointer]);
  assert.ok(listed.hint.endsWith(pointer), listed.hint);
  assert.equal("notice_truncated" in one.job, false, "the detail of one job was flagged as cut");
  assert.equal(listed.counts.pending, 2);
  for (const job of listed.jobs) assert.equal("prompt" in job, false, "the listing leaked a prompt");
  assert.equal("runner" in listed, false, "the deprecated singular `runner` key is back on queue_status");
  assert.equal(listed.runnersOnline, 0);
  assert.deepEqual(listed.runners, [], "a home with no runner answered with one");

  const startedAt = "2026-09-08T21:04:11.000Z";
  const runtimeDir = "/tmp/runtime/versions/1.0.0-20260911T031500Z";
  writeRunnerRecord({ pid: process.pid, startedAt, mode: "watch", intervalS: 30, logPath: "/tmp/runner.log", runtimeDir }, env);
  const watched = payloadOf(await client.callTool({ name: "queue_status", arguments: { limit: null, job_id: null } }));
  assert.deepEqual(watched.runners, [{
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
  }]);
  assert.equal(watched.runnersOnline, 1);
  assert.equal("runner" in watched, false, "the deprecated singular `runner` key is back on queue_status");
  assert.equal("runner" in payloadOf(await client.callTool({ name: "queue_status", arguments: { job_id: id } })), false, "the detail of a job grew a runner");

  const unknown = await client.callTool({ name: "queue_status", arguments: { job_id: 99 } });
  assert.equal(unknown.isError, true);
  assert.match(textOf(unknown), /unknown job `99`/);
});

test("queue_status of one job shows a host-command counter only when it is not zero", async (t) => {
  const env = makeQueueHome(t, "mcp-queue-status-host-commands");
  const zero = addJob({ projectId: ensureProject(env, "alpha"), prompt: "never timed out" }, env).id;
  const some = addJob({ projectId: ensureProject(env, "alpha"), prompt: "timed out and got backgrounded" }, env).id;
  openDb(env).prepare("UPDATE jobs SET bash_timeouts = 0, tasks_backgrounded = 0, tasks_killed = 0 WHERE id = ?").run(zero);
  openDb(env).prepare("UPDATE jobs SET bash_timeouts = 1, tasks_backgrounded = 2, tasks_killed = 0 WHERE id = ?").run(some);
  const client = await connect(t, env);

  const atZero = payloadOf(await client.callTool({ name: "queue_status", arguments: { job_id: zero } })).job;
  assert.equal(atZero.bash_timeouts, null);
  assert.equal(atZero.tasks_backgrounded, null);
  assert.equal(atZero.tasks_killed, null);

  const nonZero = payloadOf(await client.callTool({ name: "queue_status", arguments: { job_id: some } })).job;
  assert.equal(nonZero.bash_timeouts, 1);
  assert.equal(nonZero.tasks_backgrounded, 2);
  assert.equal(nonZero.tasks_killed, null);
});

test("queue_status of one job carries the five orchestrator counters, zero included", async (t) => {
  const env = makeQueueHome(t, "mcp-queue-status-orchestrator");
  const id = addJob({ projectId: ensureProject(env, "alpha"), prompt: "measured job" }, env).id;
  openDb(env)
    .prepare("UPDATE jobs SET orch_turns = 20, orch_reads = 0, orch_bash = 8, orch_bash_explore = 0, orch_ctx_last = 120000 WHERE id = ?")
    .run(id);
  const client = await connect(t, env);

  const job = payloadOf(await client.callTool({ name: "queue_status", arguments: { job_id: id } })).job;
  assert.deepEqual(
    [job.orch_turns, job.orch_reads, job.orch_bash, job.orch_bash_explore, job.orch_ctx_last],
    [20, 0, 8, 0, 120000],
  );
});

test("queue_status carries the run's own notice, whole, whenever it differs from the row's - and only for one job", async (t) => {
  const env = makeQueueHome(t, "mcp-queue-status-run-notice");
  const id = addJob({ projectId: ensureProject(env, "alpha"), prompt: "fix the worker" }, env).id;
  mkdirSync(logsDir(env), { recursive: true });
  const runNotice = "Delivered - the queue can now be told to work only inside a window.";
  const resultText = `Done.\n\n## Notice\n\n${runNotice}`;
  writeFileSync(jobLogPath(id, env), `${JSON.stringify({ type: "result", subtype: "success", result: resultText })}\n`);
  openDb(env)
    .prepare("UPDATE jobs SET status = 'done', notice_md = ?, result = ? WHERE id = ?")
    .run("a stale summary the row kept", JSON.stringify({ status: "done", logPath: jobLogPath(id, env) }), id);
  const client = await connect(t, env);

  const one = payloadOf(await client.callTool({ name: "queue_status", arguments: { job_id: id } }));
  assert.equal(one.job.notice_md, "a stale summary the row kept");
  assert.equal(one.job.run_notice, runNotice);

  const listed = payloadOf(await client.callTool({ name: "queue_status", arguments: { limit: null, job_id: null } }));
  assert.equal("run_notice" in listed.jobs.find((job) => job.id === id), false, "the listing carried the run's own notice too, not just the single job view");
});

test("queue_status never fails when the log of a finished job is missing: `run_notice` is simply absent", async (t) => {
  const env = makeQueueHome(t, "mcp-queue-status-run-notice-missing");
  const id = addJob({ projectId: ensureProject(env, "alpha"), prompt: "fix the worker" }, env).id;
  openDb(env)
    .prepare("UPDATE jobs SET status = 'done', notice_md = ?, result = ? WHERE id = ?")
    .run("the row's own notice", JSON.stringify({ status: "done", logPath: jobLogPath(id, env) }), id);
  const client = await connect(t, env);

  const one = payloadOf(await client.callTool({ name: "queue_status", arguments: { job_id: id } }));
  assert.equal(one.job.notice_md, "the row's own notice");
  assert.equal("run_notice" in one.job, false, "a missing log turned into an error field instead of simply being absent");
});

test("queue_status returns a gate notice near three kilobytes whole, and clips it with a pointer in the listing", async (t) => {
  const env = makeQueueHome(t, "mcp-queue-status-big-gate-notice");
  const id = addJob({ projectId: ensureProject(env, "alpha"), prompt: "fix the worker" }, env).id;
  const points = Array.from(
    { length: 8 },
    (_, i) => `- **C${i + 1}:** ${"the plan departs from the brief on a point that needs a human call before it goes out. ".repeat(5)}`,
  );
  const notice = ["## Requires user confirmation", "", ...points, "", `Answer with: nightqueue queue retry ${id} --note "<your answer>"`].join("\n");
  assert.ok(Array.from(notice).length > 2900, "setup: the notice must be close to three kilobytes");
  openDb(env).prepare("UPDATE jobs SET status = 'gate', notice_md = ? WHERE id = ?").run(notice, id);
  const client = await connect(t, env);

  const one = payloadOf(await client.callTool({ name: "queue_status", arguments: { job_id: id } }));
  assert.equal(one.job.notice_md, notice, "the detail of one job cut a gate notice that has no length cap");

  const listed = payloadOf(await client.callTool({ name: "queue_status", arguments: { limit: null, job_id: null } }));
  const row = listed.jobs.find((job) => job.id === id);
  assert.equal(row.notice_md, `${Array.from(notice).slice(0, 500).join("")}...`, "the listing did not clip the gate notice");
  assert.equal(row.notice_truncated, true);
  assert.ok(listed.suggestions.includes(`J-${id} text cut at 500 characters - read it whole with nightqueue queue status J-${id}`), listed.suggestions.join("\n"));
});

test("queue_status refuses instead of answering with no runner for a registry it could not read", async (t) => {
  const env = makeQueueHome(t, "mcp-queue-status-unreadable");
  addJob({ projectId: ensureProject(env, "alpha"), prompt: "fix the worker" }, env);
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
  const log = env.NIGHTQUEUE_FAKE_GH_LOG;
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
  deliver(base, addJob({ projectId: ensureProject(base, "alpha"), prompt: "fix the worker" }, base).id);
  const env = { ...base, ...isolatedHostVars(makeDir(t, "mcp-queue-merged-host")), NIGHTQUEUE_FAKE_GH_PR_STATE: "MERGED", NIGHTQUEUE_FAKE_GH_PR_SHA: MERGE_SHA };
  delete env.NIGHTQUEUE_NO_PR_CHECK;

  const client = await connect(t, env);
  const first = payloadOf(await client.callTool({ name: "queue_status", arguments: {} }));
  assert.equal(first.jobs[0].pr_state, "unknown", "the first answer waited for gh instead of answering from the cache");
  assert.deepEqual(first.suggestions, []);
  assert.deepEqual(first.sections.map((section) => section.name), ["jobs", "counts", "runners", "advisories", "closes", "live"]);
  assert.ok(first.sections.every((section) => section.ok && Number.isInteger(section.ms)), JSON.stringify(first.sections));

  const listed = await pollPrState(client, "merged");
  assert.equal(listed.jobs[0].pr_state, "merged", "the refresh fired after the answer never landed in the cache");
  assert.deepEqual(listed.suggestions, ["J-1 PR merged - close it with nightqueue queue close J-1"]);
  assert.ok(listed.hint.endsWith("J-1 PR merged - close it with nightqueue queue close J-1"), listed.hint);
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

  const inJob = await connect(t, { ...env, NIGHTQUEUE_JOB_ID: "7", NIGHTQUEUE_FAKE_GH_LOG: join(makeDir(t, "mcp-queue-merged-job"), "gh.log") });
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
    "0 runners online - pending jobs will wait until `nightqueue queue run` starts one",
    "an empty queue with no runner stayed silent about it",
  );

  const first = addJob({ projectId: ensureProject(env, "alpha"), prompt: "fix the worker" }, env).id;
  const one = payloadOf(await client.callTool({ name: "queue_status", arguments: {} }));
  assert.equal(one.hint, "0 runners online - pending jobs will wait until `nightqueue queue run` starts one");

  addJob({ projectId: ensureProject(env, "alpha"), prompt: "fix the parser" }, env);
  const two = payloadOf(await client.callTool({ name: "queue_status", arguments: {} }));
  assert.equal(two.hint, "0 runners online - pending jobs will wait until `nightqueue queue run` starts one");

  claimJobById(first, { worker: "host:4242", cap: 4 }, env);
  const claimed = payloadOf(await client.callTool({ name: "queue_status", arguments: {} }));
  assert.equal(
    claimed.hint,
    "0 runners online - a job is running under a one-shot runner, nothing will pick up the pending jobs after it - start a drain with `nightqueue queue run`",
  );

  const detail = payloadOf(await client.callTool({ name: "queue_status", arguments: { job_id: first } }));
  assert.deepEqual(Object.keys(detail), ["job", "contract"], "the detail of a job grew a hint");

  const watchedEnv = makeQueueHome(t, "mcp-queue-hint-watch");
  addJob({ projectId: ensureProject(watchedEnv, "alpha"), prompt: "fix the worker" }, watchedEnv);
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

test("queue_add and queue_status do not promise a pickup to a once runner bound to another job", async (t) => {
  const env = makeQueueHome(t, "mcp-queue-hint-once");
  addJob({ projectId: ensureProject(env, "alpha"), prompt: "the job the once runner holds" }, env);
  const startedAt = new Date().toISOString();
  writeRunnerRecord({ pid: process.pid, startedAt, mode: "once", jobId: 1, logPath: "/tmp/once.log" }, env);
  const client = await connect(t, env);

  const other = payloadOf(await client.callTool({ name: "queue_add", arguments: { project: "alpha", prompt: "fix the parser" } }));
  assert.match(other.hint, /1 runner online in once mode for J-1 - it will not pick this job; start a drain with queue_run \(no job_id\)\.$/);
  const status = payloadOf(await client.callTool({ name: "queue_status", arguments: {} }));
  assert.match(status.hint, /^1 runner online: 1 once \(J-1\) - /);

  writeRunnerRecord({ pid: process.ppid, startedAt, mode: "drain", logPath: "/tmp/drain.log" }, env);
  const mixed = payloadOf(await client.callTool({ name: "queue_add", arguments: { project: "alpha", prompt: "fix the lexer" } }));
  assert.match(mixed.hint, /1 runner online - it will be picked up\.$/, "the once runner of another job was counted beside the drain");
  const split = payloadOf(await client.callTool({ name: "queue_status", arguments: {} }));
  assert.match(split.hint, /^2 runners online: 1 drain, 1 once \(J-1\) - /);
});

test("queue_retry says who will pick the job up: a drain, a once runner of another job, and a once runner bound to it", async (t) => {
  const env = makeQueueHome(t, "mcp-queue-retry-hint");
  const id = addJob({ projectId: ensureProject(env, "alpha"), prompt: "fix the parser" }, env).id;
  const client = await connect(t, env);
  const startedAt = new Date().toISOString();
  const retryAfterCancel = async () => {
    await client.callTool({ name: "queue_cancel", arguments: { job_id: id } });
    return payloadOf(await client.callTool({ name: "queue_retry", arguments: { job_id: id } })).hint;
  };

  writeRunnerRecord({ pid: process.pid, startedAt, mode: "drain", logPath: "/tmp/r.log" }, env);
  assert.equal(await retryAfterCancel(), "1 runner online - it will be picked up.");

  writeRunnerRecord({ pid: process.pid, startedAt, mode: "once", jobId: id + 40, logPath: "/tmp/r.log" }, env);
  assert.match(await retryAfterCancel(), new RegExp(`^1 runner online in once mode for J-${id + 40} - it will not pick this job; start a drain with queue_run \\(no job_id\\)\\.$`));

  writeRunnerRecord({ pid: process.pid, startedAt, mode: "once", jobId: id, logPath: "/tmp/r.log" }, env);
  assert.equal(await retryAfterCancel(), "1 runner online - it will be picked up.");
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
  assert.equal(empty.runners[0].pausedUntil, new Date(resetsAt.getTime() + 60_000).toISOString());

  const queued = payloadOf(await client.callTool({ name: "queue_add", arguments: { project: "alpha", prompt: "fix the worker" } }));
  assert.equal(queued.hint, `queued J-1 for \`alpha\` (1 pending). 1 runner online - nothing to start: ${pause}; it claims again by itself when the limit resets.`);

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
  assert.equal(queued.hint, `queued J-1 for \`alpha\` (1 pending). ${waiting}; it claims once the window opens.`);

  const status = payloadOf(await client.callTool({ name: "queue_status", arguments: {} }));
  assert.deepEqual(status.runners[0].window, window, "queue_status did not carry the window of the live runner");

  const resetsAt = new Date(Date.now() + 1800_000);
  writeRunnerRecord({ pid: process.pid, startedAt: new Date().toISOString(), mode: "watch", intervalS: 30, logPath: "/tmp/runner.log", window, rateLimit: pauseRegion(resetsAt) }, env);
  const pausedAndWaiting = payloadOf(await client.callTool({ name: "queue_add", arguments: { project: "alpha", prompt: "fix the parser" } }));
  assert.match(pausedAndWaiting.hint, /nothing to start: the runner is paused/, "the window wait was reported over the nearer rate-limit pause");
  assert.equal(pausedAndWaiting.hint.includes("waiting for its window"), false);
});

test("a backlog parked by a rate limit is what queue_status says, instead of asking for a batch that would claim nothing", async (t) => {
  const env = makeQueueHome(t, "mcp-queue-hint-parked");
  const parked = addJob({ projectId: ensureProject(env, "alpha"), prompt: "fix the worker" }, env).id;
  const notBefore = new Date(Date.now() + 3600_000).toISOString();
  claimJobById(parked, { worker: "host:4242", cap: 4 }, env);
  assert.equal(parkJob(parked, { worker: "host:4242", notBefore, result: { rateLimited: true, notBefore } }, env), true, "the fixture did not park the job");
  const client = await connect(t, env);

  const waiting = payloadOf(await client.callTool({ name: "queue_status", arguments: {} }));

  assert.equal(waiting.runnersOnline, 0, "the fixture left a live runner behind, so the nudge is not the one under test");
  assert.equal(waiting.hint, `0 runners online - 1 pending job waiting — the rate limit resets at ${clockLabel(Date.parse(notBefore))} (in 1h00); a batch started now claims nothing before that.`);

  addJob({ projectId: ensureProject(env, "alpha"), prompt: "fix the parser" }, env);
  const mixed = payloadOf(await client.callTool({ name: "queue_status", arguments: {} }));
  assert.equal(mixed.hint, "0 runners online - pending jobs will wait until `nightqueue queue run` starts one", "a job that could be claimed right now was held back by the park of another one");
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
  assert.ok(tool.description.includes("nightqueue queue run --stop"), "the tool does not say how a watcher is stopped");
  assert.ok(tool.description.includes("Each runner works one job at a time"), "the tool does not say a runner works one job at a time");
  assert.ok(tool.description.includes("`advisories`"), "the tool does not name the advisories it answers");
});

const ALPHA_ADVISORY =
  "2 runners on `alpha` — parallel jobs on one repository fight over the checkout; a job the preflight blocks waits at a gate for queue retry";

test("queue_run and queue_retry start nothing when the ceiling is full, and say what the job is waiting for", async (t) => {
  const env = makeQueueHome(t, "mcp-queue-run-waiting");
  rmSync(queuePausedPath(env), { force: true });
  saveConfig({ ...loadConfig(env, { warn: () => {} }), queue: { maxConcurrent: 2 } }, env);
  const id = addJob({ projectId: ensureProject(env, "alpha"), prompt: "fix the worker" }, env).id;
  for (const prompt of ["hold the first slot", "hold the second slot"]) {
    claimJobById(addJob({ projectId: ensureProject(env, "alpha"), prompt }, env).id, { worker: `host:${prompt.length}`, cap: 4 }, env);
  }
  writeRunnerRecord({ pid: process.pid, startedAt: new Date().toISOString(), mode: "drain", intervalS: null, logPath: null }, env);
  const client = await connect(t, env);

  const started = payloadOf(await client.callTool({ name: "queue_run", arguments: { job_id: id } }));
  assert.deepEqual(
    { ok: started.ok, started: started.started, pid: started.pid, reason: started.waiting?.reason },
    { ok: true, started: false, pid: null, reason: "cap-reached" },
  );
  assert.match(started.message, /J-1 waiting: concurrency cap reached; 2 of 2 jobs already running/);
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
  assert.equal("runner" in listed, false, "the deprecated singular `runner` key is back on queue_status");
});

// Writes a minimal installed version of this package under `runtime/versions/<name>`, holding only the entry point the resolver checks for.
function writeRuntimeVersion(env, name) {
  const pkgDir = join(runtimeVersionsDir(env), name, "node_modules", PACKAGE_NAME);
  mkdirSync(join(pkgDir, "bin"), { recursive: true });
  writeFileSync(join(pkgDir, "bin", "nightqueue.mjs"), "");
}

// Points `runtime/current` at one version directory, the way an install does.
function switchRuntimeCurrent(env, name) {
  mkdirSync(runtimeDir(env), { recursive: true });
  symlinkSync(join("versions", name), runtimeCurrentLink(env));
}

const SUPERSEDED_VERSION = "0.2.0-20260919T181653Z";
const CURRENT_VERSION = "0.2.0-20260921T142701Z";

test("a server kept open since before an install names its own superseded runtime, in the hint of queue_status, queue_run and queue_add", async (t) => {
  const env = makeQueueHome(t, "mcp-stale-runtime");
  writeRuntimeVersion(env, SUPERSEDED_VERSION);
  writeRuntimeVersion(env, CURRENT_VERSION);
  switchRuntimeCurrent(env, CURRENT_VERSION);
  const client = await connect(t, env);
  const restartLine = `this MCP server runs a superseded runtime`;

  const status = payloadOf(await client.callTool({ name: "queue_status", arguments: {} }));
  assert.ok(status.hint.includes(restartLine), status.hint);
  assert.ok(
    status.advisories.some((line) => line === `${restartLine} (${packageRoot()}) - restart the MCP client to load ${CURRENT_VERSION}`),
    JSON.stringify(status.advisories),
  );

  const run = payloadOf(await client.callTool({ name: "queue_run", arguments: { job_id: null } }));
  assert.equal(run.started, false, "the paused queue would have spawned a runner anyway");
  assert.ok(
    run.advisories.some((line) => line.startsWith(restartLine)),
    JSON.stringify(run.advisories),
  );

  const added = payloadOf(await client.callTool({ name: "queue_add", arguments: { project: "alpha", prompt: "fix the worker" } }));
  assert.ok(added.hint.includes(restartLine), added.hint);
});

test("the stale-runtime hint never appears when this server already runs the current one, or none is installed at all", async (t) => {
  const env = makeQueueHome(t, "mcp-fresh-runtime");
  const client = await connect(t, env);

  const status = payloadOf(await client.callTool({ name: "queue_status", arguments: {} }));
  assert.equal(status.hint.includes("superseded runtime"), false, status.hint);
  assert.deepEqual(status.advisories, []);

  const added = payloadOf(await client.callTool({ name: "queue_add", arguments: { project: "alpha", prompt: "fix the worker" } }));
  assert.equal(added.hint.includes("superseded runtime"), false, added.hint);
});

test("queue_cancel takes a pending job, a gated one and an orphan, and refuses a live run or a finished one", async (t) => {
  const env = makeQueueHome(t, "mcp-queue-cancel");
  const pending = addJob({ projectId: ensureProject(env, "alpha"), prompt: "fix the worker" }, env).id;
  const running = addJob({ projectId: ensureProject(env, "alpha"), prompt: "fix the parser" }, env).id;
  claimJobById(running, { worker: "host:4242", cap: 4 }, env);
  const client = await connect(t, env);

  const refused = await client.callTool({ name: "queue_cancel", arguments: { job_id: running, reason: null } });
  assert.equal(refused.isError, true);
  assert.match(textOf(refused), /is running with a live lease on worker `host:4242`/);
  assert.equal(getJob(running, env).status, "running", "the refused cancel wrote to the row");

  const cancelled = payloadOf(await client.callTool({ name: "queue_cancel", arguments: { job_id: pending, reason: "no longer needed" } }));
  assert.equal(cancelled.job.status, "cancelled");
  assert.equal(cancelled.job.operator_note, "no longer needed");
  assert.equal("runner" in cancelled, false, "the plain cancel grew a runner key");

  const twice = await client.callTool({ name: "queue_cancel", arguments: { job_id: pending } });
  assert.equal(twice.isError, true);
  assert.match(textOf(twice), /already finished with status `cancelled`/);

  openDb(env).prepare("UPDATE jobs SET lease_until = datetime('now', '-120 seconds') WHERE id = ?").run(running);
  const orphan = payloadOf(await client.callTool({ name: "queue_cancel", arguments: { job_id: running } }));
  assert.equal(orphan.job.status, "cancelled");
  assert.equal(orphan.job.worker, null);

  const gated = addJob({ projectId: ensureProject(env, "alpha"), prompt: "wait for a human" }, env).id;
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

test("queue_cancel with stop cancels a job that is not running by the plain rules, refuses a runner of another host, and release_worktree needs stop", async (t) => {
  const env = makeQueueHome(t, "mcp-queue-cancel-stop");
  const pending = addJob({ projectId: ensureProject(env, "alpha"), prompt: "fix the worker" }, env).id;
  const remote = addJob({ projectId: ensureProject(env, "alpha"), prompt: "fix the parser" }, env).id;
  claimJobById(remote, { worker: "other-host:1", cap: 4 }, env);
  const client = await connect(t, env);

  const cancelled = payloadOf(await client.callTool({ name: "queue_cancel", arguments: { job_id: pending, reason: "brief changed", stop: true } }));
  assert.equal(cancelled.ok, true);
  assert.equal(cancelled.job.status, "cancelled");
  assert.equal(cancelled.runner, null);

  const before = rowAtRest(getJob(remote, env));
  const refused = await client.callTool({ name: "queue_cancel", arguments: { job_id: remote, stop: true } });
  assert.equal(refused.isError, true, textOf(refused));
  assert.match(textOf(refused), /is running on worker `other-host:1`, a runner of host `other-host`; nightqueue only stops a runner of this host/);
  assert.deepEqual(rowAtRest(getJob(remote, env)), before, "the refused stop wrote to the row");

  const unpaired = await client.callTool({ name: "queue_cancel", arguments: { job_id: remote, release_worktree: true } });
  assert.equal(unpaired.isError, true, textOf(unpaired));
  assert.match(textOf(unpaired), /`release_worktree` only has meaning with `stop: true`/);
  assert.deepEqual(rowAtRest(getJob(remote, env)), before, "the refused release wrote to the row");
});

test("queue_stop answers the CLI line per runner, and refuses an unknown pid", async (t) => {
  const env = makeQueueHome(t, "mcp-queue-stop");
  const client = await connect(t, env);

  const empty = payloadOf(await client.callTool({ name: "queue_stop", arguments: {} }));
  assert.deepEqual(empty, { ok: true, runners: [{ outcome: "absent", pid: null, message: "runner is not running" }], contract: 9 });

  const unknown = await client.callTool({ name: "queue_stop", arguments: { pid: 999999 } });
  assert.equal(unknown.isError, true, textOf(unknown));
  assert.match(textOf(unknown), /no runner is registered with pid 999999/);
});

test("queue_stop refuses the home of the runner from inside a job, like queue_cancel", async (t) => {
  const env = makeQueueHome(t, "mcp-stop-home-guard");
  const inJob = await connect(t, { ...env, NIGHTQUEUE_JOB_ID: "9", NIGHTQUEUE_JOB_HOME: homeDir(env) });

  const refused = await inJob.callTool({ name: "queue_stop", arguments: {} });
  assert.equal(refused.isError, true, textOf(refused));
  assert.ok(textOf(refused).includes(HOME_REFUSAL), textOf(refused));
});

test("queue_close runs only on a done job, never forced without a pull request, refusing every other job by name without writing", async (t) => {
  const env = makeQueueHome(t, "mcp-queue-close");
  const noPr = addJob({ projectId: ensureProject(env, "alpha"), prompt: "fix the worker" }, env).id;
  openDb(env).prepare("UPDATE jobs SET status = 'done' WHERE id = ?").run(noPr);
  const noChange = addJob({ projectId: ensureProject(env, "alpha"), prompt: "explain the loop" }, env).id;
  openDb(env).prepare(`UPDATE jobs SET status = 'done', result = '{"resolution":"no-change"}' WHERE id = ?`).run(noChange);
  const failed = addJob({ projectId: ensureProject(env, "alpha"), prompt: "fix the parser" }, env).id;
  openDb(env).prepare("UPDATE jobs SET status = 'failed', pr_url = ?, finished_at = ? WHERE id = ?").run("https://github.com/acme/api/pull/42", GATED_FINISHED_AT, failed);
  const pending = addJob({ projectId: ensureProject(env, "alpha"), prompt: "wait for a human" }, env).id;
  const running = addJob({ projectId: ensureProject(env, "alpha"), prompt: "keep running" }, env).id;
  claimJobById(running, { worker: "host:1", cap: 4 }, env);
  const client = await connect(t, env);

  const cases = [
    [noPr, /nothing to close: the job has no pull request/],
    [noChange, /has no pull request: --force only skips pull request checks; close it without --force/],
    [failed, /failed; retry it or cancel it - only a done job is closed/],
    [pending, /is pending; it has not produced a pull request yet/],
    [running, /is running with a live lease on worker/],
  ];
  for (const [id, reason] of cases) {
    const before = rowAtRest(getJob(id, env));
    const refused = await client.callTool({ name: "queue_close", arguments: { job_id: id, force: true } });
    assert.equal(refused.isError, true, textOf(refused));
    assert.match(textOf(refused), reason);
    assert.deepEqual(rowAtRest(getJob(id, env)), before, `the refused close wrote to job ${id}`);
  }
});

test("queue_close refuses the home of the runner from inside a job, like queue_cancel", async (t) => {
  const env = makeQueueHome(t, "mcp-close-home-guard");
  const id = addJob({ projectId: ensureProject(env, "alpha"), prompt: "fix the worker" }, env).id;
  openDb(env).prepare("UPDATE jobs SET status = 'done' WHERE id = ?").run(id);
  const inJob = await connect(t, { ...env, NIGHTQUEUE_JOB_ID: "9", NIGHTQUEUE_JOB_HOME: homeDir(env) });

  const refused = await inJob.callTool({ name: "queue_close", arguments: { job_id: id } });
  assert.equal(refused.isError, true, textOf(refused));
  assert.ok(textOf(refused).includes(HOME_REFUSAL), textOf(refused));
  assert.equal(getJob(id, env).status, "done", "a refused close still moved the job of the operator");
});

test("queue_retry answers a gate, refuses one without a note and only starts a runner when asked", async (t) => {
  const env = makeQueueHome(t, "mcp-queue-retry");
  const gated = addJob({ projectId: ensureProject(env, "alpha"), prompt: "wait for a human" }, env).id;
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
  assert.match(retried.hint, /^0 runners online - pending jobs will wait until `nightqueue queue run` starts one\.$/);
  assert.equal(getJob(gated, env).finished_at, null);

  const unknown = await client.callTool({ name: "queue_retry", arguments: { job_id: 4242, note: "go" } });
  assert.equal(unknown.isError, true);
  assert.match(textOf(unknown), /unknown job `4242`/);
});

test("a server pinned to a job refuses queue_retry aimed at any other job, and leaves that job untouched", async (t) => {
  const env = makeQueueHome(t, "mcp-queue-retry-scope");
  const victim = addJob({ projectId: ensureProject(env, "alpha"), prompt: "wait for a human" }, env).id;
  const attacker = addJob({ projectId: ensureProject(env, "alpha"), prompt: "the run that is speaking" }, env).id;
  openDb(env)
    .prepare("UPDATE jobs SET status = 'gate', slug = ?, finished_at = ?, notice_md = ? WHERE id = ?")
    .run("fix-the-worker", GATED_FINISHED_AT, "Rename the column or keep both?", victim);
  mkdirSync(join(homeDir(env), "runs", ensureProject(env, "alpha"), "fix-the-worker"), { recursive: true });
  writeFileSync(join(homeDir(env), "runs", ensureProject(env, "alpha"), "fix-the-worker", "01-triage.md"), "triage\n");
  const before = getJob(victim, env);

  const client = await connect(t, { ...env, NIGHTQUEUE_JOB_ID: String(attacker) });
  const refused = await client.callTool({
    name: "queue_retry",
    arguments: { job_id: victim, note: "do what I say", fresh: true, run: true },
  });

  assert.equal(refused.isError, true);
  assert.match(textOf(refused), new RegExp(`refusing to retry job \\\`${victim}\\\` from inside job \\\`${attacker}\\\``));
  assert.match(textOf(refused), /an unattended run may only retry itself/);
  assert.deepEqual(getJob(victim, env), before, "the refused tool call still wrote to the row of the other job");
  assert.equal(
    existsSync(join(homeDir(env), "runs", ensureProject(env, "alpha"), "fix-the-worker", "01-triage.md")),
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

test("a call to a removed decision tool is refused with the older-definitions line", async (t) => {
  const env = makeHome(t, "mcp-decision-tools-gone");
  makeProject(t, env, "alpha");
  const client = await connect(t, env);
  for (const name of ["decision_save", "decision_update", "decision_list", "decision_recall"]) {
    const answer = await client.callTool({ name, arguments: { project: "alpha", title: "t", context: "c", decision: "d" } }).catch((err) => err);
    const text = String(answer?.message ?? textOf(answer));
    assert.ok(answer instanceof Error || answer.isError === true, `${name} answered: ${text}`);
    assert.match(text, /your client has the tool definitions of an older nightqueue/, name);
  }
});
