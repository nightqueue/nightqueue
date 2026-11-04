import assert from "node:assert/strict";
import { test } from "node:test";
import { OPERATOR_AGENT, OPERATOR_MODE_AGENT, OPERATOR_MODE_FALLBACK, operatorAgentBody, operatorArgs } from "../../src/host/operator.mjs";
import { jobSettings, mergerSettings, operatorSettings } from "../../src/host/settings.mjs";
import { mergerArgs } from "../../src/queue/merger-spawn.mjs";
import { MERGER_MODEL } from "../../src/queue/routing.mjs";
import { buildArgs, mcpConfigArg, pluginDir } from "../../src/queue/spawn.mjs";
import { makeHome } from "../../test-support/memory.mjs";

const SAFE_RESUME = "abc-12345";
const UNSAFE_RESUME = "bad id;rm";

// The fenced tail every job argv carries unless it inherits the user's environment.
function jobFence(env) {
  return ["--strict-mcp-config", "--setting-sources", "project", "--settings", JSON.stringify(jobSettings(env))];
}

// The head every job argv carries, with its MCP config pinned to the job and claim given.
function jobHead(env, { jobId = null, claim = null } = {}) {
  return [
    "-p", "work",
    "--permission-mode", "bypassPermissions",
    "--output-format", "stream-json", "--verbose",
    "--plugin-dir", pluginDir(),
    "--mcp-config", mcpConfigArg(env, jobId, { claim }),
  ];
}

// The operator argv up to its operands, for the loading flags given and the MCP operator identity.
function operatorHead(env, { load, operator = null }) {
  return [
    ...load,
    "--plugin-dir", pluginDir(),
    "--mcp-config", mcpConfigArg(env, null, { operator }),
    "--permission-mode", "default",
    "--setting-sources", "user,project,local",
    "--settings", JSON.stringify(operatorSettings(env)),
  ];
}

test("job argv without a job id is pinned", (t) => {
  const env = makeHome(t, "pin-job-plain");
  assert.deepEqual(buildArgs({ prompt: "work", env }), [...jobHead(env), ...jobFence(env)]);
});

test("job argv with a job id and a claim is pinned", (t) => {
  const env = makeHome(t, "pin-job-claim");
  const claim = { attempt: 1, worker: "w", ordinal: 1 };
  assert.deepEqual(buildArgs({ prompt: "work", env, jobId: 7, claim }), [...jobHead(env, { jobId: 7, claim }), ...jobFence(env)]);
});

test("job argv with a safe resume id ends with --resume", (t) => {
  const env = makeHome(t, "pin-job-resume");
  assert.deepEqual(buildArgs({ prompt: "work", env, resumeSessionId: SAFE_RESUME }), [...jobHead(env), ...jobFence(env), "--resume", SAFE_RESUME]);
});

test("job argv with an unsafe resume id carries no --resume", (t) => {
  const env = makeHome(t, "pin-job-unsafe");
  assert.deepEqual(buildArgs({ prompt: "work", env, resumeSessionId: UNSAFE_RESUME }), [...jobHead(env), ...jobFence(env)]);
});

test("job argv inheriting the user environment drops the fence", (t) => {
  const env = makeHome(t, "pin-job-inherit");
  assert.deepEqual(buildArgs({ prompt: "work", env, inheritUserEnvironment: true }), jobHead(env));
});

test("job argv inheriting the user environment still resumes", (t) => {
  const env = makeHome(t, "pin-job-inherit-resume");
  const args = buildArgs({ prompt: "work", env, inheritUserEnvironment: true, resumeSessionId: SAFE_RESUME });
  assert.deepEqual(args, [...jobHead(env), "--resume", SAFE_RESUME]);
});

test("merger argv is pinned", (t) => {
  const env = makeHome(t, "pin-merger");
  assert.deepEqual(mergerArgs({ prompt: "merge", env }), [
    "-p", "merge",
    "--agent", "nightqueue:merger",
    "--model", MERGER_MODEL,
    "--tools", "Read,Edit",
    "--permission-mode", "acceptEdits",
    "--output-format", "stream-json", "--verbose",
    "--plugin-dir", pluginDir(),
    "--strict-mcp-config",
    "--setting-sources", "project",
    "--settings", JSON.stringify(mergerSettings(env)),
  ]);
});

test("operator argv in agent mode, fresh, opens with the opening prompt", (t) => {
  const env = makeHome(t, "pin-operator-agent");
  assert.deepEqual(operatorArgs({ env, mode: OPERATOR_MODE_AGENT }), [
    ...operatorHead(env, { load: ["--agent", OPERATOR_AGENT] }),
    "The session just opened. Give your opening message.",
  ]);
});

test("operator argv in fallback mode appends the agent body", (t) => {
  const env = makeHome(t, "pin-operator-fallback");
  assert.deepEqual(operatorArgs({ env, mode: OPERATOR_MODE_FALLBACK }), [
    ...operatorHead(env, { load: ["--append-system-prompt", operatorAgentBody()] }),
    "The session just opened. Give your opening message.",
  ]);
});

test("operator argv resumed without a prompt carries no operand", (t) => {
  const env = makeHome(t, "pin-operator-resume");
  assert.deepEqual(operatorArgs({ env, mode: OPERATOR_MODE_AGENT, resumeSession: SAFE_RESUME }), [
    ...operatorHead(env, { load: ["--agent", OPERATOR_AGENT] }),
    "--resume", SAFE_RESUME,
  ]);
});

test("operator argv resumed with a prompt ends with the prompt", (t) => {
  const env = makeHome(t, "pin-operator-resume-prompt");
  assert.deepEqual(operatorArgs({ env, mode: OPERATOR_MODE_AGENT, resumeSession: SAFE_RESUME, prompt: "status?" }), [
    ...operatorHead(env, { load: ["--agent", OPERATOR_AGENT] }),
    "--resume", SAFE_RESUME, "status?",
  ]);
});

test("operator argv with a claude command name as prompt gets a trailing space", (t) => {
  const env = makeHome(t, "pin-operator-command");
  assert.deepEqual(operatorArgs({ env, mode: OPERATOR_MODE_AGENT, prompt: "doctor" }), [
    ...operatorHead(env, { load: ["--agent", OPERATOR_AGENT] }),
    "doctor ",
  ]);
});

test("operator argv with a session pins the session on its MCP server", (t) => {
  const env = makeHome(t, "pin-operator-session");
  const operator = { mode: "operator", session: "sess-1", pid: String(process.pid) };
  const args = operatorArgs({ env, mode: OPERATOR_MODE_AGENT, session: "sess-1" });
  assert.deepEqual(args, [
    ...operatorHead(env, { load: ["--agent", OPERATOR_AGENT], operator }),
    "The session just opened. Give your opening message.",
  ]);
  const server = JSON.parse(args[args.indexOf("--mcp-config") + 1]).mcpServers.nightqueue;
  assert.equal(server.env.NIGHTQUEUE_OPERATOR_SESSION, "sess-1");
});
