import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { test } from "node:test";
import { defaultContext, run } from "../../src/cli/index.mjs";
import { openDb } from "../../src/memory/db.mjs";
import { getDecision, saveDecision } from "../../src/memory/decisions.mjs";
import { addJob, claimJobById, getJob, jobView } from "../../src/memory/jobs.mjs";
import { CLOSE_MERGED_QUERY_LIMIT } from "../../src/queue/close-merged.mjs";
import { createPrStateCache } from "../../src/queue/pr-state.mjs";
import { makeHome, makeProject } from "../../test-support/memory.mjs";
import { fakeCloseDeps, mergedPr, openPr } from "../../test-support/close.mjs";

// A home with the pull request checks switched back on, the default `makeHome` turns off.
function makeCloseHome(t, name) {
  const env = makeHome(t, name);
  makeProject(t, env, "alpha");
  delete env.NIGHTSHIFT_NO_PR_CHECK;
  return env;
}

// Enqueues a job straight in the database, already in the given status with a pull request url.
function terminalJob(env, { status = "done", prUrl, prompt = "fix the worker" } = {}) {
  const id = addJob({ project: "alpha", prompt }, env).id;
  openDb(env).prepare("UPDATE jobs SET status = ?, pr_url = ? WHERE id = ?").run(status, prUrl, id);
  return id;
}

// Runs `nightshift queue close ...` in this process, with the pull request cache, the deadline and the closing pipeline's doubles the test injects.
async function runQueueClose(env, argv, { prStates, closeMergedDeadlineMs, closeDeps = fakeCloseDeps({ pr: mergedPr() }).deps } = {}) {
  const out = [];
  const err = [];
  const ctx = { ...defaultContext(), env, stdin: { isTTY: false }, out: (line) => out.push(line), err: (line) => err.push(line), prStates, closeMergedDeadlineMs, closeDeps };
  const code = await run(argv, ctx);
  return { code, out, err };
}

// A gh double that answers each pull request url from a fixed table, counting how many calls run at once.
function tableView(answers) {
  const calls = [];
  let running = 0;
  let maxRunning = 0;
  return {
    calls,
    maxRunning: () => maxRunning,
    impl: async (url) => {
      calls.push(url);
      running += 1;
      maxRunning = Math.max(maxRunning, running);
      await Promise.resolve();
      running -= 1;
      return answers[url] ?? { ok: false };
    },
  };
}

test("close --merged on a cold cache queries gh, closes the confirmed merges and reports the rest as undetermined with a reason", async (t) => {
  const env = makeCloseHome(t, "close-merged-cold");
  const merged = terminalJob(env, { prUrl: "https://github.com/acme/api/pull/1" });
  const open = terminalJob(env, { prUrl: "https://github.com/acme/api/pull/2" });
  const notGithub = terminalJob(env, { prUrl: "https://gitlab.com/acme/api/merge_requests/3" });
  const view = tableView({
    "https://github.com/acme/api/pull/1": { ok: true, state: "MERGED", mergedAt: "2026-09-11T15:54:01Z" },
    "https://github.com/acme/api/pull/2": { ok: true, state: "OPEN", mergeable: "MERGEABLE", isDraft: false },
  });
  const prStates = createPrStateCache({ viewImpl: view.impl });

  const result = await runQueueClose(env, ["queue", "close", "--merged"], { prStates });

  assert.equal(result.code, 0, result.err.join("\n"));
  assert.ok(result.out.some((line) => line === "checking 2 pull requests on GitHub..."), result.out.join("\n"));
  assert.ok(result.out.includes(`closed job #${merged}`), result.out.join("\n"));
  assert.equal(getJob(merged, env).status, "closed");
  assert.equal(jobView(getJob(merged, env)).close.data.merged, true, "the close did not record the merge through the pipeline");
  assert.ok(result.out.some((line) => line === `job #${open} not closed: pull request is open`), result.out.join("\n"));
  assert.ok(result.out.some((line) => line === `job #${notGithub} not closed: no GitHub pull request url`), result.out.join("\n"));
});

