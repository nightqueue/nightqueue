import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { jobLogPath, runDir } from "../../src/config/paths.mjs";
import { packageRoot } from "../../src/host/paths.mjs";
import { runAgentForeground } from "../../src/hooks/agent-foreground.mjs";
import { addJob, getJob } from "../../src/memory/jobs.mjs";
import { jobRecalls, LESSONS_HEADING } from "../../src/queue/recalls.mjs";
import { runCycle } from "../../src/queue/runner.mjs";
import { ensureProject, makeDir, makeHome, makeProject } from "../../test-support/memory.mjs";
import { useFakeClaude } from "../../test-support/queue-fake.mjs";
import { fakeJobWorktree } from "../../test-support/job-worktree.mjs";
import { fillBlock, phasePrompts } from "../../test-support/skill-size.mjs";
import { agentToolUseEvent, assistantEvent, noticeText, PR_URL, recordedDone, resultEvent, SESSION_ID, SLUG, slugEvent, systemInitEvent, taskNotificationEvent, toNdjson, toolResultEvent, toolUseEvent } from "../../test-support/streams.mjs";

const WORKTREE = "/tmp/whole-run-worktree";
const CONTEXT_TOOL = "mcp__nightqueue__context_for_agent";
const REMOVED_TOOL = "mcp__nightqueue__phase_prompt";
const PLUGIN_ROOT = join(packageRoot(), "plugin");
const REFERENCES = join(PLUGIN_ROOT, "skills", "resolve", "references");
const MANIFEST = JSON.parse(readFileSync(join(PLUGIN_ROOT, "skills", "resolve", "pipeline", "manifest.json"), "utf8"));
const PLACEHOLDER_RE = /<[^<>]+>/g;

// The lanes of one whole run in phase order: each block, the target of its own context fetch, and the phase that recall lands on.
const LANES = [
  { target: "triager", context: "triager", phase: 1 },
  { target: "explore", context: "explore", phase: 2 },
  { target: "architect", context: "architect", phase: 3 },
  { target: "coder", context: "coder", phase: 4 },
  { target: "qa-triage", context: "qa", phase: 5 },
  { target: "qa-analyst", context: "qa", phase: 5 },
  { target: "qa-prover", context: null, phase: 5 },
  { target: "coder-fix", context: null, phase: 6 },
  { target: "verifier", context: "verifier", phase: 6 },
  { target: "runtime", context: null, phase: 7 },
  { target: "reflector", context: "reflector", phase: 10 },
];
const MODELS = Object.fromEntries(Object.keys(MANIFEST.models).map((role) => [role, `model-${role}`]));
const VALUES = { runDir: null, worktree: WORKTREE, project: "alpha", needsSlug: "false", baseRef: "main", pluginRoot: PLUGIN_ROOT, demoRepo: "none configured", models: MODELS };

// The agent and the model a filled block's first line names.
function launchOf(filled) {
  const [, agent, model] = /AGENT: (\S+) · MODEL: (\S+)$/.exec(filled[0]);
  return { agent, model };
}

// One main-thread tool call and its result.
function orchestratorCall(name, id, input) {
  return [toolUseEvent({ name, id, input }), toolResultEvent({ toolUseId: id })];
}

