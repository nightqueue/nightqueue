import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { runDir } from "../../src/config/paths.mjs";
import { openDb } from "../../src/memory/db.mjs";
import { recordPhaseDone, recordRunFields } from "../../src/queue/run-state.mjs";
import { ensureProject, makeHome, makeProject, projectIdOf } from "../../test-support/memory.mjs";

const CLI = fileURLToPath(new URL("../../bin/nightqueue.mjs", import.meta.url));
const SLUG = "hunt-the-notice";
const PROMPT = "## Brief\nqueue status shows the same notice twice\n\n## Stages\n1) fix it\n";

// A temp home whose HOME and CLAUDE_CONFIG_DIR are temp too, with the project `alpha` and an operator run recorded into it.
function makeOperatorRun(t, name, { fields = { origin: "operator", type: "bug/error", evidenceLevel: 3 } } = {}) {
  const base = makeHome(t, name);
  const env = { ...base, HOME: dirname(base.NIGHTQUEUE_HOME), CLAUDE_CONFIG_DIR: join(dirname(base.NIGHTQUEUE_HOME), ".claude") };
  makeProject(t, env, "alpha");
  recordRunFields({ projectId: ensureProject(env, "alpha"), slug: SLUG, fields, env });
  recordPhaseDone({ projectId: ensureProject(env, "alpha"), slug: SLUG, phase: "triage", artifact: "01-triage.md", verdict: "PROCEED", env });
  return env;
}

// Connects a real stdio client to `nightqueue mcp`, closed at the end of the test.
async function connect(t, env) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [CLI, "mcp"], env, stderr: "pipe" });
  const client = new Client({ name: "nightqueue-tests", version: "0.0.0" });
  await client.connect(transport);
  t.after(() => client.close());
  return client;
}

// Plain text of a tool result.
function textOf(result) {
  return result.content.map((block) => block.text).join("\n");
}

// Calls queue_add for `alpha` with the given arguments.
function queueAdd(client, args) {
  return client.callTool({ name: "queue_add", arguments: { project: "alpha", prompt: PROMPT, ...args } });
}

// Every job row, oldest first.
function jobRows(env) {
  return openDb(env).prepare("SELECT id, slug, prompt FROM jobs ORDER BY id").all();
}

// Asserts that a tool call was refused with a message matching the pattern.
function assertRefused(result, pattern) {
  assert.equal(result.isError, true, textOf(result));
  assert.match(textOf(result), pattern);
}

test("a job queued from an operator run is bound to its slug and carries the prior-run block right after its Brief", async (t) => {
  const env = makeOperatorRun(t, "queue-add-run-dir-ok");
  const client = await connect(t, env);
  const dir = runDir(ensureProject(env, "alpha"), SLUG, env);

  const result = await queueAdd(client, { run_dir: dir });
  assert.notEqual(result.isError, true, textOf(result));

  const [row] = jobRows(env);
  assert.equal(row.slug, SLUG);
  const block = ["## PRIOR RUN (operator)", `RUN_DIR: ${dir}`, "Last completed phase: triage", "Evidence level: 3", "Resume from phase: explore"].join("\n");
  assert.ok(row.prompt.includes(`## Brief\nqueue status shows the same notice twice\n\n${block}\n\n## Stages\n`), row.prompt);
});

test("a `~/` run_dir is expanded against the caller's HOME", async (t) => {
  const env = makeOperatorRun(t, "queue-add-run-dir-tilde");
  const client = await connect(t, env);
  const result = await queueAdd(client, { run_dir: `~/home/runs/${projectIdOf(env, "alpha")}/${SLUG}` });
  assert.notEqual(result.isError, true, textOf(result));
  assert.equal(jobRows(env)[0].slug, SLUG);
});

test("queue_add with run_dir refuses a hand-written block, a prompt with no Brief, a foreign path, a run that is not the operator's and a run already bound", async (t) => {
  const env = makeOperatorRun(t, "queue-add-run-dir-refusals");
  recordRunFields({ projectId: ensureProject(env, "alpha"), slug: "plain-run", fields: { type: "bug/error" }, env });
  const client = await connect(t, env);
  const dir = runDir(ensureProject(env, "alpha"), SLUG, env);

  assertRefused(await queueAdd(client, { run_dir: dir, prompt: `${PROMPT}\n## PRIOR RUN (operator)\nRUN_DIR: x\n` }), /already carries a `## PRIOR RUN \(operator\)` block/);
  assertRefused(await queueAdd(client, { run_dir: dir, prompt: "fix the notice" }), /needs its `## Brief` section/);
  assertRefused(await queueAdd(client, { run_dir: join(dirname(env.NIGHTQUEUE_HOME), "elsewhere", SLUG) }), new RegExp(`\`run_dir\` must be \`.*runs/${projectIdOf(env, "alpha")}/hunt-the-notice\``));
  assertRefused(await queueAdd(client, { run_dir: join(env.NIGHTQUEUE_HOME, "runs", "alpha", SLUG) }), /`run_dir` must be `/);
  assertRefused(await queueAdd(client, { run_dir: runDir(ensureProject(env, "alpha"), "plain-run", env) }), /is not an operator run/);
  assertRefused(await queueAdd(client, { run_dir: "runs/alpha/x" }), /must be an absolute or `~\/` path/);
  assert.deepEqual(jobRows(env), [], "a refused call queued a job");

  const first = await queueAdd(client, { run_dir: dir });
  assert.notEqual(first.isError, true, textOf(first));
  assertRefused(await queueAdd(client, { run_dir: dir }), /job #\d+ already runs from /);
  assert.equal(jobRows(env).length, 1);
});

// Writes a state.json by hand into the run directory of `alpha`, the shape an older runtime left behind.
function writeLegacyState(env, slug, state) {
  const dir = runDir(projectIdOf(env, "alpha"), slug, env);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "state.json"), JSON.stringify(state));
  return dir;
}

test("an operator state.json written before project ids (a name, no `projectId`) still seeds a job; one stamped with another project's id is refused", async (t) => {
  const env = makeOperatorRun(t, "queue-add-run-dir-pre-v18");
  const phases = [{ phase: "triage", artifact: "01-triage.md", verdict: "PROCEED" }];
  const legacy = writeLegacyState(env, "legacy-run", { schemaVersion: 1, project: "alpha", slug: "legacy-run", resumeCount: 0, origin: "operator", type: "bug/error", evidenceLevel: 3, phases });
  const foreign = writeLegacyState(env, "foreign-run", { schemaVersion: 1, projectId: ensureProject(env, "beta"), slug: "foreign-run", resumeCount: 0, origin: "operator", type: "bug/error", evidenceLevel: 3, phases });
  const client = await connect(t, env);

  assertRefused(await queueAdd(client, { run_dir: foreign }), /is not an operator run/);
  const seeded = await queueAdd(client, { run_dir: legacy });
  assert.notEqual(seeded.isError, true, textOf(seeded));
  assert.deepEqual(jobRows(env).map((row) => row.slug), ["legacy-run"]);
  assert.ok(jobRows(env)[0].prompt.includes(`RUN_DIR: ${legacy}`), jobRows(env)[0].prompt);
});
