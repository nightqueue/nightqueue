import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { ghPrViewAsync } from "../../src/host/gh.mjs";
import { createPrStateCache, flattenPrState, PR_REFRESH_CONCURRENCY, PR_STATES, prStateKey } from "../../src/queue/pr-state.mjs";
import { isolatedHostVars } from "../../test-support/host.mjs";
import { makeDir, makeHome } from "../../test-support/memory.mjs";

const PR = "https://github.com/acme/api/pull/42";
const MERGE_SHA = "d3605a5a4d7aaec342d649135cdbd128a042e29d";
const PR_FIELDS = "state,mergedAt,mergeCommit,mergeable,isDraft";
const TEN_YEARS_MS = 10 * 365 * 24 * 3600 * 1000;

// A successful answer of gh for an open pull request, with the fields a test overrides.
function openView(fields = {}) {
  return { ok: true, state: "OPEN", mergedAt: null, mergeSha: null, mergeable: "MERGEABLE", isDraft: false, ...fields };
}

// A gh double that answers every read the same way and records the URL and the options of each call.
function fakeView(answer) {
  const calls = [];
  const impl = async (url, options) => {
    calls.push({ url, options });
    return typeof answer === "function" ? answer(url, options) : answer;
  };
  impl.calls = calls;
  return impl;
}

// A clock the test moves by hand.
function manualClock(start = 1_000_000) {
  const clock = { at: start, now: () => clock.at };
  return clock;
}

// A cache over a gh double and a manual clock, the environment every test of the cache shares.
function makeCache(answer) {
  const view = fakeView(answer);
  const clock = manualClock();
  return { view, clock, cache: createPrStateCache({ viewImpl: view, now: clock.now }) };
}

test("the pull request states are listed in their order of precedence", () => {
  assert.deepEqual(PR_STATES, ["merged", "closed", "conflicted", "draft", "unknown", "open"]);
});

test("flattenPrState follows merged > closed > conflicted > draft > unknown > open, and UNKNOWN never reads as no conflict", () => {
  const cases = [
    [{ ok: true, state: "MERGED", mergedAt: "2026-09-11T15:54:01Z" }, "merged"],
    [{ ok: true, state: "CLOSED", mergedAt: "2026-09-11T15:54:01Z" }, "merged"],
    [{ ok: true, state: "CLOSED", mergedAt: null }, "closed"],
    [openView({ mergeable: "CONFLICTING", isDraft: true }), "conflicted"],
    [openView({ mergeable: "MERGEABLE", isDraft: true }), "draft"],
    [openView({ mergeable: "UNKNOWN" }), "unknown"],
    [openView({ mergeable: null }), "unknown"],
    [openView({ mergeable: "MERGEABLE" }), "open"],
    [{ ok: false }, null],
    [{ ok: true, state: "DRAFT" }, null],
    [null, null],
  ];
  for (const [view, expected] of cases) assert.equal(flattenPrState(view), expected, JSON.stringify(view));
});

test("prStateKey folds the case of owner and repo and ignores what follows the number", () => {
  assert.equal(prStateKey("https://github.com/Acme/API/pull/12"), "acme/api#12");
  assert.equal(prStateKey("https://github.com/acme/api/pull/12/files"), "acme/api#12");
  assert.equal(prStateKey("https://github.com/acme/api/pull/12?x=1"), "acme/api#12");
  for (const url of ["https://gitlab.com/acme/api/merge_requests/12", "https://github.com/acme/api/issues/12", "--repo acme/other", "https://github.com/acme/api/pull/x", null, 42, undefined]) {
    assert.equal(prStateKey(url), null, String(url));
  }
});

test("a miss is `unknown` and a URL that is not a GitHub pull request is null", () => {
  const { cache } = makeCache(openView());
  assert.equal(cache.stateOf(PR), "unknown");
  assert.equal(cache.stateOf("https://gitlab.com/acme/api/merge_requests/42"), null);
  assert.equal(cache.stateOf(null), null);
});

