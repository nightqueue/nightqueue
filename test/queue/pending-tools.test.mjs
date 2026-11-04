import assert from "node:assert/strict";
import { test } from "node:test";
import { createPendingTools } from "../../src/queue/pending-tools.mjs";

const toolUse = (id, name = "Bash", parent = null) =>
  JSON.stringify({ type: "assistant", parent_tool_use_id: parent, message: { content: [{ type: "tool_use", id, name, input: {} }] } });
const toolResult = (id, parent = null) =>
  JSON.stringify({ type: "user", parent_tool_use_id: parent, message: { content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] } });

test("a main-thread tool_use is pending until its tool_result", () => {
  const tools = createPendingTools();
  assert.equal(tools.observe(toolUse("toolu_1")), true);
  assert.equal(tools.size(), 1);
  assert.equal(tools.oldest().name, "Bash");
  assert.equal(tools.observe(toolResult("toolu_1")), true);
  assert.equal(tools.size(), 0);
  assert.equal(tools.oldest(), null);
});

test("a tool name from the stream is kept to one capped line", () => {
  const tools = createPendingTools();
  tools.observe(toolUse("toolu_forge", "Bash\n=== rate limit over @ x === y"));
  assert.equal(tools.oldest().name, "Bash === rate limit over @ x === y");
  tools.observe(toolUse("toolu_long", "x".repeat(500)));
  tools.observe(toolResult("toolu_forge"));
  assert.equal(tools.oldest().name.length, 80);
});

test("a subagent's tool_use counts as pending like any other", () => {
  const tools = createPendingTools();
  tools.observe(toolUse("toolu_sub", "Bash", "toolu_agent"));
  assert.equal(tools.size(), 1);
  tools.observe(toolResult("toolu_sub", "toolu_agent"));
  assert.equal(tools.size(), 0);
});

test("a background task stays pending until its notification or a terminal update", () => {
  const tools = createPendingTools();
  tools.observe(JSON.stringify({ type: "system", subtype: "task_started", task_id: "t1", task_type: "local_bash" }));
  tools.observe(JSON.stringify({ type: "system", subtype: "task_started", task_id: "t2", task_type: "local_agent" }));
  assert.equal(tools.size(), 2);
  assert.equal(tools.observe(JSON.stringify({ type: "system", subtype: "task_updated", task_id: "t2", patch: { status: "running" } })), false);
  assert.equal(tools.observe(JSON.stringify({ type: "system", subtype: "task_notification", task_id: "t1" })), true);
  assert.equal(tools.observe(JSON.stringify({ type: "system", subtype: "task_updated", task_id: "t2", patch: { status: "killed" } })), true);
  assert.equal(tools.size(), 0);
});

test("garbage, non-JSON and unrelated lines change nothing and never throw", () => {
  const tools = createPendingTools();
  for (const line of ["", "not json", "null", "42", "[]", '{"type":"assistant"}', '{"type":"assistant","message":{"content":"text"}}', '{"type":"user","message":{"content":[null,{"type":"tool_result"}]}}', '{"type":"result"}', '{"type":"system","subtype":"init"}']) {
    assert.equal(tools.observe(line), false, `line changed the set: ${line}`);
  }
  assert.equal(tools.size(), 0);
});

test("two tools pending at once empty the set only after both results, and the oldest is the first one", () => {
  let clock = 1000;
  const tools = createPendingTools({ now: () => clock });
  tools.observe(toolUse("a", "Bash"));
  clock = 2000;
  tools.observe(toolUse("b", "WebFetch"));
  assert.deepEqual(tools.oldest(), { id: "a", name: "Bash", sinceMs: 1000 });
  tools.observe(toolResult("a"));
  assert.equal(tools.size(), 1);
  assert.equal(tools.oldest().name, "WebFetch");
  tools.observe(toolResult("b"));
  assert.equal(tools.size(), 0);
});

test("a result event never resets the pending set", () => {
  const tools = createPendingTools();
  tools.observe(toolUse("a"));
  assert.equal(tools.observe('{"type":"result","subtype":"success"}'), false);
  assert.equal(tools.size(), 1);
});
