import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { ghPrStatesSync, ghPrViewResults } from "../../src/host/gh.mjs";
import { isolatedHostVars } from "../../test-support/host.mjs";
import { makeDir } from "../../test-support/memory.mjs";

const BATCH_SCRIPT = fileURLToPath(new URL("../../src/host/gh-pr-batch.mjs", import.meta.url));
const URLS = ["https://github.com/acme/api/pull/7", "https://github.com/acme/api/pull/8"];
const CHILD_HANG_BOUND_MS = 60000;
const UNANSWERED = "gh did not answer within 2 s";

// An environment whose gh is the fake CLI answering OPEN, its argv log path alongside.
function fakeGhEnv(t) {
  const vars = isolatedHostVars(makeDir(t, "gh-pr-batch"));
  const env = { ...process.env, ...vars, NIGHTQUEUE_FAKE_GH_PR_STATE: "OPEN" };
  delete env.NIGHTQUEUE_NO_PR_CHECK;
  return { env, log: vars.NIGHTQUEUE_FAKE_GH_LOG };
}

// Blocks this thread for the given time, the way a slow node boot holds the child before it reads its request.
function blockFor(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Runs the real batch child on one request, bounded only by a hang bound.
function runChild(request, env) {
  return spawnSync(process.execPath, [BATCH_SCRIPT], { input: JSON.stringify(request), encoding: "utf8", env, timeout: CHILD_HANG_BOUND_MS });
}

test("the parent anchors the batch deadline before the spawn and kills the child only after it", () => {
  const calls = [];
  const spawnSyncImpl = (command, args, options) => {
    calls.push({ request: JSON.parse(options.input), timeout: options.timeout });
    return { status: 0, stdout: JSON.stringify(URLS.map(() => ({ ok: false, unfinished: true }))), stderr: "" };
  };
  const before = Date.now();
  ghPrStatesSync(URLS, { env: {}, timeoutMs: 3000, spawnSyncImpl });
  const after = Date.now();
  assert.equal(calls.length, 1);
  const { request, timeout } = calls[0];
  assert.ok(request.deadline >= before + 3000 && request.deadline <= after + 3000, `deadline ${request.deadline} is not anchored at the spawn`);
  assert.equal("timeoutMs" in request, false, "the child was handed a duration it would restart after its own boot");
  assert.equal(timeout, 3500);
});

test("the batch child honors the parent's deadline: past it, it answers unfinished and starts no gh", (t) => {
  const { env, log } = fakeGhEnv(t);
  const result = runChild({ urls: URLS, deadline: Date.now() - 1 }, env);
  assert.equal(result.status, 0, result.stderr);
  const results = JSON.parse(result.stdout);
  assert.equal(results.length, 2);
  for (const answer of results) assert.equal(answer.unfinished, true);
  assert.equal(existsSync(log), false, "the child started gh after the parent's deadline had passed");
});

test("ghPrViewResults past its deadline answers unfinished without spawning gh", async (t) => {
  const { env, log } = fakeGhEnv(t);
  const results = await ghPrViewResults(URLS, { env, deadline: Date.now() - 1 });
  assert.deepEqual(results.map((answer) => answer.unfinished), [true, true]);
  assert.equal(existsSync(log), false, "gh was spawned after the deadline had passed");
});

test("a batch child that boots past the guard's budget starts no gh of its own budget", (t) => {
  const { env, log } = fakeGhEnv(t);
  const timeoutMs = 2000;
  const slowBoot = (command, args, options) => {
    blockFor(timeoutMs + 200);
    return spawnSync(command, args, { ...options, timeout: CHILD_HANG_BOUND_MS });
  };
  const states = ghPrStatesSync(URLS, { env, timeoutMs, spawnSyncImpl: slowBoot });
  for (const url of URLS) assert.deepEqual(states.get(url), { ok: false, why: UNANSWERED });
  assert.equal(existsSync(log), false, "the child restarted the budget after its boot and asked gh past the parent's deadline");
});