test("two concurrent refreshes of two spellings of one pull request make exactly one read, and both await it", async () => {
  let release;
  const gate = new Promise((done) => {
    release = done;
  });
  const { view, cache } = makeCache(async () => {
    await gate;
    return { ok: true, state: "MERGED", mergedAt: "2026-09-11T15:54:01Z" };
  });

  const first = cache.refresh([PR], {});
  const second = cache.refresh(["https://github.com/ACME/api/pull/42/files", PR], {});
  await Promise.resolve();
  assert.equal(view.calls.length, 1, "the second caller started a read of its own");
  release();
  await Promise.all([first, second]);
  assert.equal(cache.stateOf(PR), "merged");
  assert.equal(cache.stateOf("https://github.com/acme/API/pull/42"), "merged");
  assert.equal(view.calls.length, 1);
});

test("a terminal state is never asked about again, not even ten years later", async () => {
  for (const answer of [{ ok: true, state: "MERGED", mergedAt: "2026-09-11T15:54:01Z" }, { ok: true, state: "CLOSED" }]) {
    const { view, clock, cache } = makeCache(answer);
    await cache.refresh([PR], {});
    clock.at += TEN_YEARS_MS;
    await cache.refresh([PR], {});
    assert.equal(view.calls.length, 1, `${answer.state} was asked about again`);
  }
});

test("open, conflicted and draft are asked again after 60s and not before, unknown after 8s", async () => {
  const cases = [
    [openView(), "open", 60_000],
    [openView({ mergeable: "CONFLICTING" }), "conflicted", 60_000],
    [openView({ isDraft: true }), "draft", 60_000],
    [openView({ mergeable: "UNKNOWN" }), "unknown", 8_000],
  ];
  for (const [answer, state, ttlMs] of cases) {
    const { view, clock, cache } = makeCache(answer);
    await cache.refresh([PR], {});
    assert.equal(cache.stateOf(PR), state);
    clock.at += ttlMs - 100;
    await cache.refresh([PR], {});
    assert.equal(view.calls.length, 1, `${state} was asked again before its time`);
    clock.at += 100;
    await cache.refresh([PR], {});
    assert.equal(view.calls.length, 2, `${state} was not asked again once its time was up`);
  }
});

test("a failed read is held back for 30s, is asked again after, and keeps the last known state", async () => {
  let answer = openView({ isDraft: true });
  const { view, clock, cache } = makeCache(() => answer);
  await cache.refresh([PR], {});
  assert.equal(cache.stateOf(PR), "draft");

  answer = { ok: false };
  clock.at += 60_000;
  await cache.refresh([PR], {});
  assert.equal(view.calls.length, 2);
  assert.equal(cache.stateOf(PR), "draft", "a failed read threw the last known state away");

  clock.at += 29_900;
  await cache.refresh([PR], {});
  assert.equal(view.calls.length, 2, "a failed read was asked again inside its cooldown");
  clock.at += 100;
  await cache.refresh([PR], {});
  assert.equal(view.calls.length, 3, "a failed read was never asked again");

  const fresh = makeCache({ ok: false });
  await fresh.cache.refresh([PR], {});
  assert.equal(fresh.cache.stateOf(PR), "unknown", "a key that never answered is not `unknown`");
});

test("NIGHTSHIFT_NO_PR_CHECK=1 makes no read at all", async () => {
  const { view, cache } = makeCache(openView());
  await cache.refresh([PR], { NIGHTSHIFT_NO_PR_CHECK: "1" });
  assert.equal(view.calls.length, 0);
  assert.equal(cache.stateOf(PR), "unknown");
});

test("refresh never rejects when the reader throws, and skips what is not a pull request", async () => {
  const { view, cache } = makeCache(() => {
    throw new Error("gh exploded");
  });
  await cache.refresh([PR, "--repo acme/other", null], {});
  assert.equal(view.calls.length, 1);
  assert.equal(cache.stateOf(PR), "unknown");
  await cache.refresh("not a list", {});
  assert.equal(view.calls.length, 1);
});

test("past five hundred keys the oldest one is evicted", async () => {
  const { cache } = makeCache({ ok: true, state: "CLOSED" });
  const urls = Array.from({ length: 501 }, (_, index) => `https://github.com/acme/api/pull/${index + 1}`);
  await cache.refresh(urls, {});
  assert.equal(cache.stateOf(urls[0]), "unknown", "the oldest key survived past the limit");
  assert.equal(cache.stateOf(urls[1]), "closed");
  assert.equal(cache.stateOf(urls[500]), "closed");
});

