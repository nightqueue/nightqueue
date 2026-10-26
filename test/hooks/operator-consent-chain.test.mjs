import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { newId } from "../../src/config/ids.mjs";
import { operatorConsentPath, operatorLogPath } from "../../src/config/paths.mjs";
import { runAgentForeground } from "../../src/hooks/agent-foreground.mjs";
import { makeHome, makeProject } from "../../test-support/memory.mjs";

const CLI = fileURLToPath(new URL("../../bin/nightqueue.mjs", import.meta.url));

// Connects a real stdio client to `nightqueue mcp`, closed at the end of the test.
async function connect(t, env) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [CLI, "mcp"], env, stderr: "pipe" });
  const client = new Client({ name: "nightqueue-consent-chain", version: "0.0.0" });
  await client.connect(transport);
  t.after(() => client.close());
  return client;
}

// Plain text of a tool result.
function textOf(result) {
  return result.content.map((block) => block.text).join("\n");
}

// The PreToolUse payload of a Write, from the main thread or from a subagent when one is named.
function writeCall(file, agentType = null) {
  const call = { hook_event_name: "PreToolUse", session_id: "s-1", cwd: "/", tool_name: "Write", tool_input: { file_path: file, content: "x" } };
  return agentType ? { ...call, agent_id: "a1", agent_type: agentType } : call;
}

// The permission decision of a hook answer: "" for none, else the decision the host reads.
function decisionOf(answer) {
  return answer === "" ? "" : JSON.parse(answer).hookSpecificOutput.permissionDecision;
}

test("operator_consent over MCP writes the record under the home, and the hook then lets exactly that write through, main thread and coder alike", async (t) => {
  const home = makeHome(t, "consent-chain");
  const checkout = makeProject(t, home, "alpha");
  for (const dir of ["src", "test"]) mkdirSync(join(checkout, dir), { recursive: true });
  for (const file of ["src/a.mjs", "test/a.mjs"]) writeFileSync(join(checkout, file), "x\n");
  const session = newId();
  const env = { ...home, NIGHTQUEUE_MODE: "operator", NIGHTQUEUE_OPERATOR_SESSION: session };

  for (const agentType of [null, "nightqueue:coder"]) {
    assert.equal(decisionOf(runAgentForeground({ input: writeCall(join(checkout, "src", "a.mjs"), agentType), env })), "deny");
  }

  const client = await connect(t, env);
  const result = await client.callTool({
    name: "operator_consent",
    arguments: { project: "alpha", kind: "edit", scope: join(checkout, "src"), reason: "fix the parser", answer: "yes, edit src" },
  });
  assert.notEqual(result.isError, true, textOf(result));
  const answer = JSON.parse(textOf(result));
  assert.equal(answer.ok, true);
  assert.equal(answer.consent.answer, "yes, edit src");
  assert.ok(existsSync(operatorConsentPath(session, env)), "the consent record is not under the home");
  assert.match(readFileSync(operatorLogPath(session, env), "utf8"), /consent edit .*src · alpha · "yes, edit src"/);

  for (const agentType of [null, "nightqueue:coder"]) {
    assert.equal(runAgentForeground({ input: writeCall(join(checkout, "src", "a.mjs"), agentType), env }), "", `${agentType ?? "main"} src/a.mjs`);
    const denied = JSON.parse(runAgentForeground({ input: writeCall(join(checkout, "test", "a.mjs"), agentType), env }));
    assert.match(denied.hookSpecificOutput.permissionDecisionReason, /^operator guard: needs consent \(edit /);
  }
});

test("operator_consent is refused inside a queue job and on a server that serves no operator session", async (t) => {
  const home = makeHome(t, "consent-chain-refused");
  const checkout = makeProject(t, home, "alpha");
  const args = { project: "alpha", kind: "edit", scope: checkout, reason: "r", answer: "yes" };
  const inJob = await connect(t, { ...home, NIGHTQUEUE_OPERATOR_SESSION: newId(), NIGHTQUEUE_JOB_ID: "7" });
  const job = await inJob.callTool({ name: "operator_consent", arguments: args });
  assert.equal(job.isError, true);
  assert.match(textOf(job), /inside job `7`/);
  const plain = await connect(t, home);
  const none = await plain.callTool({ name: "operator_consent", arguments: args });
  assert.equal(none.isError, true);
  assert.match(textOf(none), /only a `nightqueue open` session records a consent/);
});
