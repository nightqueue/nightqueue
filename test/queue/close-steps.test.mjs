import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { jobLogPath, logsDir } from "../../src/config/paths.mjs";
import { ensureProject, registerCheckout } from "../../test-support/memory.mjs";
import { loadConfig, saveConfig } from "../../src/config/store.mjs";
import { openDb } from "../../src/memory/db.mjs";
import { acquireClose, addJob, getJob } from "../../src/memory/jobs.mjs";
import { recordRunFields } from "../../src/queue/run-state.mjs";
import { conflictStep, mergeStep, preflightStep, runClosePipeline, settleStep, worktreeLine } from "../../src/queue/close.mjs";
import { closeChecklistLines, closeStoppedLine } from "../../src/queue/close-view.mjs";
import { jobDetailView } from "../../src/queue/view.mjs";
import { openStore, withReadOnlyStore } from "../../src/store/open.mjs";
import { makeHome, makeProject } from "../../test-support/memory.mjs";
import { fakeCloseDeps, gitFail, gitLines, gitOk, HEAD_SHA, MERGE_SHA, mergedPr, openPr, PUSHED_SHA, CLOSE_PR_URL, suiteVerifies, WORKFLOWS } from "../../test-support/close.mjs";
import { doneStream } from "../../test-support/streams.mjs";
import { addWorktree, gitVars, lockWorktree, makeDirty, publishedCheckout } from "../../test-support/worktrees.mjs";