// One lane of the run: the launch from its filled block, the agent's own context fetch and artifact read, and its return.
function laneEvents({ target, context }, index, { blocks, values }) {
  const filled = fillBlock(blocks[target], values);
  const { agent, model } = launchOf(filled);
  const id = `lane${index}`;
  const artifact = join(values.runDir, "05-qa.md");
  const block = context === "reflector" ? "## Run timeline\n1. triage" : `## ${LESSONS_HEADING}\n- [L${index + 1}] a lesson`;
  const fetch = context === null ? [] : [
    toolUseEvent({ name: CONTEXT_TOOL, id: `ctx${index}`, input: { target: context, repo_root: WORKTREE }, parentToolUseId: id }),
    toolResultEvent({ toolUseId: `ctx${index}`, parentToolUseId: id, content: [{ type: "text", text: JSON.stringify({ block }) }] }),
  ];
  return [
    agentToolUseEvent({ id, subagentType: agent, model, description: target, prompt: filled.join("\n") }),
    ...fetch,
    toolUseEvent({ name: "Read", id: `read${index}`, input: { file_path: artifact }, parentToolUseId: id }),
    toolResultEvent({ toolUseId: `read${index}`, parentToolUseId: id }),
    taskNotificationEvent({ toolUseId: id, durationMs: 1000 }),
    toolResultEvent({ toolUseId: id, content: "VERDICT: DONE · ARTIFACT: x.md · OPEN: 0" }),
  ];
}

// The stream of a whole run: the orchestrator's own commands and references, one launch per lane, Phases 8 and 9 from the facts.
function wholeRunStream(values) {
  const { blocks } = phasePrompts();
  const lanes = LANES.flatMap((lane, index) => laneEvents(lane, index, { blocks, values }));
  return toNdjson([
    systemInitEvent(),
    slugEvent(SLUG),
    ...orchestratorCall("Bash", "b1", { command: "nightqueue run start" }),
    ...orchestratorCall("Bash", "b2", { command: "git status --short" }),
    ...orchestratorCall("Read", "r1", { file_path: join(REFERENCES, "phases.md") }),
    ...lanes,
    ...orchestratorCall("Bash", "b3", { command: "nightqueue run check 06" }),
    ...orchestratorCall("Read", "r2", { file_path: join(REFERENCES, "phase-8.md") }),
    ...orchestratorCall("Bash", "b4", { command: "nightqueue run report --facts" }),
    ...orchestratorCall("Write", "w1", { file_path: join(values.runDir, "pr-body.md"), content: "body" }),
    ...orchestratorCall("Read", "r3", { file_path: join(REFERENCES, "phase-9.md") }),
    ...orchestratorCall("Bash", "b5", { command: "nightqueue run report" }),
    assistantEvent(noticeText()),
    resultEvent({ text: `Done. Pull request: ${PR_URL}` }),
  ]);
}

// A whole-line pattern of one block: its text literal, a placeholder any text, the optional `STAGE:` line optional.
function blockPattern(lines) {
  const parts = lines.map((line) => {
    const literal = line.split(PLACEHOLDER_RE).map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".+");
    return line.startsWith("STAGE:") ? `(?:${literal}\\n)?` : `${literal}\\n`;
  });
  return new RegExp(`^${parts.join("").slice(0, -2)}$`);
}

// The events of a job log, without its attempt markers.
function logEvents(text) {
  return text.split("\n").filter((line) => line.startsWith("{")).map((line) => JSON.parse(line));
}

// The tool calls of the log, each with whether it came from the orchestrator's own thread.
function toolCalls(events) {
  return events.flatMap((event) => {
    if (event.type !== "assistant") return [];
    return event.message.content.filter((block) => block.type === "tool_use").map((block) => ({ ...block, mainThread: !event.parent_tool_use_id }));
  });
}

// A run with its whole stream done by the fake `claude`, and what its log recorded.
async function runWholeRun(t) {
  const env = makeHome(t, "whole-run");
  makeProject(t, env, "alpha");
  const projectId = ensureProject(env, "alpha");
  const values = { ...VALUES, runDir: runDir(projectId, SLUG, env) };
  useFakeClaude(env, makeDir(t, "whole-run-plan"), [{ stdout: wholeRunStream(values), runState: recordedDone(), exitCode: 0 }]);
  const id = addJob({ projectId, prompt: "fix the worker" }, env).id;
  const git = ({ args }) => ({ status: "\n", "rev-parse": "main\n", "symbolic-ref": "origin/main\n" })[args[0]] ?? "\n";
  await runCycle({ jobId: id, env, deps: { worktreeImpl: fakeJobWorktree(), gitImpl: git } });
  const log = readFileSync(jobLogPath(id, env), "utf8");
  return { env, id, log, calls: toolCalls(logEvents(log)), values };
}