test("close --merged --json answers one parseable document, and the checking line never reaches stdout", async (t) => {
  const env = makeCloseHome(t, "close-merged-json");
  const merged = terminalJob(env, { prUrl: "https://github.com/acme/api/pull/1" });
  const view = tableView({ "https://github.com/acme/api/pull/1": { ok: true, state: "MERGED", mergedAt: "2026-09-11T15:54:01Z" } });
  const prStates = createPrStateCache({ viewImpl: view.impl });

  const result = await runQueueClose(env, ["queue", "close", "--merged", "--json"], { prStates });

  assert.equal(result.code, 0, result.err.join("\n"));
  assert.equal(result.out.length, 1, `stdout carried more than one line:\n${result.out.join("\n")}`);
  assert.ok(!result.out[0].includes("checking"), "the checking line reached stdout under --json");
  const payload = JSON.parse(result.out[0]);
  assert.deepEqual(payload.closed.map((job) => job.id), [merged]);
});

test("an injected gh that never answers, with a small deadline, closes nothing, exits successfully and names every id as undetermined", async (t) => {
  const env = makeCloseHome(t, "close-merged-hang");
  const first = terminalJob(env, { prUrl: "https://github.com/acme/api/pull/1" });
  const second = terminalJob(env, { prUrl: "https://github.com/acme/api/pull/2" });
  const prStates = createPrStateCache({ viewImpl: () => new Promise(() => {}) });

  const result = await runQueueClose(env, ["queue", "close", "--merged"], { prStates, closeMergedDeadlineMs: 50 });

  assert.equal(result.code, 0, result.err.join("\n"));
  for (const id of [first, second]) {
    assert.ok(result.out.some((line) => line === `job #${id} not closed: gh did not confirm its state`), result.out.join("\n"));
  }
});

test("no more than four gh reads run at once, and no more than ten pull requests are queried per call", async (t) => {
  const env = makeCloseHome(t, "close-merged-concurrency");
  const count = CLOSE_MERGED_QUERY_LIMIT + 3;
  const ids = Array.from({ length: count }, (_, index) =>
    terminalJob(env, { prUrl: `https://github.com/acme/api/pull/${index + 1}`, prompt: `job ${index + 1}` }),
  );
  const answers = Object.fromEntries(
    ids.map((_, index) => [`https://github.com/acme/api/pull/${index + 1}`, { ok: true, state: "MERGED", mergedAt: "2026-09-11T15:54:01Z" }]),
  );
  const view = tableView(answers);
  const prStates = createPrStateCache({ viewImpl: view.impl });

  const result = await runQueueClose(env, ["queue", "close", "--merged", "--json"], { prStates });

  assert.equal(result.code, 0, result.err.join("\n"));
  assert.ok(view.maxRunning() <= 4, `${view.maxRunning()} gh reads ran at once`);
  assert.equal(view.calls.length, CLOSE_MERGED_QUERY_LIMIT, "more pull requests were queried than the limit of this call");
  const payload = JSON.parse(result.out[0]);
  assert.equal(payload.closed.length, CLOSE_MERGED_QUERY_LIMIT);
  assert.equal(payload.undetermined.length, count - CLOSE_MERGED_QUERY_LIMIT);
  for (const entry of payload.undetermined) assert.match(entry.reason, /not checked: over the limit of 10 per call/);
});

test("a candidate already cached as merged is closed with zero gh calls", async (t) => {
  const env = makeCloseHome(t, "close-merged-warm-cache");
  const prUrl = "https://github.com/acme/api/pull/1";
  const merged = terminalJob(env, { prUrl });
  const view = tableView({ [prUrl]: { ok: true, state: "MERGED", mergedAt: "2026-09-11T15:54:01Z" } });
  const prStates = createPrStateCache({ viewImpl: view.impl });
  await prStates.refresh([prUrl], { ...env, NIGHTSHIFT_NO_PR_CHECK: undefined });
  view.calls.length = 0;

  const result = await runQueueClose(env, ["queue", "close", "--merged"], { prStates });

  assert.equal(result.code, 0, result.err.join("\n"));
  assert.ok(result.out.includes(`closed job #${merged}`), result.out.join("\n"));
  assert.equal(view.calls.length, 0, "a warm cache still asked gh");
  assert.equal(result.out.some((line) => line.startsWith("checking")), false, "a warm cache still printed a checking line");
});

