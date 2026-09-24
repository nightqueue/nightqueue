import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";
import { dbPath, stateDir } from "../../src/config/paths.mjs";
import { runSessionStart } from "../../src/hooks/session-start.mjs";
import { sessionStatePath } from "../../src/hooks/state.mjs";
import { saveDecision } from "../../src/memory/decisions.mjs";
import { getLesson, saveLesson } from "../../src/memory/lessons.mjs";
import { saveMemory } from "../../src/memory/memory.mjs";
import { makeDir, makeHome, makeProject } from "../../test-support/memory.mjs";

// Stores one lesson of the project, returning its id.
function addLesson(env, { project = "alpha", title, prevention = "always close the descriptor in a finally block" }) {
  return saveLesson({ project, title, root_cause: `${title} happened`, solution: "fix it", prevention }, env).id;
}

// Stores one accepted decision of the project, the only status the recall brings back.
function addDecision(env, { project = "alpha", title, decision }) {
  return saveDecision({ project, title, context: `${title} had to be settled`, decision, status: "accepted" }, env);
}

// Lines of one section of the block, from its heading to the next blank line.
function sectionLines(block, heading) {
  const lines = block.split("\n");
  const start = lines.indexOf(`## ${heading}`);
  if (start < 0) return [];
  const end = lines.indexOf("", start);
  return lines.slice(start + 1, end < 0 ? lines.length : end);
}

// Parsed session state file of a session.
function readState(sessionId, env) {
  return JSON.parse(readFileSync(sessionStatePath(sessionId, env), "utf8"));
}