test("a whole run launches every lane from one SKILL block, reads no artifact on its main thread and fetches no prompt", async (t) => {
  const { env, id, log, calls, values } = await runWholeRun(t);
  assert.equal(getJob(id, env).status, "done");

  const launches = calls.filter((call) => call.name === "Agent");
  assert.equal(launches.length, LANES.length);
  const patterns = Object.entries(phasePrompts().blocks).map(([target, lines]) => ({ target, pattern: blockPattern(lines), lines }));
  for (const [at, launch] of launches.entries()) {
    const matching = patterns.filter(({ pattern }) => pattern.test(launch.input.prompt));
    assert.deepEqual(matching.map(({ target }) => target), [LANES[at].target], `the launch of ${LANES[at].target} does not match its block alone:\n${launch.input.prompt}`);
    const expected = launchOf(fillBlock(matching[0].lines, values));
    assert.deepEqual([launch.input.subagent_type, launch.input.model], [expected.agent, expected.model]);
  }

  const reads = calls.filter((call) => call.mainThread && ["Read", "Grep", "Glob"].includes(call.name));
  assert.equal(reads.length, 3, "the stream read no reference on its main thread");
  for (const read of reads) assert.equal(read.input.file_path.startsWith(values.runDir), false, `the orchestrator read ${read.input.file_path}`);
  assert.equal(calls.some((call) => call.name === REMOVED_TOOL), false, "a prompt was fetched from the runtime");
  assert.equal(calls.some((call) => call.mainThread && call.name === CONTEXT_TOOL), false, "the orchestrator fetched an agent's context");
  assert.ok(calls.some((call) => !call.mainThread && call.name === "Read"), "the lanes read no artifact, so the stream proves nothing about them");
  assert.ok(log.includes(`"file_path":"${join(values.runDir, "05-qa.md")}"`), "the log lost the lanes' reads");
});

test("every main-thread call of the run passes the real guard, and the artifact read the lanes make is denied to the main thread", async (t) => {
  const { env: home, id, calls, values } = await runWholeRun(t);
  const env = { ...home, NIGHTQUEUE_JOB_ID: String(id), NIGHTQUEUE_PLUGIN_DIR: PLUGIN_ROOT };
  const hookInput = (call, extra = {}) => ({ hook_event_name: "PreToolUse", tool_name: call.name, tool_input: call.input, cwd: WORKTREE, session_id: SESSION_ID, ...extra });

  for (const call of calls.filter((candidate) => candidate.mainThread && ["Read", "Grep", "Glob", "Bash"].includes(candidate.name))) {
    const answer = runAgentForeground({ input: hookInput(call), env });
    assert.equal(answer.includes('"deny"'), false, `${call.name} ${JSON.stringify(call.input)} was denied: ${answer}`);
  }

  const artifactRead = { name: "Read", input: { file_path: join(values.runDir, "05-qa.md") } };
  const denied = runAgentForeground({ input: hookInput(artifactRead), env });
  assert.ok(denied.includes("the orchestrator reads only the pipeline"), `the main thread may read an artifact: ${artifactRead.input.file_path} answered \`${denied}\``);
  assert.equal(runAgentForeground({ input: hookInput(artifactRead, { agent_id: "a1" }), env }), "", "a subagent may not read its artifact");
});

test("the lanes' own context calls land on their phases, the two qa lanes merged on theirs, and the reflector's recalls nothing", async (t) => {
  const { log } = await runWholeRun(t);
  const contexts = (await jobRecalls(log)).filter((recall) => recall.tool === "context_for_agent" && recall.hits.length > 0);
  assert.deepEqual(contexts.map((recall) => [recall.target, recall.phase]), [["triager", 1], ["explore", 2], ["architect", 3], ["coder", 4], ["qa", 5], ["verifier", 6]]);
});
