import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { jobWorktreePath } from "../../src/config/paths.mjs";
import { addJob, getJob } from "../../src/memory/jobs.mjs";
import { nightqueueMcpUnreachable } from "../../src/queue/classify.mjs";
import { runCycle } from "../../src/queue/runner.mjs";
import { initGitRepo } from "../../test-support/git.mjs";
import { ensureProject, makeDir, makeHome, registerCheckout } from "../../test-support/memory.mjs";
import { useFakeClaude } from "../../test-support/queue-fake.mjs";
import { attemptMarker, doneStream, failureStream, SLUG, systemInitEvent, toNdjson, toolResultEvent, toolUseEvent } from "../../test-support/streams.mjs";

const CLI = fileURLToPath(new URL("../../bin/nightqueue.mjs", import.meta.url));

// Git configuration that reads nothing of the machine's own ignore rules, so only each repository decides what is ignored.
const ISOLATED_GIT_VARS = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: "core.excludesFile",
  GIT_CONFIG_VALUE_0: "/dev/null",
};

// Runs real git in the isolated configuration, in the shape the runner's preflight takes.
function isolatedGit({ args, cwd }) {
  return execFileSync("git", args, { cwd, env: { ...process.env, ...ISOLATED_GIT_VARS }, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
}

// An init event listing the nightqueue MCP server with the given status.
function initWithNightqueue(status) {
  return { ...systemInitEvent(), mcp_servers: [{ name: "nightqueue", status }] };
}

// A nightqueue tool call and the result it got.
function nightqueueCall(id, content, isError = false) {
  return [toolUseEvent({ name: "mcp__nightqueue__lesson_recall", id }), toolResultEvent({ toolUseId: id, content, isError })];
}

// A home with one real clean repository and one pending job on it, the fake claude playing `stdout`.
function realRepoJob(t, name, stdout, exitCode) {
  const env = { ...makeHome(t, name), ...ISOLATED_GIT_VARS };
  const repo = initGitRepo(makeDir(t, `${name}-repo`));
  registerCheckout(env, { path: repo, name: "alpha" });
  useFakeClaude(env, makeDir(t, `${name}-plan`), [{ stdout, exitCode }]);
  const projectId = ensureProject(env, "alpha");
  const id = addJob({ projectId, prompt: "fix the worker", slug: SLUG }, env).id;
  return { env, projectId, id, attemptsBefore: getJob(id, env).attempts };
}

// Runs one cycle on the job with real git and the real worktree step.
async function runOnce(home) {
  const cycle = await runCycle({ jobId: home.id, env: home.env, deps: { gitImpl: isolatedGit, sleepImpl: async () => {} } });
  return cycle.processed[0];
}

// Asserts the job sits at the store-unavailable gate with its attempt given back, the hint and the noteless retry in its notice, and its worktree kept.
function assertStoreUnavailableGate(home, report) {
  assert.deepEqual({ status: report.status, code: report.code }, { status: "gated", code: "store-unavailable" }, JSON.stringify(report));
  const row = getJob(home.id, home.env);
  assert.deepEqual({ status: row.status, blocked: row.blocked_code, attempts: row.attempts }, { status: "gate", blocked: "store-unavailable", attempts: home.attemptsBefore });
  assert.match(row.notice_md, /^store-unavailable: the session could not reach the nightqueue MCP server \("Connection closed"\); no attempt was spent\. Run nightqueue doctor --fix/);
  assert.match(row.notice_md, new RegExp(`nightqueue queue retry J-${home.id} \\(no note needed\\)`));
  assert.ok(existsSync(jobWorktreePath(home.projectId, SLUG, home.env)), "the gate removed the worktree");
}

test("an init listing nightqueue as failed gates the job as store-unavailable with its attempt given back, and a noteless retry moves it", async (t) => {
  const home = realRepoJob(t, "closed-init-failed", toNdjson([initWithNightqueue("failed")]) + failureStream(), 1);

  assertStoreUnavailableGate(home, await runOnce(home));

  const retried = spawnSync(process.execPath, [CLI, "queue", "retry", `J-${home.id}`], { env: home.env, encoding: "utf8" });
  assert.equal(retried.status, 0, retried.stderr);
  assert.equal(getJob(home.id, home.env).status, "pending");
});

test("a first nightqueue call answered \"Connection closed\" alone gates the job the same way", async (t) => {
  const events = [systemInitEvent(), ...nightqueueCall("toolu_nq", "MCP error -32000: Connection closed", true)];
  const home = realRepoJob(t, "closed-first-call", toNdjson(events) + failureStream(), 1);

  assertStoreUnavailableGate(home, await runOnce(home));
});

test("a pending nightqueue server that then answers a call is not blocked", async (t) => {
  const events = [initWithNightqueue("pending"), ...nightqueueCall("toolu_nq", "{\"ok\":true}")];
  const home = realRepoJob(t, "closed-pending-then-ok", toNdjson(events) + doneStream(), 0);

  const report = await runOnce(home);

  assert.equal(report.status, "done", JSON.stringify(report));
  assert.equal(getJob(home.id, home.env).blocked_code, null);
});

test("a \"Connection closed\" after a successful nightqueue call is classified as today", async (t) => {
  const events = [systemInitEvent(), ...nightqueueCall("toolu_ok", "{\"ok\":true}"), ...nightqueueCall("toolu_closed", "Connection closed", true)];
  const home = realRepoJob(t, "closed-mid-run", toNdjson(events) + failureStream(), 1);

  const report = await runOnce(home);

  assert.equal(report.status, "failed", JSON.stringify(report));
  assert.equal(getJob(home.id, home.env).blocked_code, null);
});

test("nightqueueMcpUnreachable reads only the last attempt and never throws", () => {
  const failedInit = toNdjson([initWithNightqueue("failed")]);
  const closedFirst = toNdjson([systemInitEvent(), ...nightqueueCall("toolu_a", [{ type: "text", text: "Connection closed" }], true)]);

  assert.equal(nightqueueMcpUnreachable(failedInit), true);
  assert.equal(nightqueueMcpUnreachable(closedFirst), true, "a content list of text blocks was not read");
  assert.equal(nightqueueMcpUnreachable(toNdjson([initWithNightqueue("pending")])), false);
  assert.equal(nightqueueMcpUnreachable(toNdjson([systemInitEvent(), ...nightqueueCall("toolu_b", "Connection closed", true).slice(1)])), false, "a result with no nightqueue call counted");
  assert.equal(nightqueueMcpUnreachable(`${attemptMarker(1)}\n${failedInit}${attemptMarker(2)}\n${doneStream()}`), false, "an older attempt spoke for the last one");
  for (const garbage of [null, undefined, "", "{", "not json at all", 42]) assert.equal(nightqueueMcpUnreachable(garbage), false);
});

const GATE_NOTICE_LINE =
  'store-unavailable: the session could not reach the nightqueue MCP server ("Connection closed"); no attempt was spent. Run nightqueue doctor --fix';
const QUOTING_RECALL = '{"ok":true,"lessons":[{"body":"the client reported \\"Connection closed\\" once, then recovered"}]}';

// The detector's answer for a session whose first nightqueue call got the given result.
function unreachableAfter(content, isError) {
  return nightqueueMcpUnreachable(toNdjson([systemInitEvent(), ...nightqueueCall("toolu_q", content, isError)]));
}

test("a first nightqueue result that only quotes \"Connection closed\" is never an unreachable server", () => {
  assert.equal(unreachableAfter(QUOTING_RECALL, false), false, "an ok recall quoting the phrase counted");
  assert.equal(unreachableAfter([{ type: "text", text: QUOTING_RECALL }], false), false, "an ok block list quoting the phrase counted");
  assert.equal(unreachableAfter(GATE_NOTICE_LINE, false), false, "the gate notice this runtime writes counted");
  assert.equal(unreachableAfter("Connection closed", false), false, "a result that is not an error counted");
  assert.equal(unreachableAfter("the server said Connection closed before answering", true), false, "an error that only quotes the phrase counted");
});

test("the exact client error stays an unreachable server, in every shape it is reported", () => {
  assert.equal(unreachableAfter("MCP error -32000: Connection closed", true), true);
  assert.equal(unreachableAfter("Connection closed", true), true);
  assert.equal(unreachableAfter([{ type: "text", text: "Connection closed" }], true), true);
  assert.equal(unreachableAfter(" Error: MCP error -32000: Connection closed.\n", true), true);
});

test("a healthy job whose first nightqueue result quotes \"Connection closed\" finishes done with its attempt spent", async (t) => {
  const events = [systemInitEvent(), ...nightqueueCall("toolu_quote", QUOTING_RECALL)];
  const home = realRepoJob(t, "closed-quoted-ok", toNdjson(events) + doneStream(), 0);

  const report = await runOnce(home);

  assert.equal(report.status, "done", JSON.stringify(report));
  const row = getJob(home.id, home.env);
  assert.deepEqual({ status: row.status, blocked: row.blocked_code, attempts: row.attempts }, { status: "done", blocked: null, attempts: 1 });
});
