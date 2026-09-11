import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultContext, run } from "../../src/cli/index.mjs";
import { addJob, claimJobById, finishJob } from "../../src/memory/jobs.mjs";
import { makeHome, makeProject } from "../../test-support/memory.mjs";

// Runs `queue status` in this process with an injected sleep, so the follow loop ticks without waiting.
async function runStatus(env, argv, { onTick } = {}) {
  const out = [];
  const err = [];
  let ticks = 0;
  const ctx = {
    ...defaultContext(),
    env,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    stdout: { isTTY: false, columns: 120, write: () => {} },
    sleep: async () => {
      ticks += 1;
      await onTick?.(ticks);
    },
    killImpl: () => {
      throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
    },
  };
  const code = await run(argv, ctx);
  return { code, out, err, ticks };
}

test("queue status --follow --until-idle redraws on change and stops by itself once nothing runs or waits", async (t) => {
  const env = makeHome(t, "status-follow");
  makeProject(t, env, "alpha");
  const id = addJob({ project: "alpha", prompt: "fix the worker" }, env).id;
  claimJobById(id, { worker: "host:1", cap: 4 }, env);

  const result = await runStatus(env, ["queue", "status", "--follow", "--until-idle"], {
    onTick: (tick) => {
      if (tick === 2) finishJob(id, { worker: "host:1", status: "done", prUrl: "https://github.com/acme/api/pull/7" }, env);
    },
  });

  assert.equal(result.code, 0, result.err.join("\n"));
  const snapshots = result.out.join("\n").split("\n\n").filter((block) => block.trim());
  assert.equal(snapshots.length, 2, `expected one snapshot per change, got ${snapshots.length}:\n${result.out.join("\n")}`);
  assert.match(snapshots[0], /^runner: 1 running job under a one-shot runner - no watcher registered.*\nID\s+STATUS.*\n─+\n#1\s+● running\s+\d+s\s+-\s+alpha/);
  assert.match(snapshots[1], /#1\s+✓ done\s+\d+s\s+-\s+alpha\s+-\s+https:\/\/github\.com\/acme\/api\/pull\/7$/m);
  assert.ok(result.ticks >= 2, "the loop stopped before the change it was waiting for");
  assert.equal(result.out.some((line) => /is available/.test(line)), false, "the follow printed the update notice");
});

test("queue status --follow refuses --json and a single job id", async (t) => {
  const env = makeHome(t, "status-follow-refusals");
  const json = await runStatus(env, ["queue", "status", "--follow", "--json"]);
  assert.equal(json.code, 1);
  assert.match(json.err.join("\n"), /`--follow` cannot be used with `--json`/);
  const one = await runStatus(env, ["queue", "status", "1", "--follow"]);
  assert.equal(one.code, 1);
  assert.match(one.err.join("\n"), /`--follow` shows the whole queue/);
});