test("dispose aborts the signal handed to the reader, and a later refresh makes no read", async () => {
  const { view, cache } = makeCache(
    (_url, { signal }) =>
      new Promise((done) => {
        signal.addEventListener("abort", () => done({ ok: false }));
      }),
  );
  const pending = cache.refresh([PR], {});
  await Promise.resolve();
  const { signal } = view.calls[0].options;
  assert.equal(signal.aborted, false);
  cache.dispose();
  assert.equal(signal.aborted, true);
  await pending;
  await cache.refresh(["https://github.com/acme/api/pull/7"], {});
  assert.equal(view.calls.length, 1, "a disposed cache still asked gh");
});

// A reader whose calls stay open until the test releases them, counting how many run at once.
function heldView() {
  const releases = [];
  const calls = [];
  let running = 0;
  let maxRunning = 0;
  const impl = (url, { signal }) => {
    calls.push(url);
    running += 1;
    maxRunning = Math.max(maxRunning, running);
    return new Promise((done) => {
      const finish = (answer) => {
        running -= 1;
        done(answer);
      };
      releases.push(() => finish({ ok: true, state: "CLOSED" }));
      signal.addEventListener("abort", () => finish({ ok: false }));
    });
  };
  return { impl, calls, releaseAll: () => releases.splice(0).forEach((release) => release()), maxRunning: () => maxRunning };
}

test("two concurrent callers share one cap, and a key queued by one and asked by the other is still one read", async () => {
  const view = heldView();
  const cache = createPrStateCache({ viewImpl: view.impl });
  const urls = Array.from({ length: PR_REFRESH_CONCURRENCY + 3 }, (_, index) => `https://github.com/acme/api/pull/${index + 1}`);

  const first = cache.refresh(urls, {});
  const second = cache.refresh([...urls].reverse(), {});
  await Promise.resolve();
  assert.equal(view.calls.length, PR_REFRESH_CONCURRENCY, "the second caller ran reads past the cap of the first");
  for (let round = 0; round < 50 && !urls.every((url) => cache.stateOf(url) === "closed"); round += 1) {
    view.releaseAll();
    await new Promise((done) => setImmediate(done));
  }
  await Promise.all([first, second]);

  assert.equal(view.calls.length, urls.length, "a key queued by one caller was asked again by the other");
  assert.equal(new Set(view.calls).size, urls.length);
  assert.ok(view.maxRunning() <= PR_REFRESH_CONCURRENCY, `${view.maxRunning()} reads ran at once`);
  for (const url of urls) assert.equal(cache.stateOf(url), "closed", `${url} was never resolved`);
});

test("keys still waiting for a slot when the cache is disposed never start a read", async () => {
  const view = heldView();
  const cache = createPrStateCache({ viewImpl: view.impl });
  const urls = Array.from({ length: PR_REFRESH_CONCURRENCY + 5 }, (_, index) => `https://github.com/acme/api/pull/${index + 1}`);

  const pending = cache.refresh(urls, {});
  await Promise.resolve();
  cache.dispose();
  await pending;

  assert.equal(view.calls.length, PR_REFRESH_CONCURRENCY, "a key queued behind the cap started a gh after the dispose");
});

// The environment of the real fake gh, answering the pull request the way the test asked.
function fakeGhEnv(t, name, fields = {}) {
  return { ...makeHome(t, name), ...isolatedHostVars(makeDir(t, `${name}-host`)), ...fields };
}