test("a running job with a merged pull request is never closed", async (t) => {
  const env = makeCloseHome(t, "close-merged-running");
  const prUrl = "https://github.com/acme/api/pull/1";
  const id = addJob({ project: "alpha", prompt: "keep running" }, env).id;
  openDb(env).prepare("UPDATE jobs SET pr_url = ? WHERE id = ?").run(prUrl, id);
  claimJobById(id, { worker: "host:1", cap: 4 }, env);
  const prStates = createPrStateCache({ viewImpl: async () => ({ ok: true, state: "MERGED", mergedAt: "2026-09-11T15:54:01Z" }) });
  await prStates.refresh([prUrl], { ...env, NIGHTSHIFT_NO_PR_CHECK: undefined });

  const result = await runQueueClose(env, ["queue", "close", "--merged"], { prStates });

  assert.equal(result.code, 0, result.err.join("\n"));
  assert.equal(result.out.some((line) => line.includes(`#${id}`)), false, `a running job was reported:\n${result.out.join("\n")}`);
  assert.deepEqual(result.out, ["nothing to close"]);
});

// A decision the given job proposed, stamped straight in the database.
function proposal(env, { jobId, title }) {
  const saved = saveDecision({ project: "alpha", title, context: "why", decision: "what", status: "proposed" }, env);
  openDb(env).prepare("UPDATE decisions SET job_id = ? WHERE id = ?").run(jobId, saved.id);
  return saved;
}

// A pull request cache that already knows the url as merged, so the close asks gh nothing.
async function mergedCache(env, prUrl) {
  const prStates = createPrStateCache({ viewImpl: async () => ({ ok: true, state: "MERGED", mergedAt: "2026-09-11T15:54:01Z" }) });
  await prStates.refresh([prUrl], { ...env, NIGHTSHIFT_NO_PR_CHECK: undefined });
  return prStates;
}

test("close --merged --decisions accept settles the proposals of every job it closed", async (t) => {
  const env = makeCloseHome(t, "close-merged-decisions-accept");
  const prUrl = "https://github.com/acme/api/pull/1";
  const merged = terminalJob(env, { prUrl });
  const first = proposal(env, { jobId: merged, title: "leases are renewed by their owner" });

  const result = await runQueueClose(env, ["queue", "close", "--merged", "--decisions", "accept"], { prStates: await mergedCache(env, prUrl) });

  assert.equal(result.code, 0, result.err.join("\n"));
  assert.equal(getDecision(first.id, env).status, "accepted");
  assert.deepEqual(result.out, [`closed job #${merged}`, `decision #${first.number} leases are renewed by their owner: accepted`]);
});

test("close --merged without the flag keeps the proposals, and --merged --json carries them in one parseable line", async (t) => {
  const env = makeCloseHome(t, "close-merged-decisions-keep");
  const prUrl = "https://github.com/acme/api/pull/1";
  const text = terminalJob(env, { prUrl });
  const kept = proposal(env, { jobId: text, title: "leases are renewed by their owner" });

  const textResult = await runQueueClose(env, ["queue", "close", "--merged"], { prStates: await mergedCache(env, prUrl) });
  assert.equal(textResult.code, 0, textResult.err.join("\n"));
  assert.deepEqual(textResult.out, [`closed job #${text}`, `decision #${kept.number} leases are renewed by their owner: kept (proposed)`]);
  assert.equal(getDecision(kept.id, env).status, "proposed");

  const json = terminalJob(env, { prUrl, prompt: "second" });
  const flipped = proposal(env, { jobId: json, title: "runners register in one table" });
  const jsonResult = await runQueueClose(env, ["queue", "close", "--merged", "--json", "--decisions", "reject"], { prStates: await mergedCache(env, prUrl) });
  assert.equal(jsonResult.code, 0, jsonResult.err.join("\n"));
  assert.equal(jsonResult.out.length, 1, jsonResult.out.join("\n"));
  const payload = JSON.parse(jsonResult.out[0]);
  assert.deepEqual(payload.decisions.map((entry) => [entry.job_id, entry.number, entry.action]), [[json, flipped.number, "rejected"]]);
  assert.equal(getDecision(flipped.id, env).status, "rejected");
});

