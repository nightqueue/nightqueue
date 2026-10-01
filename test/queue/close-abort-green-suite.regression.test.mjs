import assert from "node:assert/strict";
import { test } from "node:test";
import { openDb } from "../../src/memory/db.mjs";
import { acquireClose, addJob, getJob } from "../../src/memory/jobs.mjs";
import { runClosePipeline } from "../../src/queue/close.mjs";
import { openStore } from "../../src/store/open.mjs";
import { CLOSE_PR_URL, fakeCloseDeps, gitLines, NO_CHECKS, PUSHED_SHA, suiteVerifies } from "../../test-support/close.mjs";
import { ensureProject, makeHome, makeProject } from "../../test-support/memory.mjs";

const WORKER = "close:test:1:aaaa";

// A done job with a pull request whose close lease is held, in a fresh home.
function closeHome(t, name) {
  const env = makeHome(t, name);
  const checkout = makeProject(t, env, "alpha");
  const id = addJob({ projectId: ensureProject(env, "alpha"), prompt: "fix the worker" }, env).id;
  openDb(env).prepare("UPDATE jobs SET status = 'done', pr_url = ?, notice_md = ?, branch = ? WHERE id = ?").run(CLOSE_PR_URL, "A", "fix/worker", id);
  acquireClose(id, { worker: WORKER, leaseS: 660 }, env);
  return { env, checkout, id, store: openStore(env) };
}

// Lets a step the abort orphaned run on until it reaches its push or merge, if it would.
async function drainOrphanedStep() {
  for (let turn = 0; turn < 50; turn += 1) await new Promise((resolve) => setImmediate(resolve));
}

test("a suite that finishes green at the instant of the abort leaves no push and no merge behind the interrupted close", async (t) => {
  const home = closeHome(t, "close-abort-green-suite");
  const controller = new AbortController();
  const fake = suiteVerifies(fakeCloseDeps({ checks: NO_CHECKS }), PUSHED_SHA);
  assert.equal(typeof fake.deps.gh.prMerge, "function");
  fake.deps.runTest = async (options) => {
    fake.log.tests.push(options);
    controller.abort();
    return { ok: true, output: "green", timedOut: false };
  };
  const outcome = await runClosePipeline({ store: home.store, job: getJob(home.id, home.env), worker: WORKER, env: home.env, deps: fake.deps, timeoutS: 600, checkout: home.checkout, signal: controller.signal });
  assert.equal(outcome.reason, "interrupted");
  await drainOrphanedStep();
  assert.equal(fake.log.tests.length, 1);
  assert.equal(fake.log.merges.length, 0, "a merge was issued after the close was interrupted");
  assert.equal(gitLines(fake.log).filter((line) => line.startsWith("push")).length, 0, "a push was issued after the close was interrupted");
  assert.equal(JSON.parse(getJob(home.id, home.env).close).data.verifiedSha, undefined);
});