const REMAINING_MS = 600000;
const CANONICAL_COMMANDS = /^(fetch origin|status --porcelain -z|diff --name-only HEAD origin\/|rev-parse |worktree (add|remove|prune)|pull --ff-only$)/;
const CONFLICTING = { mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" };

// A home with a `done` job of `alpha` carrying the pull request, whose close lease `worker` holds.
function closeHome(t, name, { worker = "close:test:1:aaaa", notice = "A", branch = "fix/worker" } = {}) {
  const env = makeHome(t, name);
  const checkout = makeProject(t, env, "alpha");
  const id = addJob({ projectId: ensureProject(env, "alpha"), prompt: "fix the worker" }, env).id;
  openDb(env).prepare("UPDATE jobs SET status = 'done', pr_url = ?, notice_md = ?, branch = ? WHERE id = ?").run(CLOSE_PR_URL, notice, branch, id);
  acquireClose(id, { worker, leaseS: 660 }, env);
  return { env, checkout, id, worker, store: openStore(env) };
}

// Takes the lease again for a new attempt, as the next `queue close` would.
function reacquire(home, worker) {
  assert.ok(acquireClose(home.id, { worker, leaseS: 660 }, home.env), "the next attempt could not take the lease");
  return { ...home, worker };
}

// Runs one attempt of the real steps against the fake gh, git and npm.
async function close(home, fake, { force = false, now = Date.now, onStep = null } = {}) {
  const outcome = await runClosePipeline({ store: home.store, job: getJob(home.id, home.env), worker: home.worker, env: home.env, deps: fake.deps, timeoutS: 600, checkout: home.checkout, force, now, onStep });
  return { outcome, row: getJob(home.id, home.env), checklist: JSON.parse(getJob(home.id, home.env).close) };
}

// The context one step reads when it is called on its own.
function ctxFor(data = {}, checkout = "/work/alpha", changes = {}) {
  return { jobId: 3, prUrl: CLOSE_PR_URL, prNumber: 7, project: "alpha", branch: "fix/worker", slug: null, type: null, force: false, checkout, remainingMs: () => REMAINING_MS, signal: new AbortController().signal, warning: null, data, ...changes };
}

// Asserts the canonical checkout only ever saw the commands a close may run there.
function assertCanonicalUntouched(log, checkout) {
  for (const line of gitLines(log, checkout)) assert.match(line, CANONICAL_COMMANDS, `the close ran \`git ${line}\` in the canonical checkout`);
  assert.equal(gitLines(log).some((line) => line.startsWith("stash")), false, "the close stashed");
}

test("preflight reads a pull request closed without merge and the job is cancelled, its lease released and nothing merged", async (t) => {
  const home = closeHome(t, "close-steps-closed");
  const fake = fakeCloseDeps({ pr: openPr({ state: "CLOSED" }) });
  const { outcome, row, checklist } = await close(home, fake);
  assert.deepEqual(outcome, { status: "cancelled", step: "preflight", reason: "pr-closed", mergeSha: null, worktree: null });
  assert.equal(row.status, "cancelled");
  assert.equal(row.operator_note, "pull request closed without merge");
  assert.equal(JSON.parse(row.result).cancelledFrom, "done");
  assert.equal(row.close_status, null);
  assert.equal(row.close_worker, null);
  assert.equal(row.close_lease_until, null);
  assert.deepEqual(checklist.failed, { step: "preflight", reason: "pr-closed" });
  assert.equal(closeStoppedLine(row), null, "a cancelled job was told to run the close again");
  assert.equal(fake.log.merges.length, 0);
});

test("a pull request closed without merge releases the job's worktree, the same way a cancel from done does", async (t) => {
  const { checkout } = publishedCheckout(t, "close-steps-closed-worktree");
  const env = { ...makeHome(t, "close-steps-closed-worktree"), ...gitVars() };
  registerCheckout(env, { path: checkout, name: "alpha" });
  const worktree = addWorktree(checkout, "feat+abandoned");
  const id = addJob({ projectId: ensureProject(env, "alpha"), prompt: "fix the worker" }, env).id;
  openDb(env).prepare("UPDATE jobs SET status = 'done', slug = 'abandoned', pr_url = ? WHERE id = ?").run(CLOSE_PR_URL, id);
  recordRunFields({ projectId: ensureProject(env, "alpha"), slug: "abandoned", fields: { worktree: worktree.path }, env });
  acquireClose(id, { worker: "close:test:1:aaaa", leaseS: 660 }, env);
  const home = { env, checkout, id, worker: "close:test:1:aaaa", store: openStore(env) };

  const { outcome, row } = await close(home, fakeCloseDeps({ pr: openPr({ state: "CLOSED" }) }));
  assert.equal(outcome.status, "cancelled");
  assert.deepEqual(outcome.worktree, { path: worktree.path, status: "removed" });
  assert.equal(existsSync(worktree.path), false, "the cancelled job's worktree is still on disk");
  assert.equal(row.status, "cancelled");
});

test("a pull request merged by hand is recorded at preflight as the operator's, never merged again, and settles the job with the Closed line appended", async (t) => {
  const home = closeHome(t, "close-steps-merged");
  const fake = fakeCloseDeps({ pr: mergedPr() });
  const { outcome, row, checklist } = await close(home, fake);
  assert.equal(outcome.status, "closed");
  assert.equal(outcome.mergeSha, MERGE_SHA);
  assert.equal(fake.log.merges.length, 0, "a merged pull request was merged again");
  assert.equal(fake.log.checkReads, 0, "the checks of a merged pull request were read");
  assert.equal(checklist.steps.preflight.note, "PR #7 already merged as abc1234");
  assert.equal(checklist.data.merged, true);
  assert.equal(checklist.data.mergedBy, "operator");
  assert.equal(checklist.steps.conflict.status, "skipped");
  assert.equal(checklist.steps.merge.status, "skipped");
  assert.equal(checklist.steps.merge.note, "merged outside a close as abc1234; canonical checkout fast-forwarded on main");
  assert.equal(row.status, "closed");
  assert.equal(row.close_status, null);
  assert.equal(row.notice_md, "A\n\nClosed: PR #7 merged as abc1234 on 2026-09-21");
  assertCanonicalUntouched(fake.log, home.checkout);
});

test("preflight stops at checks-red, and at checks-pending once the budget is spent waiting", async () => {
  const red = fakeCloseDeps({ checks: { ok: true, checks: [], failing: ["lint", "e2e"], pending: ["docs"] } });
  const redResult = await preflightStep({ ctx: ctxFor(), deps: red.deps });
  assert.equal(redResult.status, "failed");
  assert.equal(redResult.reason, "checks-red");
  assert.match(redResult.note, /failing checks: lint, e2e/);

  const pending = fakeCloseDeps({ checks: { ok: true, checks: [], failing: [], pending: ["e2e", "ci/legacy"] } });
  const pendingResult = await preflightStep({ ctx: ctxFor({}, "/work/alpha", { remainingMs: () => 0 }), deps: pending.deps });
  assert.equal(pendingResult.reason, "checks-pending");
  assert.match(pendingResult.note, /checks still running on \w{7} - run queue close J-3 again/);
  assert.deepEqual(pending.log.sleeps, [], "preflight slept with no budget left");

  const unreadable = await preflightStep({ ctx: ctxFor(), deps: fakeCloseDeps({ checks: { ok: false, checks: [], failing: [], pending: [] } }).deps });
  assert.equal(unreadable.reason, "checks-unreadable");
});

test("with --force, preflight goes past red, pending and unreadable checks and its note names what they said", async () => {
  const forced = ctxFor({}, "/work/alpha", { force: true });
  const cases = [
    [{ ok: true, checks: [], failing: ["lint", "e2e"], pending: ["docs"] }, "checks ignored with --force: failing: lint, e2e; pending: docs"],
    [{ ok: true, checks: [], failing: [], pending: ["e2e"] }, "checks ignored with --force: pending: e2e"],
    [{ ok: false, error: "gh: timed out", checks: [], failing: [], pending: [] }, "checks ignored with --force: unreadable: gh: timed out"],
  ];
  for (const [checks, said] of cases) {
    const result = await preflightStep({ ctx: forced, deps: fakeCloseDeps({ checks }).deps });
    assert.equal(result.status, "done", said);
    assert.equal(result.note, `PR #7 open; ${said}; canonical checkout clean`);
  }
});

test("with --force, preflight still stops at a dirty checkout, a missing checkout and a pull request closed without merge", async () => {
  const forced = ctxFor({}, "/work/alpha", { force: true });
  const dirty = fakeCloseDeps({ git: { "status --porcelain -z": gitOk(" M src/a.mjs\0") }, diffNames: { ok: true, files: ["src/a.mjs"] } });
  assert.equal((await preflightStep({ ctx: forced, deps: dirty.deps })).reason, "checkout-dirty");
  assert.equal((await preflightStep({ ctx: forced, deps: fakeCloseDeps({ exists: () => false }).deps })).reason, "checkout-missing");
  assert.equal((await preflightStep({ ctx: forced, deps: fakeCloseDeps({ pr: openPr({ state: "CLOSED" }) }).deps })).reason, "pr-closed");
});

test("preflight stops at checkout-dirty when a local change is in a file the pull would bring, and never stashes it", async () => {
  const fake = fakeCloseDeps({ git: { "status --porcelain -z": gitOk(" M src/a.mjs\0?? notes.txt\0") }, diffNames: { ok: true, files: ["src/a.mjs"] } });
  const result = await preflightStep({ ctx: ctxFor(), deps: fake.deps });
  assert.equal(result.status, "failed");
  assert.equal(result.reason, "checkout-dirty");
  assert.match(result.note, /the pull would touch: src\/a\.mjs; commit or stash them yourself; nightqueue never stashes/);
  assertCanonicalUntouched(fake.log, "/work/alpha");

  const unreadable = fakeCloseDeps({ git: { "status --porcelain -z": gitOk(" M src/a.mjs\0") }, diffNames: { ok: false, files: [] } });
  assert.match((await preflightStep({ ctx: ctxFor(), deps: unreadable.deps })).note, /cannot tell which files the pull would bring/);
});

test("preflight passes a dirty checkout whose changes the pull does not touch, and a clean one", async () => {
  const fake = fakeCloseDeps({
    git: { "status --porcelain -z": gitOk(" M notes.txt\0R  new.md\0old.md\0"), "diff --name-only HEAD origin/": gitOk("docs/x.md\n") },
    diffNames: { ok: true, files: ["src/b.mjs"] },
  });
  const result = await preflightStep({ ctx: ctxFor(), deps: fake.deps });
  assert.equal(result.status, "done");
  assert.match(result.note, /3 local changes the pull does not touch/);
  assert.equal(result.data.headSha, HEAD_SHA);
  assert.equal(result.data.baseBranch, "main");
  assert.equal(result.data.fetchWarning, null);

  const clean = await preflightStep({ ctx: ctxFor(), deps: fakeCloseDeps().deps });
  assert.equal(clean.note, "PR #7 open; 1 checks green; canonical checkout clean");
});

test("preflight stops at checkout-missing when the checkout vanished", async () => {
  const result = await preflightStep({ ctx: ctxFor(), deps: fakeCloseDeps({ exists: () => false }).deps });
  assert.equal(result.reason, "checkout-missing");
});

test("preflight refuses a pull request that is not on the job's branch, naming both branches, and merges nothing", async (t) => {
  const home = closeHome(t, "close-steps-foreign-branch", { branch: "worktree-feat+queue-close" });
  const fake = fakeCloseDeps({ pr: openPr({ headRefName: "scratch/close-qa-20260921201325" }) });
  const { outcome, row, checklist } = await close(home, fake);
  assert.deepEqual(outcome, { status: "failed", step: "preflight", reason: "pr-not-the-job-branch", mergeSha: null, worktree: null });
  assert.equal(
    checklist.steps.preflight.note,
    `pr-not-the-job-branch - PR #7 is on branch \`scratch/close-qa-20260921201325\`, but J-${home.id} ran on \`worktree-feat+queue-close\`; it is not this job's pull request. Fix the job's pr_url before closing it`,
  );
  assert.equal(fake.log.merges.length, 0, "a foreign pull request was merged");
  assert.equal(fake.log.checkReads, 0, "the checks of a foreign pull request were read");
  assert.equal(row.status, "done");
  assert.equal(row.notice_md, "A");
});

test("an already merged pull request of another branch is refused at preflight, never settled onto the job", async (t) => {
  const home = closeHome(t, "close-steps-foreign-merged", { branch: "worktree-feat+queue-close" });
  const fake = fakeCloseDeps({ pr: mergedPr({ headRefName: "scratch/close-qa-20260921201325" }) });
  const { outcome, row, checklist } = await close(home, fake);
  assert.equal(outcome.reason, "pr-not-the-job-branch");
  assert.equal(checklist.data.merged, undefined, "the foreign merge was recorded on the job");
  assert.equal(checklist.steps.settle, undefined);
  assert.equal(row.status, "done");
  assert.equal(row.notice_md, "A", "a Closed line was appended for a foreign pull request");
});

test("preflight passes a pull request on the published alias of the job's worktree branch, with nothing added to the note", async () => {
  const result = await preflightStep({ ctx: ctxFor({}, "/work/alpha", { branch: "worktree-fix+worker" }), deps: fakeCloseDeps().deps });
  assert.equal(result.status, "done");
  assert.equal(result.note, "PR #7 open; 1 checks green; canonical checkout clean");
});

test("preflight proceeds when the job recorded no branch, and says the attribution was not checked", async () => {
  for (const branch of [null, "", "  "]) {
    const result = await preflightStep({ ctx: ctxFor({}, "/work/alpha", { branch }), deps: fakeCloseDeps().deps });
    assert.equal(result.status, "done");
    assert.equal(result.note, "PR #7 open; 1 checks green; canonical checkout clean; branch not recorded; attribution not checked");
  }
});

test("--force never overrides the attribution: a pull request on another branch is still refused and never merged", async (t) => {
  const home = closeHome(t, "close-steps-foreign-forced", { branch: "worktree-feat+queue-close" });
  const fake = fakeCloseDeps({ pr: openPr({ headRefName: "scratch/qa" }) });
  const { outcome, row, checklist } = await close(home, fake, { force: true });
  assert.equal(outcome.status, "failed");
  assert.equal(outcome.reason, "pr-not-the-job-branch");
  assert.match(checklist.steps.preflight.note, /it is not this job's pull request\. Fix the job's pr_url before closing it$/);
  assert.equal(fake.log.merges.length, 0);
  assert.equal(row.status, "done");
});

test("a failed git fetch origin is a warning carried on every later note of the checklist, never a failure", async (t) => {
  const home = closeHome(t, "close-steps-fetch-warning");
  const fake = fakeCloseDeps({ git: { "fetch origin": gitFail("fatal: Could not resolve host: github.com") } });
  const { outcome, checklist } = await close(home, fake);
  assert.equal(outcome.status, "closed");
  const warning = "WARNING: git fetch origin failed (fatal: Could not resolve host: github.com) | ";
  for (const name of ["preflight", "conflict", "merge", "settle"]) assert.ok(checklist.steps[name].note.startsWith(warning), `${name}: ${checklist.steps[name].note}`);
});

test("conflict is skipped when the pull request is merged or mergeable, and never touches a worktree then", async () => {
  const merged = fakeCloseDeps();
  assert.equal((await conflictStep({ ctx: ctxFor({ merged: true }), deps: merged.deps })).status, "skipped");
  assert.equal(merged.log.prReads, 0);

  for (const pr of [openPr(), openPr({ mergeable: "UNKNOWN", mergeStateStatus: "CLEAN" })]) {
    const fake = fakeCloseDeps({ pr });
    assert.equal((await conflictStep({ ctx: ctxFor(), deps: fake.deps })).status, "skipped");
    assert.deepEqual(fake.log.tempDirs, []);
  }
});

test("conflict reads an UNKNOWN mergeability once more after a pause, and stops at mergeability-unknown when it stays so", async () => {
  const unknown = openPr({ mergeable: "UNKNOWN", mergeStateStatus: "UNKNOWN" });
  const stuck = fakeCloseDeps({ pr: unknown });
  const result = await conflictStep({ ctx: ctxFor(), deps: stuck.deps });
  assert.equal(result.reason, "mergeability-unknown");
  assert.equal(stuck.log.prReads, 2);
  assert.deepEqual(stuck.log.sleeps, [3000]);

  const settled = fakeCloseDeps({ reads: [unknown], pr: openPr() });
  assert.equal((await conflictStep({ ctx: ctxFor(), deps: settled.deps })).status, "skipped");
});

test("a conflicting pull request is rebased in a throwaway worktree, tested and force-pushed with a lease when green", async () => {
  const fake = fakeCloseDeps({ pr: openPr(CONFLICTING) });
  const result = await conflictStep({ ctx: ctxFor(), deps: fake.deps });
  const [dir] = fake.log.tempDirs;
  assert.equal(result.status, "done", result.note);
  assert.deepEqual(result.data, { headShaBefore: HEAD_SHA, headSha: PUSHED_SHA, pushedBy: "close", verifiedSha: PUSHED_SHA });
  assert.deepEqual(result.reopen, ["preflight"], "a close push did not reopen preflight");
  assert.deepEqual(gitLines(fake.log, dir), [
    "rebase origin/main",
    "diff --check origin/main HEAD",
    `push --force-with-lease=refs/heads/fix/worker:${HEAD_SHA} origin HEAD:refs/heads/fix/worker`,
    "rev-parse HEAD",
  ]);
  assert.deepEqual(gitLines(fake.log, "/work/alpha"), [
    "fetch origin fix/worker main",
    "rev-parse origin/fix/worker",
    `worktree add --detach ${dir} origin/fix/worker`,
    `worktree remove --force ${dir}`,
    "worktree prune",
  ]);
  assert.deepEqual(fake.log.removedDirs, [dir]);
  assert.equal(fake.log.tests[0].cwd, dir);
  assert.equal(fake.log.tests[0].timeoutMs, REMAINING_MS - 90000);
  assertCanonicalUntouched(fake.log, "/work/alpha");
});

test("a clean rebase of a head that had checks skips the suite and pushes, leaving CI to gate the new head", async () => {
  const fake = fakeCloseDeps({ pr: openPr(CONFLICTING), suite: { ok: false, output: "never run", timedOut: false } });
  const result = await conflictStep({ ctx: ctxFor({ checksOnHead: 3 }), deps: fake.deps });
  assert.equal(result.status, "done", result.note);
  assert.equal(result.note, `rebased onto origin/main, suite skipped (CI gates the head), pushed ${HEAD_SHA.slice(0, 7)} -> ${PUSHED_SHA.slice(0, 7)}`);
  assert.deepEqual(fake.log.tests, [], "a repository with CI ran the local suite on a clean rebase");
  assert.ok(gitLines(fake.log).some((line) => line.startsWith("push")), "the clean rebase was never pushed");
});

test("a clean rebase of a head with no checks runs the suite", async () => {
  const fake = fakeCloseDeps({ pr: openPr(CONFLICTING) });
  const result = await conflictStep({ ctx: ctxFor({ checksOnHead: 0 }), deps: fake.deps });
  assert.equal(result.status, "done", result.note);
  assert.match(result.note, /suite green/);
  assert.equal(fake.log.tests.length, 1);
});

test("preflight records how many checks the previous head had as checksOnHead", async () => {
  const result = await preflightStep({ ctx: ctxFor(), deps: fakeCloseDeps().deps });
  assert.equal(result.status, "done", result.note);
  assert.equal(result.data.checksOnHead, 1);
});

test("a rebase that stops on conflicts is aborted, records the conflict at the seam and fails real-conflict, pushing nothing", async () => {
  const fake = fakeCloseDeps({
    pr: openPr(CONFLICTING),
    git: { "rebase origin/": gitFail("CONFLICT (content): Merge conflict in src/a.mjs"), "diff --name-only --diff-filter=U": gitOk("src/a.mjs\nsrc/b.mjs\n") },
  });
  const result = await conflictStep({ ctx: ctxFor(), deps: fake.deps });
  const [dir] = fake.log.tempDirs;
  assert.equal(result.reason, "real-conflict");
  assert.match(result.note, /conflicts in: src\/a\.mjs, src\/b\.mjs/);
  assert.deepEqual(result.data.conflict, { files: ["src/a.mjs", "src/b.mjs"], prFiles: ["src/a.mjs"], base: "main", head: "fix/worker", headSha: HEAD_SHA });
  assert.ok(gitLines(fake.log, dir).includes("rebase --abort"), "the rebase was never aborted");
  assert.equal(gitLines(fake.log).some((line) => line.startsWith("push")), false, "a conflicted rebase was pushed");
  assert.equal(fake.log.tests.length, 0);
  assert.deepEqual(fake.log.removedDirs, [dir]);
  assert.ok(gitLines(fake.log, "/work/alpha").includes(`worktree remove --force ${dir}`));
});

test("conflict markers a clean rebase left behind fail real-conflict before the suite runs", async () => {
  const fake = fakeCloseDeps({ pr: openPr(CONFLICTING), git: { "diff --check": gitFail("", "src/a.mjs:3: leftover conflict marker\nsrc/a.mjs:9: leftover conflict marker\n") } });
  const result = await conflictStep({ ctx: ctxFor(), deps: fake.deps });
  assert.equal(result.reason, "real-conflict");
  assert.match(result.note, /conflict markers left in: src\/a\.mjs$/);
  assert.equal(fake.log.tests.length, 0);
});

test("a red suite, a missing test script and a refused push stop the conflict step, and the worktree is always removed", async () => {
  const cases = [
    [{ suite: { ok: false, output: "ok 1 - a\nnot ok 2 - b", timedOut: false } }, "suite-red", /npm test failed; nothing was pushed:\nok 1 - a\nnot ok 2 - b/],
    [{ suite: { ok: false, output: "", timedOut: true } }, "suite-red", /npm test timed out after 510 s/],
    [{ testScript: null }, "no-test-script", /has no scripts\.test/],
    [{ git: { push: gitFail("! [rejected] fix/worker (stale info)") } }, "push-refused", /stale info/],
  ];
  for (const [changes, reason, note] of cases) {
    const fake = fakeCloseDeps({ pr: openPr(CONFLICTING), ...changes });
    const result = await conflictStep({ ctx: ctxFor(), deps: fake.deps });
    assert.equal(result.reason, reason);
    assert.match(result.note, note);
    if (reason !== "push-refused") assert.equal(gitLines(fake.log).some((line) => line.startsWith("push")), false, `${reason}: pushed`);
    assert.deepEqual(fake.log.removedDirs, fake.log.tempDirs, `${reason}: the throwaway worktree was left behind`);
  }
});

test("with --force, a conflicting pull request is rebased and pushed without the suite, even with no test script", async () => {
  for (const testScript of ["node --test", null]) {
    const fake = fakeCloseDeps({ pr: openPr(CONFLICTING), testScript, suite: { ok: false, output: "never run", timedOut: false } });
    const result = await conflictStep({ ctx: ctxFor({}, "/work/alpha", { force: true }), deps: fake.deps });
    assert.equal(result.status, "done", result.note);
    assert.equal(result.note, `rebased onto origin/main, suite skipped with --force, pushed ${HEAD_SHA.slice(0, 7)} -> ${PUSHED_SHA.slice(0, 7)}`);
    assert.deepEqual(fake.log.tests, [], "--force ran the suite");
    assert.ok(gitLines(fake.log).some((line) => line.startsWith("push")), "the forced rebase was never pushed");
  }
});

test("with --force, a real conflict, a failed rebase and leftover conflict markers still stop the conflict step, pushing nothing", async () => {
  const cases = [
    [{ "rebase origin/": gitFail("CONFLICT (content)"), "diff --name-only --diff-filter=U": gitOk("src/a.mjs\n") }, "real-conflict"],
    [{ "rebase origin/": gitFail("fatal: bad revision") }, "rebase-failed"],
    [{ "diff --check": gitFail("", "src/a.mjs:3: leftover conflict marker\n") }, "real-conflict"],
  ];
  for (const [git, reason] of cases) {
    const fake = fakeCloseDeps({ pr: openPr(CONFLICTING), git });
    const result = await conflictStep({ ctx: ctxFor({}, "/work/alpha", { force: true }), deps: fake.deps });
    assert.equal(result.reason, reason);
    assert.equal(gitLines(fake.log).some((line) => line.startsWith("push")), false, `${reason}: pushed with --force`);
    assert.deepEqual(fake.log.tests, []);
  }
});

test("the throwaway worktree is removed even when the rebase throws", async () => {
  const fake = fakeCloseDeps({
    pr: openPr(CONFLICTING),
    git: {
      "rebase origin/": () => {
        throw new Error("git exploded");
      },
    },
  });
  await assert.rejects(conflictStep({ ctx: ctxFor(), deps: fake.deps }), /git exploded/);
  const [dir] = fake.log.tempDirs;
  assert.deepEqual(fake.log.removedDirs, [dir]);
  assert.ok(gitLines(fake.log, "/work/alpha").includes(`worktree remove --force ${dir}`));
  assert.ok(gitLines(fake.log, "/work/alpha").includes("worktree prune"));
});

test("merge squashes at the verified head, re-reads the merge commit from GitHub and pulls the base best-effort", async () => {
  const fake = fakeCloseDeps();
  const result = await mergeStep({ ctx: ctxFor({ headSha: HEAD_SHA, baseBranch: "main" }), deps: fake.deps });
  assert.equal(result.status, "done");
  assert.deepEqual(result.data, { merged: true, mergeSha: MERGE_SHA, mergedAt: "2026-09-21T10:00:00Z", mergedBy: "nightqueue" });
  assert.deepEqual(fake.log.merges, [{ url: CLOSE_PR_URL, matchHeadCommit: HEAD_SHA }]);
  assert.match(result.note, /squash-merged as abc1234; canonical checkout fast-forwarded on main/);
  assert.ok(gitLines(fake.log, "/work/alpha").includes("pull --ff-only"));

  const elsewhere = fakeCloseDeps({ git: { "rev-parse --abbrev-ref HEAD": gitOk("feat/x\n"), "pull --ff-only": gitFail("never") } });
  const noted = await mergeStep({ ctx: ctxFor({ headSha: HEAD_SHA, baseBranch: "main" }), deps: elsewhere.deps });
  assert.equal(noted.status, "done");
  assert.match(noted.note, /canonical checkout is on feat\/x, not main; not pulled/);
  assert.equal(gitLines(elsewhere.log).includes("pull --ff-only"), false);

  const failedPull = fakeCloseDeps({ git: { "pull --ff-only": gitFail("fatal: Not possible to fast-forward") } });
  const pulled = await mergeStep({ ctx: ctxFor({ headSha: HEAD_SHA, baseBranch: "main" }), deps: failedPull.deps });
  assert.equal(pulled.status, "done", "a failed pull failed the merge");
  assert.match(pulled.note, /git pull --ff-only failed \(fatal: Not possible to fast-forward\); pull it yourself/);
});

test("merge never takes gh's exit code as the evidence, in either direction", async () => {
  const onlyAutoMerge = fakeCloseDeps({ merge: () => ({ ok: true, stderr: "" }) });
  const lied = await mergeStep({ ctx: ctxFor({ headSha: HEAD_SHA }), deps: onlyAutoMerge.deps });
  assert.equal(lied.reason, "merge-without-sha");
  assert.match(lied.note, /gh pr merge exited 0; the pull request reads OPEN with no merge commit/);
  assert.deepEqual(lied.data, {});
  assert.equal(onlyAutoMerge.log.prReads, 1 + 3);
  assert.deepEqual(onlyAutoMerge.log.sleeps, [2000, 2000]);

  const mergedAnyway = fakeCloseDeps({
    merge: (world) => {
      world.pr = mergedPr();
      return { ok: false, stderr: "GraphQL: timed out" };
    },
  });
  const done = await mergeStep({ ctx: ctxFor({ headSha: HEAD_SHA }), deps: mergedAnyway.deps });
  assert.equal(done.status, "done");
  assert.equal(done.data.mergeSha, MERGE_SHA);

  const withoutOid = fakeCloseDeps({
    merge: (world) => {
      world.pr = mergedPr({ mergeSha: null });
      return { ok: false, stderr: "GraphQL: timed out" };
    },
  });
  const recorded = await mergeStep({ ctx: ctxFor({ headSha: HEAD_SHA }), deps: withoutOid.deps });
  assert.equal(recorded.reason, "merge-without-sha");
  assert.equal(recorded.data.merged, true, "a merge GitHub reports was not recorded");
});

test("a merge the operator made outside a close is confirmed and skipped as `merged outside a close`, never merged again", async () => {
  const recorded = fakeCloseDeps();
  const withSha = await mergeStep({ ctx: ctxFor({ merged: true, mergedBy: "operator", mergeSha: MERGE_SHA, baseBranch: "main" }), deps: recorded.deps });
  assert.equal(withSha.status, "skipped");
  assert.equal(withSha.note, "merged outside a close as abc1234; canonical checkout fast-forwarded on main");
  assert.equal(withSha.data.mergedBy, "operator");
  assert.equal(recorded.log.prReads, 0, "a recorded merge commit was read again");

  const reread = fakeCloseDeps({ pr: mergedPr() });
  const withoutSha = await mergeStep({ ctx: ctxFor({ merged: true, mergedBy: "operator" }), deps: reread.deps });
  assert.equal(withoutSha.status, "skipped");
  assert.equal(withoutSha.data.mergeSha, MERGE_SHA);
  assert.equal(reread.log.prReads, 1);

  const stillMissing = await mergeStep({ ctx: ctxFor({ merged: true, mergedBy: "operator" }), deps: fakeCloseDeps({ pr: mergedPr({ mergeSha: null }) }).deps });
  assert.equal(stillMissing.reason, "merge-without-sha");

  for (const fake of [recorded, reread]) assert.equal(fake.log.merges.length, 0, "a merge made outside a close was merged again");
});

test("conflict and merge record a pull request they read already merged as the operator's, and nightqueue's own merge as nightqueue's", async () => {
  const atConflict = await conflictStep({ ctx: ctxFor(), deps: fakeCloseDeps({ pr: mergedPr() }).deps });
  assert.equal(atConflict.data.mergedBy, "operator");

  const atMerge = fakeCloseDeps({ pr: mergedPr() });
  const found = await mergeStep({ ctx: ctxFor({ headSha: HEAD_SHA }), deps: atMerge.deps });
  assert.equal(found.status, "skipped");
  assert.equal(found.data.mergedBy, "operator");
  assert.match(found.note, /^merged outside a close as abc1234; /);
  assert.equal(atMerge.log.merges.length, 0);

  const own = await mergeStep({ ctx: ctxFor({ merged: true, mergedBy: "nightqueue", mergeSha: MERGE_SHA }), deps: fakeCloseDeps().deps });
  assert.equal(own.status, "done");
  assert.match(own.note, /^already merged as abc1234; /);

  const racedGh = fakeCloseDeps({
    merge: (world) => {
      world.pr = mergedPr({ mergeSha: null });
      return { ok: false, stderr: "exit 1" };
    },
  });
  assert.equal((await mergeStep({ ctx: ctxFor({ headSha: HEAD_SHA }), deps: racedGh.deps })).data.mergedBy, "nightqueue");
});

test("merge takes a head that moved when CI reports on it, and runs the suite on it first when no CI does", async () => {
  const green = fakeCloseDeps({ pr: openPr({ headRefOid: "9999999" }) });
  const taken = await mergeStep({ ctx: ctxFor({ headSha: HEAD_SHA }), deps: green.deps });
  assert.equal(taken.status, "done", taken.note);
  assert.match(taken.note, /^the head moved from 1111111 to 9999999; 1 checks green on 9999999; squash-merged as abc1234; /);
  assert.deepEqual(green.log.merges, [{ url: CLOSE_PR_URL, matchHeadCommit: "9999999" }]);
  assert.equal(taken.data.headSha, "9999999");
  assert.equal(taken.data.pushedBy, null);

  const waited = fakeCloseDeps({ pr: openPr({ headRefOid: "9999999" }), checkReads: [HALF, HALF, GREEN] });
  const afterWait = await mergeStep({ ctx: ctxFor({ headSha: HEAD_SHA }), deps: waited.deps });
  assert.equal(afterWait.status, "done", afterWait.note);
  assert.match(afterWait.note, /^the head moved from 1111111 to 9999999; 2 checks green on 9999999; squash-merged/);
  assert.deepEqual(waited.log.sleeps, [10000]);
  assert.equal(waited.log.checkReads, 3);

  const red = fakeCloseDeps({ pr: openPr({ headRefOid: "9999999" }), checks: RED });
  const stopped = await mergeStep({ ctx: ctxFor({ headSha: HEAD_SHA }), deps: red.deps });
  assert.equal(stopped.reason, "checks-red");
  assert.equal(red.log.merges.length, 0);

  const none = suiteVerifies(fakeCloseDeps({ pr: openPr({ headRefOid: "9999999" }), checks: NO_CHECKS }), "9999999");
  const unverified = await mergeStep({ ctx: ctxFor({ headSha: HEAD_SHA, pushedBy: "close" }), deps: none.deps });
  assert.equal(unverified.status, "done", unverified.note);
  assert.equal(none.log.tests.length, 1, "a moved head no CI reports on was merged without the suite");
  assert.equal(unverified.data.verifiedSha, "9999999");
  assert.match(unverified.note, /^the head moved from 1111111 to 9999999; no CI on 9999999: rebased onto origin\/main, suite green/);
  assert.deepEqual(none.log.merges, [{ url: CLOSE_PR_URL, matchHeadCommit: "9999999" }]);

  const trusted = suiteVerifies(fakeCloseDeps({ pr: openPr({ headRefOid: "9999999" }), checks: NO_CHECKS }), "9999999");
  const noSuite = await mergeStep({ ctx: ctxFor({ headSha: HEAD_SHA }), deps: trusted.deps });
  assert.equal(noSuite.status, "done", noSuite.note);
  assert.equal(trusted.log.tests.length, 1, "a moved head without CI was merged without running the suite on it");
  assert.equal(noSuite.data.verifiedSha, "9999999");
  assert.deepEqual(trusted.log.merges, [{ url: CLOSE_PR_URL, matchHeadCommit: "9999999" }]);

  const redSuite = suiteVerifies(fakeCloseDeps({ pr: openPr({ headRefOid: "9999999" }), checks: NO_CHECKS, suite: { ok: false, output: "not ok 1", timedOut: false } }), "9999999");
  const refused = await mergeStep({ ctx: ctxFor({ headSha: HEAD_SHA }), deps: redSuite.deps });
  assert.equal(refused.reason, "suite-red");
  assert.equal(redSuite.log.merges.length, 0);
  assert.equal("verifiedSha" in refused.data, false, "a red suite recorded a verified head");

  const forced = fakeCloseDeps({ pr: openPr({ headRefOid: "9999999" }), checks: NO_CHECKS });
  const withForce = await mergeStep({ ctx: ctxFor({ headSha: HEAD_SHA, pushedBy: "close" }, "/work/alpha", { force: true }), deps: forced.deps });
  assert.equal(withForce.status, "done");
  assert.match(withForce.note, /taken with --force/);
  assert.equal(forced.log.checkReads, 0);

  const conflicted = fakeCloseDeps({ pr: openPr(CONFLICTING) });
  const again = await mergeStep({ ctx: ctxFor({ headSha: HEAD_SHA }), deps: conflicted.deps });
  assert.equal(again.reason, "not-mergeable");
  assert.deepEqual(again.reopen, ["conflict"]);
  assert.equal(conflicted.log.merges.length, 0);
});

test("a re-run after a failure at merge never merges again: exactly one merge call across attempts", async (t) => {
  const home = closeHome(t, "close-steps-merge-once");
  const fake = fakeCloseDeps({ merge: () => ({ ok: true, stderr: "" }) });
  const first = await close(home, fake);
  assert.deepEqual(first.outcome, { status: "failed", step: "merge", reason: "merge-without-sha", mergeSha: null, worktree: null });
  assert.equal(first.row.status, "done");

  fake.world.pr = mergedPr();
  const second = await close(reacquire(home, "close:test:2:bbbb"), fake);
  assert.equal(second.outcome.status, "closed");
  assert.equal(second.outcome.mergeSha, MERGE_SHA);
  assert.equal(fake.log.merges.length, 1, "the re-run called gh pr merge again");

  const other = closeHome(t, "close-steps-merge-once-recorded");
  const recorded = fakeCloseDeps({
    merge: (world) => {
      world.pr = mergedPr({ mergeSha: null });
      return { ok: false, stderr: "exit 1" };
    },
  });
  assert.equal((await close(other, recorded)).outcome.reason, "merge-without-sha");
  recorded.world.pr = mergedPr();
  assert.equal((await close(reacquire(other, "close:test:3:cccc"), recorded)).outcome.status, "closed");
  assert.equal(recorded.log.merges.length, 1, "a merge recorded by data.merged ran again");
});

test("settle refuses a close whose merge is not recorded with its commit", async () => {
  assert.equal((await settleStep({ ctx: ctxFor({ merged: true }) })).reason, "not-merged");
  const ready = await settleStep({ ctx: ctxFor({ merged: true, mergeSha: MERGE_SHA, mergedAt: "2026-09-21T10:00:00Z" }) });
  assert.equal(ready.data.noticeLine, "Closed: PR #7 merged as abc1234 on 2026-09-21");
});

test("settle closes the job, releases its worktree, appends the Closed line to the notice, and run_notice stays hidden", async (t) => {
  const { checkout } = publishedCheckout(t, "close-steps-settle");
  const env = { ...makeHome(t, "close-steps-settle"), ...gitVars() };
  registerCheckout(env, { path: checkout, name: "alpha" });
  const worktree = addWorktree(checkout, "feat+closed");
  const id = addJob({ projectId: ensureProject(env, "alpha"), prompt: "fix the worker" }, env).id;
  mkdirSync(logsDir(env), { recursive: true });
  writeFileSync(jobLogPath(id, env), doneStream({ notice: "the run's notice" }));
  openDb(env)
    .prepare("UPDATE jobs SET status = 'done', slug = 'closed', pr_url = ?, notice_md = ?, result = ? WHERE id = ?")
    .run(CLOSE_PR_URL, "the run's notice", JSON.stringify({ logPath: jobLogPath(id, env) }), id);
  recordRunFields({ projectId: ensureProject(env, "alpha"), slug: "closed", fields: { worktree: worktree.path }, env });
  acquireClose(id, { worker: "close:test:1:aaaa", leaseS: 660 }, env);
  const home = { env, checkout, id, worker: "close:test:1:aaaa", store: openStore(env) };

  const { outcome, row, checklist } = await close(home, fakeCloseDeps({ pr: mergedPr() }));
  assert.equal(outcome.status, "closed");
  assert.deepEqual(outcome.worktree, { path: worktree.path, status: "removed" });
  assert.equal(existsSync(worktree.path), false, "the job's worktree is still on disk");
  assert.deepEqual(checklist.steps.settle.worktree, { path: worktree.path, status: "removed" });
  assert.equal(row.status, "closed");
  assert.equal(row.close_status, null);
  assert.equal(row.notice_md, "the run's notice\n\nClosed: PR #7 merged as abc1234 on 2026-09-21");
  const detail = await withReadOnlyStore(env, (store) => jobDetailView(store, id));
  assert.equal("run_notice" in detail, false, "the Closed line made the row's notice look replaced");
});

// A done job with a PR whose run recorded the worktree, its close acquired, ready to settle.
function settleHome(t, name, worktreePath, checkout) {
  const env = { ...makeHome(t, name), ...gitVars() };
  registerCheckout(env, { path: checkout, name: "alpha" });
  const id = addJob({ projectId: ensureProject(env, "alpha"), prompt: "fix the worker" }, env).id;
  mkdirSync(logsDir(env), { recursive: true });
  writeFileSync(jobLogPath(id, env), doneStream({ notice: "the run's notice" }));
  openDb(env)
    .prepare("UPDATE jobs SET status = 'done', slug = 'closed', pr_url = ?, notice_md = ?, result = ? WHERE id = ?")
    .run(CLOSE_PR_URL, "the run's notice", JSON.stringify({ logPath: jobLogPath(id, env) }), id);
  recordRunFields({ projectId: ensureProject(env, "alpha"), slug: "closed", fields: { worktree: worktreePath }, env });
  acquireClose(id, { worker: "close:test:1:aaaa", leaseS: 660 }, env);
  return { env, checkout, id, worker: "close:test:1:aaaa", store: openStore(env) };
}

test("settle force-removes a dirty worktree and names what it dropped in the outcome, the checklist and the close line", async (t) => {
  const { checkout } = publishedCheckout(t, "close-steps-dirty");
  const worktree = addWorktree(checkout, "feat+dirty");
  makeDirty(worktree.path);
  const home = settleHome(t, "close-steps-dirty", worktree.path, checkout);

  const { outcome, checklist } = await close(home, fakeCloseDeps({ pr: mergedPr() }));

  assert.equal(outcome.status, "closed");
  assert.equal(existsSync(worktree.path), false, "the dirty worktree is still on disk");
  assert.equal(outcome.worktree.status, "removed");
  assert.match(outcome.worktree.dropped, /\S/);
  assert.deepEqual(checklist.steps.settle.worktree, outcome.worktree);
  assert.equal(worktreeLine(outcome.worktree), `worktree removed: ${worktree.path} (dropped uncommitted: ${outcome.worktree.dropped})`);
});

test("settle keeps a worktree locked by a live session, with the lock reason", async (t) => {
  const { checkout } = publishedCheckout(t, "close-steps-live-lock");
  const worktree = addWorktree(checkout, "feat+live");
  makeDirty(worktree.path);
  lockWorktree(checkout, worktree.path, process.pid);
  const home = settleHome(t, "close-steps-live-lock", worktree.path, checkout);

  const { outcome } = await close(home, fakeCloseDeps({ pr: mergedPr() }));

  assert.equal(outcome.status, "closed");
  assert.deepEqual(outcome.worktree, { path: worktree.path, status: "kept", reason: `it is locked by a live session (pid ${process.pid})` });
  assert.equal(existsSync(worktree.path), true, "a live-locked worktree was removed");
});

const GREEN = { ok: true, checks: [{ name: "a", bucket: "pass" }, { name: "b", bucket: "pass" }], failing: [], pending: [] };
const HALF = { ok: true, checks: [{ name: "a", bucket: "pass" }, { name: "b", bucket: "pending" }], failing: [], pending: ["b"] };
const RED = { ok: true, checks: [{ name: "a", bucket: "pass" }, { name: "b", bucket: "fail" }], failing: ["b"], pending: [] };
const NO_CHECKS = { ok: true, checks: [], failing: [], pending: [] };

// A fake close of a BEHIND pull request whose push moves the head, with a clock the fake sleep advances.
function behindWorld(changes = {}) {
  const clock = { at: Date.now() };
  const fake = fakeCloseDeps({ pr: openPr({ mergeStateStatus: "BEHIND" }), checks: GREEN, ...changes });
  fake.world.git.push = () => {
    fake.world.pr = openPr({ headRefOid: PUSHED_SHA });
    return gitOk();
  };
  const sleep = fake.deps.sleep;
  fake.deps.sleep = async (ms) => {
    clock.at += ms;
    await sleep(ms);
  };
  return { fake, now: () => clock.at };
}

test("a BEHIND pull request is updated, waits for the checks of the new head and merges in one run", async (t) => {
  const home = closeHome(t, "close-steps-behind-green");
  const { fake, now } = behindWorld({ checkReads: [GREEN, HALF, GREEN] });
  const lines = [];
  const { outcome, checklist } = await close(home, fake, { now, onStep: (step) => lines.push(`${step.status} ${step.note}`) });
  assert.equal(outcome.status, "closed", JSON.stringify(outcome));
  assert.match(checklist.steps.conflict.note, new RegExp(`pushed ${HEAD_SHA.slice(0, 7)} -> ${PUSHED_SHA.slice(0, 7)}.*2 checks green`));
  assert.ok(lines.includes("running waiting for checks on 2222222: 1/2 done"), lines.join("\n"));
  assert.deepEqual(fake.log.merges, [{ url: CLOSE_PR_URL, matchHeadCommit: PUSHED_SHA }]);
  assert.deepEqual(fake.log.sleeps, [10000]);
});

test("a BEHIND pull request whose new head goes red stops at checks-red and merges nothing", async (t) => {
  const home = closeHome(t, "close-steps-behind-red");
  const { fake, now } = behindWorld({ checkReads: [GREEN, HALF, RED] });
  const { outcome, checklist } = await close(home, fake, { now });
  assert.equal(outcome.reason, "checks-red");
  assert.match(checklist.steps.conflict.note, /failing checks: b/);
  assert.equal(fake.log.merges.length, 0);
});

test("a BEHIND pull request whose checks outlast the timeout stops resumable, and the next run merges once green", async (t) => {
  const home = closeHome(t, "close-steps-behind-timeout");
  const { fake, now } = behindWorld({ checkReads: [GREEN], checks: HALF });
  const first = await close(home, fake, { now });
  assert.equal(first.outcome.reason, "checks-pending");
  assert.match(first.checklist.steps.conflict.note, /branch updated to 2222222, checks still running - run queue close J-\d+ again/);
  assert.equal(fake.log.merges.length, 0);
  assert.equal(fake.log.sleeps.every((ms) => ms <= 60000), true, "a wait exceeded the backoff cap");

  fake.world.checks = GREEN;
  const second = await close(reacquire(home, "close:test:2:bbbb"), fake, { now });
  assert.equal(second.outcome.status, "closed", JSON.stringify(second.outcome));
  assert.deepEqual(fake.log.merges, [{ url: CLOSE_PR_URL, matchHeadCommit: PUSHED_SHA }]);
});

test("preflight waits for pending checks and the close merges in one run once they are green", async (t) => {
  const home = closeHome(t, "close-steps-preflight-green");
  const { fake, now } = behindWorld({ pr: openPr(), checkReads: [HALF, HALF, GREEN] });
  const lines = [];
  const { outcome, checklist } = await close(home, fake, { now, onStep: (step) => lines.push(`${step.status} ${step.note}`) });
  assert.equal(outcome.status, "closed", JSON.stringify(outcome));
  assert.match(checklist.steps.preflight.note, /2 checks green on 1111111/);
  assert.ok(lines.includes("running waiting for checks on 1111111: 1/2 done"), lines.join("\n"));
  assert.deepEqual(fake.log.sleeps, [10000]);
  assert.equal(fake.log.merges.length, 1);
});

test("pending checks that turn red in the preflight wait stop at checks-red and merge nothing", async (t) => {
  const home = closeHome(t, "close-steps-preflight-red");
  const { fake, now } = behindWorld({ pr: openPr(), checkReads: [HALF, HALF, RED] });
  const { outcome, checklist } = await close(home, fake, { now });
  assert.equal(outcome.reason, "checks-red");
  assert.match(checklist.steps.preflight.note, /failing checks: b/);
  assert.equal(fake.log.merges.length, 0);
});

test("pending checks that outlast the budget stop resumable in preflight, and the next run continues", async (t) => {
  const home = closeHome(t, "close-steps-preflight-timeout");
  const { fake, now } = behindWorld({ pr: openPr(), checks: HALF });
  const first = await close(home, fake, { now });
  assert.equal(first.outcome.reason, "checks-pending");
  assert.match(first.checklist.steps.preflight.note, /checks still running on 1111111 - run queue close J-\d+ again/);
  assert.equal(fake.log.merges.length, 0);

  fake.world.checks = GREEN;
  const second = await close(reacquire(home, "close:test:2:bbbb"), fake, { now });
  assert.equal(second.outcome.status, "closed", JSON.stringify(second.outcome));
  assert.equal(fake.log.merges.length, 1);
});

const RUN_URL = "https://github.com/acme/api/actions/runs/555/job/9";
const ABORTED = { ok: true, checks: [{ name: "a", bucket: "pass" }, { name: "test (24)", bucket: "aborted", detailsUrl: RUN_URL, workflowName: "CI" }], failing: [], pending: [], aborted: ["test (24)"] };

const NEW_RUN_URL = "https://github.com/acme/api/actions/runs/555/job/10";
const ABORTED_AGAIN = { ...ABORTED, checks: [ABORTED.checks[0], { ...ABORTED.checks[1], detailsUrl: NEW_RUN_URL }] };

test("right after the re-run the old cancelled job is still read: it waits as pending, then merges with one re-run", async (t) => {
  const home = closeHome(t, "close-steps-aborted-stale");
  const { fake, now } = behindWorld({ pr: openPr(), checkReads: [ABORTED, ABORTED, HALF, GREEN] });
  const { outcome, checklist } = await close(home, fake, { now });
  assert.equal(outcome.status, "closed", JSON.stringify(outcome));
  assert.equal(fake.log.reruns.length, 1);
  assert.deepEqual(checklist.data.rerun.urls, [RUN_URL]);
  assert.equal(fake.log.merges.length, 1);
});

test("an aborted check is re-run once on its head, the checks are waited on and the close merges", async (t) => {
  const home = closeHome(t, "close-steps-aborted-rerun");
  const { fake, now } = behindWorld({ pr: openPr(), checkReads: [ABORTED, GREEN] });
  const { outcome, checklist } = await close(home, fake, { now });
  assert.equal(outcome.status, "closed", JSON.stringify(outcome));
  assert.deepEqual(fake.log.reruns, [{ runId: "555", failed: true }]);
  assert.equal(checklist.data.rerun.head, HEAD_SHA);
  assert.deepEqual(checklist.data.rerun.runIds, ["555"]);
  assert.match(checklist.steps.preflight.note, /re-ran CI \(test \(24\)\) — cancelled before it ran/);
  assert.equal(fake.log.merges.length, 1);
});

test("a head aborted again after its one re-run stops at checks-aborted naming the run to re-run by hand", async (t) => {
  const home = closeHome(t, "close-steps-aborted-twice");
  const { fake, now } = behindWorld({ pr: openPr(), checkReads: [ABORTED, ABORTED_AGAIN], checks: ABORTED_AGAIN });
  const { outcome, checklist } = await close(home, fake, { now });
  assert.equal(outcome.reason, "checks-aborted");
  assert.match(checklist.steps.preflight.note, /check test \(24\) was cancelled by GitHub twice on 1111111; re-run it by hand: gh run rerun 555 --failed/);
  assert.equal(fake.log.reruns.length, 1);
  assert.equal(fake.log.merges.length, 0);
});

test("a re-run gh refuses, or an aborted check with no run id, stops at checks-aborted", async (t) => {
  const refused = behindWorld({ pr: openPr(), checks: ABORTED, rerun: () => ({ ok: false, error: "run 555 cannot be rerun" }) });
  const first = await close(closeHome(t, "close-steps-aborted-refused"), refused.fake, { now: refused.now });
  assert.equal(first.outcome.reason, "checks-aborted");
  assert.match(first.checklist.steps.preflight.note, /run 555 cannot be rerun/);

  const noRun = { ...ABORTED, checks: [{ name: "test (24)", bucket: "aborted", detailsUrl: "https://ci.example.com/9" }] };
  const second = behindWorld({ pr: openPr(), checks: noRun });
  const result = await close(closeHome(t, "close-steps-aborted-no-run"), second.fake, { now: second.now });
  assert.equal(result.outcome.reason, "checks-aborted");
  assert.equal(second.fake.log.reruns.length, 0);
});

test("a real failure beside an aborted check stays checks-red and re-runs nothing", async (t) => {
  const home = closeHome(t, "close-steps-aborted-with-red");
  const mixed = { ...ABORTED, failing: ["lint"] };
  const { fake, now } = behindWorld({ pr: openPr(), checks: mixed });
  const { outcome } = await close(home, fake, { now });
  assert.equal(outcome.reason, "checks-red");
  assert.equal(fake.log.reruns.length, 0);
});

test("with --force, aborted checks are listed as aborted and never re-run", async () => {
  const forced = ctxFor({}, "/work/alpha", { force: true });
  const fake = fakeCloseDeps({ checks: ABORTED });
  const result = await preflightStep({ ctx: forced, deps: fake.deps });
  assert.equal(result.status, "done");
  assert.match(result.note, /checks ignored with --force: aborted: test \(24\)/);
  assert.equal(fake.log.reruns.length, 0);
});

test("a BEHIND update after a preflight wait spends only what is left of the one close budget", async (t) => {
  const home = closeHome(t, "close-steps-preflight-then-behind");
  const firstWait = [HALF, HALF, HALF, HALF, HALF, HALF, HALF];
  const { fake, now } = behindWorld({ checkReads: [HALF, ...firstWait, GREEN], checks: HALF });
  const { outcome } = await close(home, fake, { now });
  assert.equal(outcome.reason, "checks-pending");
  const spent = fake.log.sleeps.reduce((sum, ms) => sum + ms, 0);
  assert.equal(spent <= (600 - 30) * 1000 && spent > 550000, true, `the two waits spent ${spent}ms of one 600s budget`);
  assert.deepEqual(fake.log.sleeps.slice(0, 7), [10000, 20000, 40000, 60000, 60000, 60000, 60000]);
  assert.equal(fake.log.merges.length, 0);
});

const PUSHED = { headSha: PUSHED_SHA, pushedBy: "close" };

test("after a close push, merge re-reads a stale head and an UNKNOWN mergeability until GitHub shows the pushed head", async () => {
  const fake = fakeCloseDeps({ reads: [openPr(), openPr({ headRefOid: PUSHED_SHA, mergeable: "UNKNOWN" }), openPr({ headRefOid: PUSHED_SHA })] });
  const result = await mergeStep({ ctx: ctxFor(PUSHED), deps: fake.deps });
  assert.equal(result.status, "done", result.note);
  assert.deepEqual(fake.log.merges, [{ url: CLOSE_PR_URL, matchHeadCommit: PUSHED_SHA }]);
  assert.deepEqual(fake.log.sleeps, [2000, 2000]);

  const staleConflict = fakeCloseDeps({ reads: [openPr(CONFLICTING)], pr: openPr({ headRefOid: PUSHED_SHA }) });
  const merged = await mergeStep({ ctx: ctxFor(PUSHED), deps: staleConflict.deps });
  assert.equal(merged.status, "done", "a stale conflicting read failed the merge");
});

test("after a close push, a head that still differs after three reads is merged at the head GitHub shows; without a push merge reads once", async () => {
  const moved = fakeCloseDeps();
  const result = await mergeStep({ ctx: ctxFor(PUSHED), deps: moved.deps });
  assert.equal(result.status, "done", result.note);
  assert.equal(moved.log.prReads, 4, "three reads waiting for the pushed head, one proving the merge");
  assert.deepEqual(moved.log.sleeps, [2000, 2000]);
  assert.deepEqual(moved.log.merges, [{ url: CLOSE_PR_URL, matchHeadCommit: HEAD_SHA }]);

  const plain = fakeCloseDeps({ pr: openPr({ headRefOid: "9999999" }) });
  assert.equal((await mergeStep({ ctx: ctxFor({ headSha: HEAD_SHA }), deps: plain.deps })).status, "done");
  assert.equal(plain.log.prReads, 2, "one read of the head, one proving the merge");
  assert.deepEqual(plain.log.sleeps, []);
});

test("merge judges and merges once more when the head moves during the merge call, and stops with head-moved when it keeps moving", async () => {
  const once = fakeCloseDeps({
    pr: openPr(),
    merge: (world, calls = once.log.merges.length) => {
      if (calls === 1) {
        world.pr = openPr({ headRefOid: "9999999" });
        return { ok: false, stderr: "head ref oid does not match" };
      }
      world.pr = mergedPr();
      return { ok: true, stderr: "" };
    },
  });
  const result = await mergeStep({ ctx: ctxFor({ headSha: HEAD_SHA }), deps: once.deps });
  assert.equal(result.status, "done", result.note);
  assert.deepEqual(once.log.merges.map((call) => call.matchHeadCommit), [HEAD_SHA, "9999999"]);
  assert.match(result.note, /^the head moved from 1111111 to 9999999; 1 checks green on 9999999; squash-merged/);

  let tip = 0;
  const twice = fakeCloseDeps({
    pr: openPr(),
    merge: (world) => {
      tip += 1;
      world.pr = openPr({ headRefOid: `888888${tip}` });
      return { ok: false, stderr: "head ref oid does not match" };
    },
  });
  const left = await mergeStep({ ctx: ctxFor({ headSha: HEAD_SHA }), deps: twice.deps });
  assert.equal(left.status, "failed");
  assert.equal(left.reason, "head-moved");
  assert.match(left.note, /changed 2 times during the close; nothing was merged/);
  assert.deepEqual(left.reopen, ["preflight", "conflict"]);
  assert.equal(twice.log.merges.length, 3);
  assert.notEqual(left.data.headSha, "8888883", "the last head read was recorded");
});

test("conflict never reads a BLOCKED head as mergeable: it waits for the checks of the head GitHub shows, and --force skips the wait", async () => {
  const blocked = openPr({ mergeStateStatus: "BLOCKED" });
  const green = fakeCloseDeps({ pr: blocked, checkReads: [HALF, GREEN] });
  const result = await conflictStep({ ctx: ctxFor({ headSha: HEAD_SHA }), deps: green.deps });
  assert.equal(result.status, "done", result.note);
  assert.match(result.note, /^merge state BLOCKED on 1111111; 2 checks green on 1111111$/);
  assert.equal(result.data.headSha, HEAD_SHA);
  assert.deepEqual(green.log.sleeps, [10000]);

  const none = fakeCloseDeps({ pr: blocked, checks: { ok: true, checks: [], failing: [], pending: [] } });
  const noChecks = await conflictStep({ ctx: ctxFor({ headSha: HEAD_SHA }), deps: none.deps });
  assert.equal(noChecks.note, "merge state BLOCKED on 1111111; no checks reported on 1111111");
  assert.deepEqual(none.log.sleeps, [], "a BLOCKED head with no checks paid a poll");

  const moved = fakeCloseDeps({ pr: openPr({ mergeStateStatus: "BLOCKED", headRefOid: "9999999" }), checkReads: [HALF, GREEN, GREEN] });
  const taken = await conflictStep({ ctx: ctxFor({ headSha: HEAD_SHA, pushedBy: "close" }), deps: moved.deps });
  assert.equal(taken.status, "done", taken.note);
  assert.match(taken.note, /^the head moved from 1111111 to 9999999; 2 checks green on 9999999; merge state BLOCKED on 9999999; 2 checks green on 9999999$/);
  assert.equal(taken.data.headSha, "9999999");
  assert.equal(taken.data.pushedBy, null);

  const unverified = fakeCloseDeps({ pr: openPr({ mergeStateStatus: "BLOCKED", headRefOid: "9999999" }), checks: NO_CHECKS });
  const notedMoved = await conflictStep({ ctx: ctxFor({ headSha: HEAD_SHA, pushedBy: "close" }), deps: unverified.deps });
  assert.equal(notedMoved.status, "done", notedMoved.note);
  assert.match(notedMoved.note, /no CI reports on 9999999 yet/);
  assert.equal(notedMoved.reopen, undefined);
  assert.equal(unverified.log.tests.length, 0, "conflict ran the suite the merge step owns");

  const movedForced = fakeCloseDeps({ pr: openPr({ mergeStateStatus: "BLOCKED", headRefOid: "9999999" }), checks: NO_CHECKS });
  const forcedMoved = await conflictStep({ ctx: ctxFor({ headSha: HEAD_SHA, pushedBy: "close" }, "/work/alpha", { force: true }), deps: movedForced.deps });
  assert.equal(forcedMoved.status, "skipped", forcedMoved.note);
  assert.equal(forcedMoved.data.headSha, "9999999");
  assert.equal(movedForced.log.checkReads, 0);

  const red = fakeCloseDeps({ pr: blocked, checkReads: [RED] });
  const stopped = await conflictStep({ ctx: ctxFor({ headSha: HEAD_SHA }), deps: red.deps });
  assert.equal(stopped.reason, "checks-red");
  assert.equal(red.log.merges.length, 0);

  const forced = fakeCloseDeps({ pr: blocked });
  const skipped = await conflictStep({ ctx: ctxFor({ headSha: HEAD_SHA }, "/work/alpha", { force: true }), deps: forced.deps });
  assert.deepEqual(skipped, { status: "skipped", note: "merge state BLOCKED; checks not waited with --force" });
  assert.equal(forced.log.checkReads, 0);
});

test("after a close push, preflight never records a stale head: another tip git confirms is taken on its checks, head-not-visible when it cannot", async () => {
  const stale = () => fakeCloseDeps({ reads: [openPr(), openPr(), openPr()] });
  const moved = stale();
  const movedResult = await preflightStep({ ctx: ctxFor({ ...PUSHED }), deps: moved.deps });
  assert.equal(movedResult.status, "done", movedResult.note);
  assert.match(movedResult.note, /^PR #7 open; the head moved from 2222222 to 1111111; 1 checks green on 1111111; canonical checkout clean$/);
  assert.equal(movedResult.data.pushedBy, null);
  assert.equal(movedResult.data.headSha, HEAD_SHA);
  assert.deepEqual(moved.log.sleeps, [2000, 2000]);

  const unverified = fakeCloseDeps({ reads: [openPr(), openPr(), openPr()], checks: NO_CHECKS });
  const notedResult = await preflightStep({ ctx: ctxFor({ ...PUSHED }), deps: unverified.deps });
  assert.equal(notedResult.status, "done", notedResult.note);
  assert.equal(notedResult.data.pushedBy, null);
  assert.equal(notedResult.data.headSha, HEAD_SHA);
  assert.match(notedResult.note, /no CI reports on 1111111 yet/);
  assert.equal(notedResult.reopen, undefined);
  assert.equal("ciGreenSha" in notedResult.data, false, "a head no CI reports on was recorded as CI-verified");

  const invisible = stale();
  invisible.world.git["rev-parse origin/"] = gitOk(`${PUSHED_SHA}\n`);
  const invisibleResult = await preflightStep({ ctx: ctxFor({ ...PUSHED }), deps: invisible.deps });
  assert.equal(invisibleResult.reason, "head-not-visible");
  assert.equal("headSha" in invisibleResult.data, false);
  assert.equal("pushedBy" in invisibleResult.data, false);

  const unfetched = stale();
  unfetched.world.git["fetch origin"] = gitFail("offline");
  assert.equal((await preflightStep({ ctx: ctxFor({ ...PUSHED }), deps: unfetched.deps })).reason, "head-not-visible");
});

test("a push whose new head cannot be read stops at head-unreadable, and the next preflight takes the head git and GitHub agree on", async () => {
  const fake = fakeCloseDeps({ pr: openPr(CONFLICTING), git: { "rev-parse HEAD": gitFail("fatal: bad HEAD") } });
  const result = await conflictStep({ ctx: ctxFor(), deps: fake.deps });
  assert.equal(result.reason, "head-unreadable");
  assert.equal(result.data.pushedBy, "close");
  assert.equal(result.data.headSha, null);
  assert.deepEqual(result.reopen, ["preflight"]);
  assert.equal(fake.log.merges.length, 0);

  const next = fakeCloseDeps({ reads: [openPr()] });
  const verified = await preflightStep({ ctx: ctxFor({ headSha: null, pushedBy: "close" }), deps: next.deps });
  assert.equal(verified.status, "done", verified.note);
  assert.equal(verified.data.headSha, HEAD_SHA);
  assert.equal(verified.data.pushedBy, "close");
});

test("a pushed-head checks wait that only reads errors stops at checks-unreadable, not checks-pending", async () => {
  const unreadable = { ok: false, error: "gh: HTTP 502", checks: [], failing: [], pending: [] };
  const fake = fakeCloseDeps({ reads: [openPr({ headRefOid: PUSHED_SHA })], checks: unreadable });
  const result = await preflightStep({ ctx: ctxFor({ ...PUSHED }, "/work/alpha", { remainingMs: () => 0 }), deps: fake.deps });
  assert.equal(result.reason, "checks-unreadable");
  assert.match(result.note, /gh: HTTP 502\) while waiting on 2222222/);
});

test("after a close push, an unreadable read is retried within the three reads", async () => {
  const fake = fakeCloseDeps({ reads: [{ ok: false, error: "gh: timeout" }, openPr({ headRefOid: PUSHED_SHA })] });
  const result = await mergeStep({ ctx: ctxFor({ ...PUSHED }), deps: fake.deps });
  assert.equal(result.status, "done", result.note);
  assert.deepEqual(fake.log.sleeps, [2000]);
});

test("a merge that finds the pull request conflicting again marks conflict reopened, keeps its note, shows it and re-runs it next time", async (t) => {
  const home = closeHome(t, "close-steps-reopened-kept");
  const fake = fakeCloseDeps({ reads: [openPr(), openPr(), openPr(CONFLICTING)] });
  const first = await close(home, fake);
  assert.equal(first.outcome.reason, "not-mergeable");
  assert.equal(first.checklist.steps.conflict.status, "reopened");
  assert.equal(first.checklist.steps.conflict.note, "mergeable (CLEAN)");
  assert.equal(typeof first.checklist.steps.conflict.at, "string");
  const lines = closeChecklistLines(first.row);
  assert.ok(lines.some((line) => /^ {2}↺ conflict {3}reopened: mergeable \(CLEAN\) {2}\(/.test(line)), lines.join("\n"));
  assert.equal(lines.some((line) => line.includes("conflict   not reached")), false);

  const second = await close(reacquire(home, "close:test:2:bbbb"), fake);
  assert.equal(second.outcome.status, "closed", JSON.stringify(second.outcome));
  assert.equal(second.checklist.steps.conflict.status, "skipped");
});

// A fake close of a conflicting pull request whose push moves the head while GitHub still answers the old one for `staleReads` reads.
function conflictingWorld(staleReads, changes = {}) {
  const world = behindWorld({ pr: openPr(CONFLICTING), ...changes });
  world.fake.world.git.push = () => {
    world.fake.world.pr = openPr({ headRefOid: PUSHED_SHA });
    world.fake.world.reads = Array.from({ length: staleReads }, () => openPr(CONFLICTING));
    return gitOk();
  };
  return world;
}

test("a conflicting pull request is rebased, pushed, verified again on the pushed head and merged in one run", async (t) => {
  const home = closeHome(t, "close-steps-pushed-verified");
  const { fake, now } = conflictingWorld(0, { checkReads: [GREEN, HALF, GREEN] });
  const ran = [];
  const { outcome, checklist } = await close(home, fake, { now, onStep: (step) => step.status !== "running" && ran.push(step.name) });
  assert.equal(outcome.status, "closed", JSON.stringify(outcome));
  assert.deepEqual(ran, ["preflight", "conflict", "preflight", "conflict", "merge", "settle"]);
  assert.match(checklist.steps.preflight.note, /2 checks green on 2222222.*head 2222222 pushed by this close/);
  assert.equal(checklist.data.pushedBy, "close");
  assert.deepEqual(fake.log.sleeps, [10000]);
  assert.deepEqual(fake.log.merges, [{ url: CLOSE_PR_URL, matchHeadCommit: PUSHED_SHA }]);
});

test("J-86 replay: GitHub answers the old conflicting head right after the close's push, and the close still merges the pushed head in one run", async (t) => {
  const home = closeHome(t, "close-steps-j86");
  const { fake, now } = conflictingWorld(2, { checkReads: [GREEN] });
  const { outcome } = await close(home, fake, { now });
  assert.equal(outcome.status, "closed", JSON.stringify(outcome));
  assert.deepEqual(fake.log.merges, [{ url: CLOSE_PR_URL, matchHeadCommit: PUSHED_SHA }]);
  assert.deepEqual(fake.log.sleeps, [2000, 2000]);
});

test("a CLEAN pull request is neither updated nor waited on", async (t) => {
  const home = closeHome(t, "close-steps-clean-unchanged");
  const fake = fakeCloseDeps();
  const { outcome } = await close(home, fake);
  assert.equal(outcome.status, "closed");
  assert.equal(fake.log.tempDirs.length, 0);
  assert.equal(fake.log.checkReads, 1);
  assert.deepEqual(fake.log.sleeps, []);
});

test("merge takes a head this close verified or CI reported green on without reading the checks again", async () => {
  for (const data of [{ headSha: HEAD_SHA, verifiedSha: HEAD_SHA }, { headSha: HEAD_SHA, ciGreenSha: HEAD_SHA }]) {
    const fake = fakeCloseDeps({ checks: NO_CHECKS });
    const result = await mergeStep({ ctx: ctxFor(data), deps: fake.deps });
    assert.equal(result.status, "done", result.note);
    assert.equal(fake.log.checkReads, 0, JSON.stringify(data));
    assert.equal(fake.log.tests.length, 0);
    assert.deepEqual(fake.log.merges, [{ url: CLOSE_PR_URL, matchHeadCommit: HEAD_SHA }]);
  }
});

test("a head that never stops moving stops the merge with head-moved after two loopbacks, merging nothing", async () => {
  let tip = 0;
  const fake = fakeCloseDeps({ checks: NO_CHECKS, git: { "rev-parse origin/": gitOk("5555555\n"), "rev-parse HEAD": gitOk("5555555\n") } });
  fake.world.git.push = () => {
    tip += 1;
    fake.world.pr = openPr({ headRefOid: `777777${tip}` });
    return gitOk();
  };
  const result = await mergeStep({ ctx: ctxFor({ headSha: HEAD_SHA }), deps: fake.deps });
  assert.equal(result.reason, "head-moved");
  assert.match(result.note, /^the head changed 2 times during the close; nothing was merged/);
  assert.equal(fake.log.merges.length, 0);
  assert.equal(fake.log.tests.length, 3);
  assert.notEqual(result.data.headSha, "7777773", "the last head read was recorded");
});

test("a close interrupted while the suite runs records no verified head, and the next run runs the suite again before merging", async (t) => {
  const home = closeHome(t, "close-steps-abort-suite");
  const controller = new AbortController();
  const fake = fakeCloseDeps({ checks: NO_CHECKS, git: { "rev-parse HEAD": gitOk(`${HEAD_SHA}\n`) } });
  const runTest = fake.deps.runTest;
  fake.deps.runTest = async (options) => {
    const answer = await runTest(options);
    if (fake.log.tests.length > 1) return answer;
    controller.abort();
    return { ok: true, output: "green", timedOut: false };
  };
  const outcome = await runClosePipeline({ store: home.store, job: getJob(home.id, home.env), worker: home.worker, env: home.env, deps: fake.deps, timeoutS: 600, checkout: home.checkout, signal: controller.signal });
  assert.equal(outcome.reason, "interrupted");
  for (let turn = 0; turn < 50; turn += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(JSON.parse(getJob(home.id, home.env).close).data.verifiedSha, undefined, "an interrupted suite recorded a verified head");
  assert.equal(fake.log.merges.length, 0, "the step the abort orphaned merged");
  assert.equal(gitLines(fake.log).filter((line) => line.startsWith("push")).length, 0, "the step the abort orphaned pushed");

  const second = await close(reacquire(home, "close:test:2:bbbb"), fake);
  assert.equal(second.outcome.status, "closed", JSON.stringify(second.outcome));
  assert.equal(fake.log.tests.length, 2, "the resumed close merged without running the suite again");
  assert.equal(second.checklist.data.verifiedSha, HEAD_SHA);
  assert.deepEqual(fake.log.merges, [{ url: CLOSE_PR_URL, matchHeadCommit: HEAD_SHA }]);
});

test("a branch with workflows waits for CI and never runs the suite when checks show up; a branch without workflows runs the suite at once", async () => {
  const withCi = fakeCloseDeps({ git: { ...WORKFLOWS }, checkReads: [NO_CHECKS, NO_CHECKS, NO_CHECKS, GREEN] });
  const waited = await mergeStep({ ctx: ctxFor({ headSha: HEAD_SHA }), deps: withCi.deps });
  assert.equal(waited.status, "done", waited.note);
  assert.deepEqual(withCi.log.sleeps, [10000, 20000]);
  assert.equal(withCi.log.tests.length, 0, "a repository with CI ran the local suite");
  assert.equal(waited.data.ciGreenSha, HEAD_SHA);
  assert.deepEqual(withCi.log.merges, [{ url: CLOSE_PR_URL, matchHeadCommit: HEAD_SHA }]);

  const noCi = suiteVerifies(fakeCloseDeps({ checks: NO_CHECKS }), HEAD_SHA);
  const tested = await mergeStep({ ctx: ctxFor({ headSha: HEAD_SHA }), deps: noCi.deps });
  assert.equal(tested.status, "done", tested.note);
  assert.equal(noCi.log.tests.length, 1);
  assert.deepEqual(noCi.log.sleeps, []);
  assert.match(tested.note, /^no CI on 1111111: rebased onto origin\/main, suite green/);
  assert.deepEqual(noCi.log.merges, [{ url: CLOSE_PR_URL, matchHeadCommit: HEAD_SHA }]);
});

test("a branch with workflows whose checks never show up is waited on for about 60 s, then the suite runs", async () => {
  const silent = suiteVerifies(fakeCloseDeps({ git: { ...WORKFLOWS }, checks: NO_CHECKS }), HEAD_SHA);
  const result = await mergeStep({ ctx: ctxFor({ headSha: HEAD_SHA }), deps: silent.deps });
  assert.equal(result.status, "done", result.note);
  assert.deepEqual(silent.log.sleeps, [10000, 20000, 30000]);
  assert.equal(silent.log.tests.length, 1);
  assert.equal(result.data.verifiedSha, HEAD_SHA);
});

test("a branch with workflows and no checks yet stops at checks-pending when the budget runs out, never running the suite", async () => {
  const fake = fakeCloseDeps({ git: { ...WORKFLOWS }, checks: NO_CHECKS });
  const result = await mergeStep({ ctx: ctxFor({ headSha: HEAD_SHA }, "/work/alpha", { remainingMs: () => 30000 }), deps: fake.deps });
  assert.equal(result.reason, "checks-pending");
  assert.match(result.note, /no CI reports on 1111111 yet - run queue close J-3 again/);
  assert.equal(fake.log.tests.length, 0);
  assert.equal(fake.log.merges.length, 0);
});

test("without CI and too little of the close's time left for the suite, the merge stops at timeout and merges nothing", async () => {
  const fake = fakeCloseDeps({ checks: NO_CHECKS });
  const result = await mergeStep({ ctx: ctxFor({ headSha: HEAD_SHA }, "/work/alpha", { remainingMs: () => 60000 }), deps: fake.deps });
  assert.equal(result.reason, "timeout");
  assert.equal(fake.log.tests.length, 0);
  assert.equal(fake.log.merges.length, 0);
});

test("without CI and without a test script, the merge stops at no-test-script saying the head cannot be verified and naming --force", async () => {
  const fake = fakeCloseDeps({ checks: NO_CHECKS, testScript: null });
  const result = await mergeStep({ ctx: ctxFor({ headSha: HEAD_SHA }), deps: fake.deps });
  assert.equal(result.reason, "no-test-script");
  assert.match(result.note, /cannot be verified; run queue close J-3 --force/);
  assert.doesNotMatch(result.note, /never pushed/);
  assert.equal(fake.log.merges.length, 0);
});

test("checks gh read on another head than the one judged are unreadable, and nothing is merged", async () => {
  const fake = fakeCloseDeps({ checks: { ...GREEN, headSha: "9999999" } });
  const result = await mergeStep({ ctx: ctxFor({ headSha: HEAD_SHA }), deps: fake.deps });
  assert.equal(result.reason, "checks-unreadable");
  assert.match(result.note, /belong to 9999999, not 1111111/);
  assert.equal(fake.log.merges.length, 0);
});
