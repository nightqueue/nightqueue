import assert from "node:assert/strict";
import { existsSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { runSubagentStop } from "../../src/hooks/subagent-stop.mjs";
import { createQaWorktree } from "../../src/queue/qa-worktree.mjs";
import { initGitRepo } from "../../test-support/git.mjs";
import { makeDir, makeHome, registerCheckout } from "../../test-support/memory.mjs";
import { gitVars, registeredWorktrees } from "../../test-support/worktrees.mjs";

const SESSION_PID = "999999";

// A temporary home with one registered checkout, and the env of an operator session of that home.
function stopFixture(t) {
  const env = { ...makeHome(t, "subagent-stop"), ...gitVars() };
  const checkout = realpathSync(initGitRepo(makeDir(t, "subagent-stop-alpha")));
  const row = registerCheckout(env, { path: checkout, name: "alpha" });
  const project = { id: row.id, name: "alpha", path: checkout };
  const session = { ...env, NIGHTQUEUE_MODE: "operator", NIGHTQUEUE_OPERATOR_PID: SESSION_PID };
  return { env, session, checkout, project };
}

// The SubagentStop payload of a subagent, with the given fields over a qa default.
function stopInput(fields) {
  return { hook_event_name: "SubagentStop", agent_type: "nightqueue:qa", ...fields };
}

// One assistant entry of a transcript, as the host writes it.
function assistantEntry(text) {
  return JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } });
}

test("without a final message, the first announcement of the subagent's last assistant entry in its transcript is dropped, an unlocked one included", (t) => {
  const { env, session, checkout, project } = stopFixture(t);
  const earlier = createQaWorktree({ project, env: session });
  const unlocked = createQaWorktree({ project, env });
  const mentioned = createQaWorktree({ project, env: session });
  const transcript = join(makeDir(t, "subagent-stop-transcript"), "agent.jsonl");
  const lines = [
    assistantEntry(`QA_WORKTREE: ${earlier}`),
    JSON.stringify({ type: "user", message: { role: "user", content: `QA_WORKTREE: ${earlier}` } }),
    assistantEntry(`reproduced\nQA_WORKTREE: ${unlocked}\nQA_WORKTREE: ${mentioned}`),
  ];
  writeFileSync(transcript, `${lines.join("\n")}\n`);

  assert.equal(runSubagentStop({ input: stopInput({ agent_transcript_path: transcript }), env: session }), "");

  assert.equal(existsSync(unlocked), false);
  assert.ok(existsSync(earlier));
  assert.ok(existsSync(mentioned));
  assert.equal(registeredWorktrees(checkout).length, 2);
});

test("a final message wins over the transcript, so a sibling the transcript only quotes survives", (t) => {
  const { session, project } = stopFixture(t);
  const own = createQaWorktree({ project, env: session });
  const sibling = createQaWorktree({ project, env: session });
  const transcript = join(makeDir(t, "subagent-stop-transcript"), "agent.jsonl");
  writeFileSync(transcript, `${assistantEntry(`QA_WORKTREE: ${sibling}`)}\n`);

  runSubagentStop({ input: stopInput({ agent_transcript_path: transcript, last_assistant_message: `QA_WORKTREE: ${own}\ndone` }), env: session });

  assert.equal(existsSync(own), false);
  assert.ok(existsSync(sibling));
});

test("an announcement wrapped in backticks or followed by punctuation still drops its worktree", (t) => {
  const { session, project } = stopFixture(t);
  for (const shown of [(path) => `${path}.`, (path) => `${path},`, (path) => `${path})`, (path) => `\`${path}\``, (path) => `${path};`]) {
    const path = createQaWorktree({ project, env: session });
    runSubagentStop({ input: stopInput({ last_assistant_message: `QA_WORKTREE: ${shown(path)}` }), env: session });
    assert.equal(existsSync(path), false, shown(path));
  }
});

test("an announcement that is not the first line of the final message is ignored", (t) => {
  const { session, project } = stopFixture(t);
  const path = createQaWorktree({ project, env: session });

  runSubagentStop({ input: stopInput({ last_assistant_message: `reproduced\nQA_WORKTREE: ${path}` }), env: session });

  assert.ok(existsSync(path));
});

test("nothing is dropped outside an operator session, for another hook event, or for a path that is not a qa worktree", (t) => {
  const { env, session, checkout, project } = stopFixture(t);
  const path = createQaWorktree({ project, env: session });
  const announce = `QA_WORKTREE: ${path}`;

  assert.equal(runSubagentStop({ input: stopInput({ last_assistant_message: announce }), env }), "");
  assert.equal(runSubagentStop({ input: stopInput({ hook_event_name: "Stop", last_assistant_message: announce }), env: session }), "");
  assert.equal(runSubagentStop({ input: stopInput({ agent_type: "general-purpose", last_assistant_message: announce }), env: session }), "");
  assert.equal(runSubagentStop({ input: stopInput({ last_assistant_message: `QA_WORKTREE: ${checkout}` }), env: session }), "");
  assert.equal(runSubagentStop({ input: stopInput({ last_assistant_message: "QA_WORKTREE: /etc" }), env: session }), "");

  assert.ok(existsSync(path));
  assert.ok(existsSync(join(checkout, ".git")));
});

test("junk input never throws and always answers nothing", (t) => {
  const { session } = stopFixture(t);
  for (const input of [null, undefined, "x", 42, {}, stopInput({ last_assistant_message: null, agent_transcript_path: 7 }), stopInput({ agent_transcript_path: "/nonexistent/x.jsonl" })]) {
    assert.equal(runSubagentStop({ input, env: session }), "");
  }
  assert.equal(runSubagentStop({ input: stopInput({}), env: {} }), "");
});
