import assert from "node:assert/strict";
import { test } from "node:test";
import { ghPrChecks, ghPrDetail, ghPrDiffNames, ghPrMerge } from "../../src/host/gh.mjs";

const URL = "https://github.com/acme/api/pull/7";

// An in-process execFile double answering one scripted result and recording every call; no binary is ever spawned.
function fakeExecFile({ err = null, stdout = "", stderr = "" } = {}) {
  const calls = [];
  const impl = (file, args, options, callback) => {
    calls.push({ file, args, options });
    setImmediate(() => callback(err, stdout, stderr));
  };
  impl.calls = calls;
  return impl;
}

// The error execFile reports for a non-zero exit.
function exitError(code = 1) {
  return Object.assign(new Error(`Command failed with exit code ${code}`), { code });
}

// The error execFile reports when its timeout killed the child.
function timeoutError() {
  return Object.assign(new Error("timed out"), { killed: true, signal: "SIGTERM", code: null });
}

const OPEN_PR = {
  state: "OPEN",
  mergeable: "MERGEABLE",
  mergeStateStatus: "CLEAN",
  headRefName: "fix/worker",
  headRefOid: "1111111aaaa",
  baseRefName: "main",
  mergeCommit: null,
  mergedAt: null,
  title: "Fix the worker",
  number: 7,
  isDraft: false,
  body: "never kept",
};

test("ghPrDetail asks for exactly the fields a close reads and keeps only them", async () => {
  const execFileImpl = fakeExecFile({ stdout: JSON.stringify(OPEN_PR) });
  const pr = await ghPrDetail(URL, { env: {}, execFileImpl, timeoutMs: 1234 });
  assert.deepEqual(execFileImpl.calls[0].args, [
    "pr",
    "view",
    URL,
    "--json",
    "state,mergeable,mergeStateStatus,headRefName,headRefOid,baseRefName,mergeCommit,mergedAt,title,number,isDraft",
  ]);
  assert.equal(execFileImpl.calls[0].options.timeout, 1234);
  assert.deepEqual(pr, {
    ok: true,
    state: "OPEN",
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    headRefName: "fix/worker",
    headRefOid: "1111111aaaa",
    baseRefName: "main",
    mergeSha: null,
    mergedAt: null,
    title: "Fix the worker",
    number: 7,
    isDraft: false,
  });
  const merged = await ghPrDetail(URL, { env: {}, execFileImpl: fakeExecFile({ stdout: JSON.stringify({ ...OPEN_PR, state: "MERGED", mergeCommit: { oid: "abc1234def" } }) }) });
  assert.equal(merged.mergeSha, "abc1234def");
});

test("ghPrDetail answers ok:false for an unknown state, unreadable json, a failure and a timeout, never throwing", async () => {
  const cases = [
    fakeExecFile({ stdout: JSON.stringify({ ...OPEN_PR, state: "WEIRD" }) }),
    fakeExecFile({ stdout: "not json" }),
    fakeExecFile({ err: exitError(1), stderr: "no pull requests found" }),
    fakeExecFile({ err: timeoutError() }),
  ];
  for (const execFileImpl of cases) assert.equal((await ghPrDetail(URL, { env: {}, execFileImpl })).ok, false);
  const throwing = () => {
    throw Object.assign(new Error("spawn gh ENOENT"), { code: "ENOENT" });
  };
  assert.equal((await ghPrDetail(URL, { env: {}, execFileImpl: throwing })).ok, false);
});

test("ghPrChecks sorts the status check rollup into pass, pending and fail", async () => {
  const rollup = [
    { __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "SUCCESS" },
    { __typename: "CheckRun", name: "lint", status: "COMPLETED", conclusion: "FAILURE" },
    { __typename: "CheckRun", name: "docs", status: "COMPLETED", conclusion: "SKIPPED" },
    { __typename: "CheckRun", name: "e2e", status: "IN_PROGRESS", conclusion: null },
    { __typename: "StatusContext", context: "ci/legacy", state: "PENDING" },
    { __typename: "StatusContext", context: "ci/deploy", state: "ERROR" },
    { __typename: "StatusContext", context: "ci/ok", state: "SUCCESS" },
  ];
  const execFileImpl = fakeExecFile({ stdout: JSON.stringify({ statusCheckRollup: rollup }) });
  const checks = await ghPrChecks(URL, { env: {}, execFileImpl });
  assert.deepEqual(execFileImpl.calls[0].args, ["pr", "view", URL, "--json", "statusCheckRollup"]);
  assert.equal(checks.ok, true);
  assert.deepEqual(checks.failing, ["lint", "ci/deploy"]);
  assert.deepEqual(checks.pending, ["e2e", "ci/legacy"]);
  assert.equal(checks.checks.length, 7);
});

test("ghPrChecks reads an empty rollup as green, parses stdout of a non-zero exit, and answers ok:false on a timeout", async () => {
  assert.deepEqual(await ghPrChecks(URL, { env: {}, execFileImpl: fakeExecFile({ stdout: '{"statusCheckRollup":[]}' }) }), { ok: true, checks: [], failing: [], pending: [] });
  const nonZero = fakeExecFile({ err: exitError(8), stdout: JSON.stringify({ statusCheckRollup: [{ name: "test", status: "QUEUED" }] }) });
  assert.deepEqual((await ghPrChecks(URL, { env: {}, execFileImpl: nonZero })).pending, ["test"]);
  const timedOut = await ghPrChecks(URL, { env: {}, execFileImpl: fakeExecFile({ err: timeoutError() }) });
  assert.equal(timedOut.ok, false);
});

test("ghPrMerge squashes, pins the head commit and never deletes the branch nor bypasses anything", async () => {
  const execFileImpl = fakeExecFile({ stdout: "" });
  const merged = await ghPrMerge(URL, { env: {}, execFileImpl, matchHeadCommit: "1111111aaaa" });
  assert.deepEqual(merged, { ok: true, stderr: "" });
  const [call] = execFileImpl.calls;
  assert.deepEqual(call.args, ["pr", "merge", URL, "--squash", "--match-head-commit", "1111111aaaa"]);
  for (const flag of ["--delete-branch", "--admin", "--auto"]) assert.equal(call.args.includes(flag), false, flag);
  const refused = await ghPrMerge(URL, { env: {}, execFileImpl: fakeExecFile({ err: exitError(1), stderr: "not mergeable" }) });
  assert.deepEqual(refused, { ok: false, stderr: "not mergeable" });
});

test("ghPrDiffNames lists the files of the pull request, and ok:false when gh fails", async () => {
  const execFileImpl = fakeExecFile({ stdout: "src/a.mjs\nsrc/b.mjs\n" });
  assert.deepEqual(await ghPrDiffNames(URL, { env: {}, execFileImpl }), { ok: true, files: ["src/a.mjs", "src/b.mjs"] });
  assert.deepEqual(execFileImpl.calls[0].args, ["pr", "diff", URL, "--name-only"]);
  assert.equal((await ghPrDiffNames(URL, { env: {}, execFileImpl: fakeExecFile({ err: timeoutError() }) })).ok, false);
});
