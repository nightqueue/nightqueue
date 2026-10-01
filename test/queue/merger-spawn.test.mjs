import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { basename } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { mergerSettings } from "../../src/host/settings.mjs";
import { mergerArgs, mergerEnv, mergerLogPath, runMerger } from "../../src/queue/merger-spawn.mjs";
import { makeHome } from "../../test-support/memory.mjs";

// A child shaped like a spawned claude that prints the given stream lines and closes with the given code, or never closes when asked to hang.
function fakeChild({ lines = [], code = 0, hang = false } = {}) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kills = [];
  child.kill = (signal) => {
    child.kills.push(signal);
    if (!hang) return;
    child.stdout.end();
    child.stderr.end();
    process.nextTick(() => child.emit("close", null));
  };
  if (!hang) {
    process.nextTick(() => {
      child.stdout.end(lines.map((line) => `${line}\n`).join(""));
      child.stderr.end();
      child.emit("close", code);
    });
  }
  return child;
}

test("the merger argv carries the agent, sonnet, Read and Edit only and the guard settings, never an MCP server nor bypassPermissions", () => {
  const args = mergerArgs({ prompt: "resolve it", env: { NIGHTQUEUE_HOME: "/h" } });
  const flag = (name) => args[args.indexOf(name) + 1];
  assert.equal(args[0], "-p");
  assert.equal(args[1], "resolve it");
  assert.equal(flag("--agent"), "nightqueue:merger");
  assert.equal(flag("--model"), "sonnet");
  assert.equal(flag("--tools"), "Read,Edit");
  assert.equal(flag("--permission-mode"), "acceptEdits");
  assert.equal(flag("--setting-sources"), "project");
  assert.ok(args.includes("--strict-mcp-config"));
  assert.equal(args.includes("--mcp-config"), false, "the merger got an MCP server");
  assert.equal(args.includes("bypassPermissions"), false, "the merger bypasses permissions");
  assert.equal(args.includes("--resume"), false);
  assert.deepEqual(JSON.parse(flag("--settings")), mergerSettings({ NIGHTQUEUE_HOME: "/h" }));
});

test("the merger settings hold only the merger-guard PreToolUse hook, so no memory hook runs in its session", () => {
  const settings = mergerSettings({ NIGHTQUEUE_HOME: "/h" });
  assert.deepEqual(Object.keys(settings.hooks), ["PreToolUse"]);
  assert.equal(settings.hooks.PreToolUse.length, 1);
  const [hook] = settings.hooks.PreToolUse[0].hooks;
  assert.equal(settings.hooks.PreToolUse[0].hooks.length, 1);
  assert.match(hook.command, / hook merger-guard$/);
  assert.equal(settings.claudeMdExcludes.length, 1);
});

test("the merger env carries the fence as absolute paths and never the job id nor the close lease token", () => {
  const env = mergerEnv({ env: { PATH: "/bin", NIGHTQUEUE_JOB_ID: "3", NIGHTQUEUE_CLOSE_WORKER: "close:x" }, dir: "/tmp/w", files: ["src/a.mjs", "docs/b.md"] });
  assert.equal(env.PATH, "/bin");
  assert.equal(env.NIGHTQUEUE_MERGER_DIR, "/tmp/w");
  assert.deepEqual(JSON.parse(env.NIGHTQUEUE_MERGER_FILES), ["/tmp/w/src/a.mjs", "/tmp/w/docs/b.md"]);
  assert.equal("NIGHTQUEUE_JOB_ID" in env, false, "the job id leaked into the merger");
  assert.equal("NIGHTQUEUE_CLOSE_WORKER" in env, false, "the lease token leaked into the merger");
});

test("the merger log is never named like a job log", (t) => {
  const env = makeHome(t, "merger-log");
  const name = basename(mergerLogPath(env, 3));
  assert.match(name, /^merger-3-\d{8}T\d{6}Z\.log$/);
  assert.doesNotMatch(name, /^job-(\d+)\.log$/);
});

test("runMerger spawns the merger argv in the stopped worktree and answers the final text of the run", async (t) => {
  const env = { ...makeHome(t, "merger-run"), NIGHTQUEUE_JOB_ID: "3" };
  const spawned = [];
  const spawnImpl = (bin, args, options) => {
    spawned.push({ args, options });
    return fakeChild({ lines: [JSON.stringify({ type: "result", result: "done\nRESOLVED" })] });
  };
  const run = await runMerger({ cwd: "/tmp/w", files: ["a.mjs"], prompt: "p", timeoutMs: 120000, signal: new AbortController().signal, jobId: 3, env, spawnImpl });
  assert.deepEqual(run, { exitCode: 0, timedOut: false, stopped: false, spawnError: null, resultText: "done\nRESOLVED" });
  assert.equal(spawned[0].options.cwd, "/tmp/w");
  assert.equal(spawned[0].args[spawned[0].args.indexOf("--agent") + 1], "nightqueue:merger");
  assert.equal(spawned[0].options.env.NIGHTQUEUE_JOB_ID, undefined);
  assert.deepEqual(JSON.parse(spawned[0].options.env.NIGHTQUEUE_MERGER_FILES), ["/tmp/w/a.mjs"]);
});

test("an aborted close stops the merger child within the stop poll", async (t) => {
  const env = makeHome(t, "merger-stop");
  const controller = new AbortController();
  let child = null;
  const spawnImpl = () => {
    child = fakeChild({ hang: true });
    return child;
  };
  const started = Date.now();
  setTimeout(() => controller.abort(), 50);
  const run = await runMerger({ cwd: "/tmp/w", files: ["a.mjs"], prompt: "p", timeoutMs: 600000, signal: controller.signal, jobId: 3, env, spawnImpl });
  assert.equal(run.stopped, true);
  assert.deepEqual(child.kills, ["SIGTERM"]);
  assert.ok(Date.now() - started < 3000, "the merger outlived the abort");
  assert.equal(run.resultText, "");
});
