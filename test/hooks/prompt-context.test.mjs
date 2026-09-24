import assert from "node:assert/strict";
import { test } from "node:test";
import { promptBody, runPromptContext } from "../../src/hooks/prompt-context.mjs";
import { nextSeq, recordInjected, seenRefs } from "../../src/hooks/state.mjs";
import { saveLesson } from "../../src/memory/lessons.mjs";
import { saveMemory } from "../../src/memory/memory.mjs";
import { makeDir, makeHome, makeProject } from "../../test-support/memory.mjs";

const LEAK_PROMPT = "the worker leaks a file descriptor when the run fails";

// Stores one lesson of the project, returning its id.
function addLesson(env, { title, prevention = "always close the descriptor in a finally block" }) {
  return saveLesson({ project: "alpha", title, root_cause: `${title} happened`, solution: "fix it", prevention }, env)
    .id;
}

test("a prompt too short to carry a request gets no block", async (t) => {
  const env = makeHome(t, "hook-prompt-short");
  const repo = makeProject(t, env, "alpha");
  addLesson(env, { title: "the worker leaks a file descriptor on failure" });
  assert.equal(await runPromptContext({ input: { session_id: "s1", cwd: repo, prompt: "hi" }, env }), "");
  assert.equal(await runPromptContext({ input: { session_id: "s1", cwd: repo, prompt: "/resolve" }, env }), "");
});

test("a slash command is recalled by its body, not by the command name", async (t) => {
  const env = makeHome(t, "hook-prompt-slash");
  const repo = makeProject(t, env, "alpha");
  const id = addLesson(env, { title: "the worker leaks a file descriptor on failure" });
  assert.equal(promptBody(`/resolve ${LEAK_PROMPT}`), LEAK_PROMPT);

  const block = await runPromptContext({
    input: { session_id: "s1", cwd: repo, prompt: `/resolve ${LEAK_PROMPT}` },
    env,
  });
  assert.match(block, /^## Lessons relevant to this request/);
  assert.match(block, new RegExp(`\\[L${id}\\] always close the descriptor in a finally block`));
});

test("a lesson already injected in the session is not injected again", async (t) => {
  const env = makeHome(t, "hook-prompt-seen");
  const repo = makeProject(t, env, "alpha");
  const seen = addLesson(env, { title: "the worker leaks a file descriptor on failure" });
  const fresh = addLesson(env, {
    title: "the worker leaks a file descriptor when the run fails twice",
    prevention: "close the descriptor before returning early",
  });
  recordInjected("s1", [`l${seen}`], env);

  const block = await runPromptContext({ input: { session_id: "s1", cwd: repo, prompt: LEAK_PROMPT }, env });
  assert.match(block, new RegExp(`\\[L${fresh}\\]`));
  assert.doesNotMatch(block, new RegExp(`\\[L${seen}\\]`));
});

test("after twenty prompts an injected lesson becomes eligible again", async (t) => {
  const env = makeHome(t, "hook-prompt-window");
  const repo = makeProject(t, env, "alpha");
  const id = addLesson(env, { title: "the worker leaks a file descriptor on failure" });

  const first = await runPromptContext({ input: { session_id: "s1", cwd: repo, prompt: LEAK_PROMPT }, env });
  assert.match(first, new RegExp(`\\[L${id}\\]`));
  assert.equal(await runPromptContext({ input: { session_id: "s1", cwd: repo, prompt: LEAK_PROMPT }, env }), "");
  assert.deepEqual([...seenRefs("s1", {}, env)], [`l${id}`]);

  for (let i = 0; i < 20; i += 1) nextSeq("s1", env);
  assert.deepEqual([...seenRefs("s1", {}, env)], []);
  const again = await runPromptContext({ input: { session_id: "s1", cwd: repo, prompt: LEAK_PROMPT }, env });
  assert.match(again, new RegExp(`\\[L${id}\\]`));
});

test("a working directory outside every registered project leaks nothing into the prompt", async (t) => {
  const env = makeHome(t, "hook-prompt-outside");
  makeProject(t, env, "alpha");
  addLesson(env, { title: "the worker leaks a file descriptor on failure" });
  saveMemory({ project: "alpha", key: "descriptor", value: "the worker owns the descriptor pool" }, env);
  saveLesson(
    {
      project: null,
      title: "a global lesson about the fun\u00e7\u00e3o that leaks a file descriptor",
      root_cause: "the early return skipped the close",
      solution: "close it in a finally block",
      prevention: "always close the descriptor in a finally block",
    },
    env,
  );
  const outside = makeDir(t, "hook-prompt-outside-cwd");

  assert.equal(await runPromptContext({ input: { session_id: "s1", cwd: outside, prompt: LEAK_PROMPT }, env }), "");
});

test("the reflection process gets no prompt block", async (t) => {
  const env = { ...makeHome(t, "hook-prompt-reflect"), NIGHTQUEUE_REFLECT: "1" };
  assert.equal(await runPromptContext({ input: { session_id: "s1", prompt: LEAK_PROMPT }, env }), "");
});

test("a block larger than the budget is cut at three thousand characters", async (t) => {
  const env = makeHome(t, "hook-prompt-clip");
  const repo = makeProject(t, env, "alpha");
  for (let i = 0; i < 6; i += 1) {
    addLesson(env, {
      title: `the worker leaks a file descriptor on failure number ${i}`,
      prevention: "always close the descriptor in a finally block ".repeat(20),
    });
  }
  for (let i = 0; i < 4; i += 1) {
    saveMemory(
      {
        project: "alpha",
        key: `the worker owns the descriptor ${"and the pool ".repeat(90)} ${i}`,
        value: `the worker leaks a file descriptor when the run fails ${"in the pool ".repeat(40)}`,
      },
      env,
    );
  }
  const block = await runPromptContext({ input: { session_id: "s1", cwd: repo, prompt: LEAK_PROMPT }, env });
  assert.equal(block.length, 3000);
});
