import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultContext, run } from "../../src/cli/index.mjs";
import { getJob } from "../../src/memory/jobs.mjs";
import { addJob, claimJobById, finishJob } from "../../src/memory/jobs.mjs";
import { makeHome, makeProject } from "../../test-support/memory.mjs";

// [R1] ("same-tick merge render"): the follow's own write store (via `sweepMerged`) marks a delivered job
// merged inside the SAME tick that renders the queue view. Does that tick's own read of `store.jobs.listJobs`
// - on the fresh read-only connection opened for that tick - already see the row it (indirectly) just wrote,
// or does it lag one tick behind its own write? The plan's [R1] recipe: stub `gh pr view` to answer MERGED for
// a `done` job with a `pr_url`, run one `queue status --follow --until-idle` tick, and read the FIRST rendered
// snapshot, not a database row queried after the fact.

const PR_URL = "https://github.com/acme/api/pull/42";
const MERGE_SHA = "d3605a5a4d7aaec342d649135cdbd128a042e29d";

// Runs `queue status --follow --until-idle` in this process with an injected sleep, exactly the entry point an operator watches.
async function runFollow(env, onTick, spawnSyncImpl) {
  const out = [];
  const err = [];
  const ctx = {
    ...defaultContext(),
    env,
    spawnSyncImpl,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    stdout: { isTTY: false, columns: 200, write: () => {} },
    sleep: async () => await onTick(),
    killImpl: () => {
      throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
    },
  };
  const code = await run(["queue", "status", "--follow", "--until-idle"], ctx);
  return { code, out, err };
}

// The snapshots a piped follow printed, one entry per redraw: on a pipe each one is closed by an empty line.
function snapshots(out) {
  const groups = [];
  let current = [];
  for (const line of out) {
    if (line !== "") {
      current.push(line);
      continue;
    }
    groups.push(current.join("\n"));
    current = [];
  }
  if (current.length) groups.push(current.join("\n"));
  return groups;
}

// A fake `gh pr view` that always answers the given pull request is merged, the way `withFakeGh` in
// `test/queue/cli.test.mjs` stubs a real `gh` binary, but here directly through the `spawnSyncImpl` seam
// `prViewer(ctx.env, ctx.spawnSyncImpl)` already takes.
function fakeGhSpawnSync(bin, args) {
  assert.equal(args[0], "pr", `unexpected gh subcommand invoked: ${args.join(" ")}`);
  assert.equal(args[1], "view", `unexpected gh subcommand invoked: ${args.join(" ")}`);
  return {
    status: 0,
    stdout: JSON.stringify({ state: "MERGED", mergedAt: "2026-01-01T00:00:00Z", mergeCommit: { oid: MERGE_SHA } }),
    stderr: "",
  };
}

test("a job merged by the follow's own write store mid-tick renders merged in that same tick's snapshot", async (t) => {
  const env = makeHome(t, "follow-same-tick-merge");
  delete env.NIGHTSHIFT_NO_PR_CHECK;
  makeProject(t, env, "alpha");
  const id = addJob({ project: "alpha", prompt: "fix the worker" }, env).id;
  claimJobById(id, { worker: "host:1", cap: 4 }, env);
  finishJob(id, { worker: "host:1", status: "done", prUrl: PR_URL }, env);

  assert.equal(getJob(id, env).status, "done", "setup did not leave the job delivered before the follow started");

  let ticks = 0;
  const result = await runFollow(
    env,
    () => {
      ticks += 1;
    },
    fakeGhSpawnSync,
  );

  assert.equal(result.code, 0, result.err.join("\n"));

  const after = getJob(id, env);
  assert.equal(after.status, "merged", "the setup never reached the merge write itself: the tick's own sweep did not flip the row - a `done` reading afterward would be vacuous, not proof of a lag");
  assert.equal(after.merge_sha, MERGE_SHA);

  const views = snapshots(result.out);
  assert.ok(views.length >= 1, "the follow never rendered the queue at all");
  const first = views[0];
  assert.match(
    first,
    new RegExp(`#${id}\\s+\\S+ merged`),
    `the follow's own write store merged job #${id} inside this tick, but the same tick's first rendered snapshot still shows it as \`done\` (a one-tick lag between the follow's own write and its own read):\n${first}`,
  );
  assert.match(first, /merged=1/, `the first snapshot's counts line does not count the job as merged yet: ${first}`);
  assert.match(first, /done=0/, `the first snapshot's counts line still counts the job as done: ${first}`);
});
