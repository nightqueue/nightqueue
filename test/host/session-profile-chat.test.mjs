import assert from "node:assert/strict";
import { test } from "node:test";
import { SESSION_PROFILES, profileArgs } from "../../src/host/session-profile.mjs";

const BASE = { pluginDir: "/p", mcpConfig: "{}", settings: { hooks: {} } };

test("a chat with no agent carries neither --agent nor --append-system-prompt, and its defaults are the host's", () => {
  const argv = profileArgs({ kind: "chat", ...BASE, sessionId: "u-1" });
  assert.deepEqual(argv, [
    "--plugin-dir", "/p", "--mcp-config", "{}", "--permission-mode", "default", "--setting-sources", "user,project,local",
    "--settings", JSON.stringify({ hooks: {} }), "--session-id", "u-1",
  ]);
  assert.equal(argv.includes("--strict-mcp-config"), false);
  assert.equal(argv.includes("-p"), false);
});

test("a built-in agent goes as --agent, a user one also carries --agents before it", () => {
  const builtin = profileArgs({ kind: "chat", ...BASE, agent: "nightqueue:coder", sessionId: "u-1" });
  assert.deepEqual(builtin.slice(0, 2), ["--agent", "nightqueue:coder"]);
  assert.equal(builtin.includes("--agents"), false);
  const user = profileArgs({ kind: "chat", ...BASE, agents: '{"rev":{}}', agent: "rev", sessionId: "u-1" });
  assert.deepEqual(user.slice(0, 4), ["--agents", '{"rev":{}}', "--agent", "rev"]);
});

test("a fresh chat fixes --session-id, a resumed one passes --resume, and the prompt operand comes last", () => {
  const fresh = profileArgs({ kind: "chat", ...BASE, sessionId: "u-1", operand: "hello" });
  assert.deepEqual(fresh.slice(-3), ["--session-id", "u-1", "hello"]);
  const resumed = profileArgs({ kind: "chat", ...BASE, resume: "u-1", operand: "again" });
  assert.deepEqual(resumed.slice(-3), ["--resume", "u-1", "again"]);
  assert.equal(resumed.includes("--session-id"), false);
});

test("job, merger and operator keep their order, chat is appended after them", () => {
  assert.deepEqual(Object.keys(SESSION_PROFILES), ["job", "merger", "operator", "chat"]);
  assert.deepEqual(SESSION_PROFILES.operator.order, ["agent", "pluginDir", "mcpConfig", "permissionMode", "settingSources", "settings", "resume", "operand"]);
  assert.equal(SESSION_PROFILES.job.order.includes("sessionId"), false);
  assert.equal(SESSION_PROFILES.merger.order.includes("agents"), false);
});