test("the session block lists the lessons and the memory of the project", async (t) => {
  const env = makeHome(t, "hook-start-block");
  const repo = makeProject(t, env, "alpha");
  const id = addLesson(env, { title: "the worker leaks a file descriptor on failure" });
  saveMemory({ project: "alpha", key: "deploy", value: "the deployment runs from the pipeline" }, env);

  const block = await runSessionStart({ input: { session_id: "s1", cwd: repo }, env });
  assert.match(block, /^# Nightqueue context/);
  assert.match(block, new RegExp(`\\[L${id}\\] the worker leaks a file descriptor on failure`));
  assert.match(block, /## Project memory \(alpha\)/);
  assert.match(block, /- deploy: the deployment runs from the pipeline/);
  assert.match(block, /Call `lesson_save` as soon as an error costs a second attempt/);
});

test("the session block registers what it injected, in the state and in the corpus", async (t) => {
  const env = makeHome(t, "hook-start-state");
  const repo = makeProject(t, env, "alpha");
  const id = addLesson(env, { title: "the worker leaks a file descriptor on failure" });

  await runSessionStart({ input: { session_id: "s1", cwd: repo }, env });
  const state = readState("s1", env);
  assert.equal(state.session_id, "s1");
  assert.deepEqual(state.injected, [{ ref: `l${id}`, seq: 0 }]);
  const lesson = getLesson(id, env);
  assert.equal(lesson.injected, 1);
  assert.ok(lesson.last_injected_at);
});

test("a home with nothing to say produces no block at all", async (t) => {
  const env = makeHome(t, "hook-start-empty");
  const repo = makeProject(t, env, "alpha");
  assert.equal(await runSessionStart({ input: { session_id: "s1", cwd: repo }, env }), "");
  assert.equal(existsSync(sessionStatePath("s1", env)), false);
});

test("the reflection process gets no context block and never opens the database", async (t) => {
  const env = { ...makeHome(t, "hook-start-reflect"), NIGHTQUEUE_REFLECT: "1" };
  assert.equal(await runSessionStart({ input: { session_id: "s1", cwd: process.cwd() }, env }), "");
  assert.equal(existsSync(dbPath(env)), false);
});

test("a corpus larger than the budget is cut at nine thousand characters", async (t) => {
  const env = makeHome(t, "hook-start-clip");
  const repo = makeProject(t, env, "alpha");
  for (let i = 0; i < 12; i += 1) {
    addLesson(env, { title: `lesson number ${i}`, prevention: "always close the descriptor ".repeat(80) });
  }
  const block = await runSessionStart({ input: { session_id: "s1", cwd: repo }, env });
  assert.equal(block.length, 9000);
});

test("the session block opens with the standing decisions of the project", async (t) => {
  const env = makeHome(t, "hook-start-decisions");
  const repo = makeProject(t, env, "alpha");
  addLesson(env, { title: "the worker leaks a file descriptor on failure" });
  const accepted = addDecision(env, { title: "state.json is written by the runtime", decision: "only run-state.mjs writes it" });
  const proposed = saveDecision(
    { project: "alpha", title: "the queue runs on postgres", context: "still open", decision: "nothing settled yet" },
    env,
  );

  const block = await runSessionStart({ input: { session_id: "s1", cwd: repo }, env });
  assert.match(block, /## Standing decisions/);
  assert.match(block, new RegExp(`- #${accepted.number} state.json is written by the runtime: only run-state.mjs writes it`));
  const binding = [...sectionLines(block, "Standing decisions"), ...sectionLines(block, "Standing decisions in detail")];
  assert.equal(
    binding.some((line) => line.includes("the queue runs on postgres")),
    false,
    "a decision that is only proposed is not a standing constraint",
  );
  assert.deepEqual(sectionLines(block, "Proposed (not binding)"), [`- #${proposed.number} the queue runs on postgres`]);
  assert.equal(block.includes("nothing settled yet"), false, "a proposal is listed by title only");
  assert.ok(
    block.indexOf("## Standing decisions in detail") < block.indexOf("## Proposed (not binding)"),
    "the proposals come after the standing decisions",
  );
  assert.ok(
    block.indexOf("## Standing decisions") < block.indexOf("## Lessons learned"),
    "the standing constraints come before the lessons",
  );
});

test("a large corpus keeps the standing decisions and the lessons inside the budget", async (t) => {
  const env = makeHome(t, "hook-start-budget");
  const repo = makeProject(t, env, "alpha");
  for (let i = 0; i < 8; i += 1) {
    addDecision(env, { title: `decision number ${i}`, decision: `never do it like that ${"again and again ".repeat(40)}` });
  }
  for (let i = 0; i < 12; i += 1) {
    addLesson(env, { title: `lesson number ${i}`, prevention: `always close the descriptor ${"in a finally block ".repeat(40)}` });
  }
  for (let i = 0; i < 10; i += 1) {
    saveMemory({ project: "alpha", key: `memory-${i}`, value: `the deployment runs from the pipeline ${i}` }, env);
  }

  const block = await runSessionStart({ input: { session_id: "s1", cwd: repo }, env });
  assert.ok(block.length <= 9000, `the block is ${block.length} characters long`);
  assert.match(block, /## Standing decisions\n/);
  assert.match(block, /## Standing decisions in detail/);
  assert.match(
    block,
    /\[L\d+\]/,
    "the `## Standing decisions` titles and the `## Standing decisions in detail` section pushed every lesson out of the budget",
  );
});

test("thirty accepted decisions inject thirty title lines and eight detail lines", async (t) => {
  const env = makeHome(t, "hook-start-all-titles");
  const repo = makeProject(t, env, "alpha");
  for (let i = 0; i < 30; i += 1) {
    addDecision(env, { title: `rule ${i}`, decision: `keep rule ${i}` });
  }

  const block = await runSessionStart({ input: { session_id: "s1", cwd: repo }, env });
  const titles = sectionLines(block, "Standing decisions");
  const detail = sectionLines(block, "Standing decisions in detail");
  assert.equal(titles.filter((line) => /^- #\d+ /.test(line)).length, 30, block);
  assert.equal(titles.length, 30, block);
  assert.equal(detail.filter((line) => /^- #\d+ /.test(line)).length, 8, block);
  assert.equal(detail.length, 8, block);
  assert.equal(titles[0], "- #1 rule 0", "the titles come in numbering order");
  assert.equal(block.includes("## Proposed (not binding)"), false, "an empty proposed section was printed");
});

test("titles beyond their budget end with how many were left out, and the lessons stay", async (t) => {
  const env = makeHome(t, "hook-start-title-overflow");
  const repo = makeProject(t, env, "alpha");
  for (let i = 0; i < 60; i += 1) {
    addDecision(env, { title: `rule ${i} ${"about the queue runner lease ".repeat(6)}`, decision: `keep rule ${i}` });
  }
  addLesson(env, { title: "the worker leaks a file descriptor on failure" });

  const block = await runSessionStart({ input: { session_id: "s1", cwd: repo }, env });
  const titles = sectionLines(block, "Standing decisions");
  const listed = titles.filter((line) => /^- #\d+ /.test(line)).length;
  const leftOut = 60 - listed;
  assert.ok(leftOut > 0 && listed > 0, block);
  assert.equal(titles.at(-1), `- ${leftOut} more title(s) left out; \`decision_list\` has them all.`);
  assert.equal(titles.length, listed + 1);
  assert.match(block, /\[L\d+\] the worker leaks a file descriptor on failure/);
  assert.ok(block.length <= 9000, `the block is ${block.length} characters long`);
});

test("a working directory outside every registered project leaks nothing into the session", async (t) => {
  const env = makeHome(t, "hook-start-outside");
  makeProject(t, env, "alpha");
  addLesson(env, { title: "the alpha worker leaks a file descriptor on failure" });
  saveMemory({ project: "alpha", key: "deploy", value: "the deployment runs from the pipeline" }, env);
  saveLesson(
    {
      project: null,
      title: "a global lesson about the fun\u00e7\u00e3o that never closes",
      root_cause: "the early return skipped the close",
      solution: "close it in a finally block",
      prevention: "always close the descriptor in a finally block",
    },
    env,
  );
  const outside = makeDir(t, "hook-start-outside-cwd");

  assert.equal(await runSessionStart({ input: { session_id: "s1", cwd: outside }, env }), "");
  assert.equal(existsSync(sessionStatePath("s1", env)), false);
});

test("a hostile session id cannot write outside the state directory", async (t) => {
  const env = makeHome(t, "hook-start-hostile");
  const repo = makeProject(t, env, "alpha");
  addLesson(env, { title: "the worker leaks a file descriptor on failure" });

  await runSessionStart({ input: { session_id: "../../evil", cwd: repo }, env });
  assert.deepEqual(readdirSync(stateDir(env)), [".._.._evil.json"]);
  assert.equal(readState("../../evil", env).session_id, ".._.._evil");
});