test("close --merged with an invalid --decisions closes nothing", async (t) => {
  const env = makeCloseHome(t, "close-merged-decisions-invalid");
  const prUrl = "https://github.com/acme/api/pull/1";
  const merged = terminalJob(env, { prUrl });

  const result = await runQueueClose(env, ["queue", "close", "--merged", "--decisions", "all"], { prStates: await mergedCache(env, prUrl) });

  assert.equal(result.code, 1);
  assert.match(result.err.join("\n"), /expected one of accept\|reject\|keep/);
  assert.equal(getJob(merged, env).status, "done");
});

test("`--merged` cannot be combined with ids", async (t) => {
  const env = makeCloseHome(t, "close-merged-usage");
  const id = terminalJob(env, { prUrl: "https://github.com/acme/api/pull/1" });

  const result = await runQueueClose(env, ["queue", "close", "--merged", String(id)]);

  assert.equal(result.code, 1);
  assert.match(result.err.join("\n"), /unexpected argument/);
});

test("close --merged runs only over done jobs: a failed, gated or cancelled job with a merged pull request is never a candidate", async (t) => {
  const env = makeCloseHome(t, "close-merged-done-only");
  const prUrl = "https://github.com/acme/api/pull/1";
  const others = ["failed", "gate", "cancelled"].map((status) => terminalJob(env, { status, prUrl, prompt: status }));
  const before = others.map((id) => getJob(id, env));

  const result = await runQueueClose(env, ["queue", "close", "--merged"], { prStates: await mergedCache(env, prUrl) });

  assert.equal(result.code, 0, result.err.join("\n"));
  assert.deepEqual(result.out, ["nothing to close"]);
  assert.deepEqual(others.map((id) => getJob(id, env)), before, "a job that is not done was touched");
});

test("close --merged reports a candidate whose pipeline stops as not closed, naming the step and the reason, and leaves it done", async (t) => {
  const env = makeCloseHome(t, "close-merged-stopped");
  const prUrl = "https://github.com/acme/api/pull/1";
  const id = terminalJob(env, { prUrl });

  const closeDeps = fakeCloseDeps({ pr: { ok: false, error: "offline" } }).deps;
  const result = await runQueueClose(env, ["queue", "close", "--merged"], { prStates: await mergedCache(env, prUrl), closeDeps });

  assert.equal(result.code, 0, result.err.join("\n"));
  assert.deepEqual(result.out, [`job #${id} not closed: preflight: pr-unreadable`]);
  assert.equal(getJob(id, env).status, "done");
  assert.equal(getJob(id, env).close_status, "failed");
});

test("close --merged cancels a candidate whose pull request gh reads closed without merge, and reports it not closed", async (t) => {
  const env = makeCloseHome(t, "close-merged-pr-closed");
  const prUrl = "https://github.com/acme/api/pull/1";
  const id = terminalJob(env, { prUrl });

  const closeDeps = fakeCloseDeps({ pr: openPr({ state: "CLOSED" }) }).deps;
  const result = await runQueueClose(env, ["queue", "close", "--merged"], { prStates: await mergedCache(env, prUrl), closeDeps });

  assert.equal(result.code, 0, result.err.join("\n"));
  assert.deepEqual(result.out, [`job #${id} not closed: preflight: pr-closed`]);
  assert.equal(getJob(id, env).status, "cancelled");
  assert.equal(getJob(id, env).close_status, null);
});

test("close --merged refuses a candidate whose project checkout is gone, by name, and closes nothing", async (t) => {
  const env = makeHome(t, "close-merged-no-checkout");
  const checkout = makeProject(t, env, "alpha");
  delete env.NIGHTSHIFT_NO_PR_CHECK;
  const prUrl = "https://github.com/acme/api/pull/1";
  const id = terminalJob(env, { prUrl });
  rmSync(checkout, { recursive: true, force: true });

  const result = await runQueueClose(env, ["queue", "close", "--merged"], { prStates: await mergedCache(env, prUrl) });

  assert.equal(result.code, 0, result.err.join("\n"));
  assert.equal(result.out.length, 1, result.out.join("\n"));
  assert.match(result.out[0], new RegExp(`^job #${id} not closed: the checkout of project \`alpha\` is missing`));
  assert.equal(getJob(id, env).status, "done");
});
