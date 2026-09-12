import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultContext, run } from "../../src/cli/index.mjs";
import { openDb } from "../../src/memory/db.mjs";
import { addJob, claimJobById, finishJob } from "../../src/memory/jobs.mjs";
import { makeHome, makeProject } from "../../test-support/memory.mjs";

// Runs `queue status --follow` in this process with an injected sleep, so the loop ticks without waiting.
async function runFollow(env, { onTick } = {}) {
  const out = [];
  const err = [];
  const ctx = {
    ...defaultContext(),
    env,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    stdout: { isTTY: false, columns: 120, write: () => {} },
    sleep: async () => {
      await onTick?.();
    },
    killImpl: () => {
      throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
    },
  };
  const code = await run(["queue", "status", "--follow", "--until-idle"], ctx);
  return { code, out, err };
}

test("a follow session keeps the one cached connection alive from the first tick to the last", async (t) => {
  const env = makeHome(t, "follow-keeps-connection");
  makeProject(t, env, "alpha");
  const id = addJob({ project: "alpha", prompt: "fix the worker" }, env).id;
  claimJobById(id, { worker: "host:1", cap: 4 }, env);
  const first = openDb(env);

  let ticks = 0;
  const result = await runFollow(env, {
    onTick: () => {
      ticks += 1;
      assert.equal(openDb(env), first, `the follow reopened the connection on tick ${ticks}`);
      if (ticks === 2) finishJob(id, { worker: "host:1", status: "done", prUrl: "https://github.com/acme/api/pull/7" }, env);
    },
  });

  assert.equal(result.code, 0, result.err.join("\n"));
  assert.ok(ticks >= 2, "the follow stopped before the change it was waiting for");
  assert.equal(openDb(env), first, "the follow left a different cached connection behind");
  assert.equal(first.prepare("SELECT 1 AS one").get().one, 1, "the follow closed the connection another holder of this home was using");
});