// The argv of every call the fake gh recorded.
function ghCalls(env) {
  const log = env.NIGHTSHIFT_FAKE_GH_LOG;
  if (!existsSync(log)) return [];
  return readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

test("ghPrViewAsync asks the real fake gh for exactly the five fields and parses them", async (t) => {
  const env = fakeGhEnv(t, "pr-view-merged", { NIGHTSHIFT_FAKE_GH_PR_STATE: "MERGED", NIGHTSHIFT_FAKE_GH_PR_SHA: MERGE_SHA });
  assert.deepEqual(await ghPrViewAsync(PR, { env }), {
    ok: true,
    state: "MERGED",
    mergedAt: "2026-09-11T15:54:01Z",
    mergeSha: MERGE_SHA,
    mergeable: "MERGEABLE",
    isDraft: false,
  });
  assert.deepEqual(ghCalls(env), [["pr", "view", PR, "--json", PR_FIELDS]]);

  const conflicted = fakeGhEnv(t, "pr-view-conflicted", { NIGHTSHIFT_FAKE_GH_PR_STATE: "OPEN", NIGHTSHIFT_FAKE_GH_PR_MERGEABLE: "CONFLICTING" });
  assert.equal(flattenPrState(await ghPrViewAsync(PR, { env: conflicted })), "conflicted");
  const draft = fakeGhEnv(t, "pr-view-draft", { NIGHTSHIFT_FAKE_GH_PR_STATE: "OPEN", NIGHTSHIFT_FAKE_GH_PR_DRAFT: "1" });
  assert.deepEqual(await ghPrViewAsync(PR, { env: draft }), {
    ok: true,
    state: "OPEN",
    mergedAt: null,
    mergeSha: null,
    mergeable: "MERGEABLE",
    isDraft: true,
  });

  const stateless = fakeGhEnv(t, "pr-view-stateless");
  assert.deepEqual(await ghPrViewAsync(PR, { env: stateless }), { ok: false });
});

test("dispose kills a gh that is still hanging, so the refresh settles at once instead of after the sleep", async (t) => {
  const env = fakeGhEnv(t, "pr-view-dispose", { NIGHTSHIFT_FAKE_GH_PR_STATE: "OPEN", NIGHTSHIFT_FAKE_GH_SLEEP_MS: "4000" });
  delete env.NIGHTSHIFT_NO_PR_CHECK;
  const cache = createPrStateCache();
  const startedAt = Date.now();
  const pending = cache.refresh([PR], env);
  setTimeout(() => cache.dispose(), 300);
  await pending;
  assert.ok(Date.now() - startedAt < 2500, `the refresh waited ${Date.now() - startedAt}ms for a gh that was aborted`);
  assert.equal(cache.stateOf(PR), "unknown");
});

// An execFile double that answers one `gh pr view` call the way the test asked.
function fakeExecFile(answer) {
  const calls = [];
  const impl = (file, args, options, callback) => {
    calls.push([file, ...args]);
    if (answer instanceof Error && answer.thrown) throw answer;
    if (answer instanceof Error) return callback(answer, "", "");
    return callback(null, answer, "");
  };
  impl.calls = calls;
  return impl;
}

test("gh pr view is a tri-state: anything it could not read is undetermined, never a rejection", async () => {
  const closed = fakeExecFile(JSON.stringify({ state: "CLOSED", mergedAt: null, mergeCommit: null, mergeable: "UNKNOWN", isDraft: false }));
  assert.deepEqual(await ghPrViewAsync(PR, { env: {}, execFileImpl: closed }), {
    ok: true,
    state: "CLOSED",
    mergedAt: null,
    mergeSha: null,
    mergeable: "UNKNOWN",
    isDraft: false,
  });
  assert.deepEqual(closed.calls[0], ["gh", "pr", "view", PR, "--json", PR_FIELDS]);

  const undetermined = [
    fakeExecFile(Object.assign(new Error("spawn gh ENOENT"), { code: "ENOENT" })),
    fakeExecFile(Object.assign(new Error("spawn gh EACCES"), { code: "EACCES", thrown: true })),
    fakeExecFile(Object.assign(new Error("gh: not authenticated"), { code: 1 })),
    fakeExecFile(Object.assign(new Error("timed out"), { killed: true, signal: "SIGTERM" })),
    fakeExecFile("not json at all"),
    fakeExecFile(JSON.stringify({ state: "DRAFT" })),
  ];
  for (const execFileImpl of undetermined) {
    assert.deepEqual(await ghPrViewAsync(PR, { env: {}, execFileImpl }), { ok: false });
  }
});
