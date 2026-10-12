import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { recordInjected } from "../../src/hooks/state.mjs";
import { openDb } from "../../src/memory/db.mjs";
import { addJob, claimJobById, persistRunFacts } from "../../src/memory/jobs.mjs";
import { saveLesson } from "../../src/memory/lessons.mjs";
import { ensureProject, makeHome, makeProject } from "../../test-support/memory.mjs";

const CLI = fileURLToPath(new URL("../../bin/nightqueue.mjs", import.meta.url));
const WORKER = "host:4242";
const TITLE = "renew the worker lease before the tick";

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
  const text = result.content.map((block) => block.text).join("\n");
  assert.notEqual(result.isError, true, text);
  return JSON.parse(text);
}

// The violation counter of one lesson.
function violatedOf(env, id) {
  return openDb(env).prepare("SELECT violated FROM lessons WHERE id = ?").get(id).violated;
}

// A home with `alpha`, one existing lesson, and a claimed job whose session is named; `given` marks the lesson as injected into it.
function makeJobHome(t, name, { given }) {
  const home = makeHome(t, name);
  makeProject(t, home, "alpha");
  const projectId = ensureProject(home, "alpha");
  const lesson = saveLesson({ projectId, title: TITLE, root_cause: "late", solution: "renew", prevention: "renew early" }, home);
  const job = addJob({ projectId, prompt: "renew the lease" }, home);
  claimJobById(job.id, { worker: WORKER, cap: 4 }, home);
  const sessionId = `${name}-session`;
  persistRunFacts(job.id, { worker: WORKER, slug: "renew-lease", sessionId }, home);
  if (given) recordInjected(sessionId, [`l${lesson.id}`], home);
  return { home, lessonId: lesson.id, jobEnv: { ...home, NIGHTQUEUE_JOB_ID: String(job.id) } };
}

// Saves the lesson with the given title through the tool.
async function saveTitled(client, title) {
  return payloadOf(await client.callTool({ name: "lesson_save", arguments: { project: "alpha", title, prevention: "renew early" } }));
}

test("inside a job, re-saving a lesson the run was given answers violated and bumps it exactly once", async (t) => {
  const { home, lessonId, jobEnv } = makeJobHome(t, "lesson-save-violated-given", { given: true });
  const client = await connect(t, jobEnv);

  const saved = await saveTitled(client, TITLE);

  assert.equal(saved.id, lessonId);
  assert.equal(saved.deduped, true);
  assert.equal(saved.violated, true);
  assert.equal(violatedOf(home, lessonId), 1);
});

test("inside a job, a dedup onto a lesson the run was NOT given never counts a violation", async (t) => {
  const { home, lessonId, jobEnv } = makeJobHome(t, "lesson-save-violated-not-given", { given: false });
  const client = await connect(t, jobEnv);

  const saved = await saveTitled(client, TITLE);

  assert.equal(saved.deduped, true);
  assert.equal(saved.violated, false);
  assert.equal(violatedOf(home, lessonId), 0);
});

test("outside a job a recurrence bumps attempts only, never violated", async (t) => {
  const { home, lessonId } = makeJobHome(t, "lesson-save-violated-outside", { given: true });
  const client = await connect(t, home);

  const saved = await saveTitled(client, TITLE);

  assert.equal(saved.deduped, true);
  assert.equal(saved.attempts, 2);
  assert.equal(saved.violated, false);
  assert.equal(violatedOf(home, lessonId), 0);
});

test("a fresh lesson saved inside a job answers violated false", async (t) => {
  const { home, jobEnv } = makeJobHome(t, "lesson-save-violated-fresh", { given: true });
  const client = await connect(t, jobEnv);

  const saved = await saveTitled(client, "close the descriptor on every exit");

  assert.equal(saved.deduped, false);
  assert.equal(saved.violated, false);
  assert.equal(violatedOf(home, saved.id), 0);
});
