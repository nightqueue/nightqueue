import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { jobLogPath, logsDir } from "../../src/config/paths.mjs";
import { addProject } from "../../src/config/projects.mjs";
import { loadConfig, saveConfig } from "../../src/config/store.mjs";
import { openDb } from "../../src/memory/db.mjs";
import { acquireClose, addJob, getJob } from "../../src/memory/jobs.mjs";
import { recordRunFields } from "../../src/queue/run-state.mjs";
import { conflictStep, mergeStep, preflightStep, runClosePipeline, settleStep } from "../../src/queue/close.mjs";
import { closeStoppedLine } from "../../src/queue/close-view.mjs";
import { jobDetailView } from "../../src/queue/view.mjs";
import { openStore, withReadOnlyStore } from "../../src/store/open.mjs";
import { makeHome, makeProject } from "../../test-support/memory.mjs";
import { fakeCloseDeps, gitFail, gitLines, gitOk, HEAD_SHA, MERGE_SHA, mergedPr, openPr, PUSHED_SHA, CLOSE_PR_URL } from "../../test-support/close.mjs";
import { doneStream } from "../../test-support/streams.mjs";
import { addWorktree, gitVars, publishedCheckout } from "../../test-support/worktrees.mjs";

const REMAINING_MS = 600000;
const CANONICAL_COMMANDS = /^(fetch origin|status --porcelain -z|diff --name-only HEAD origin\/|rev-parse |worktree (add|remove|prune)|pull --ff-only$)/;
const CONFLICTING = { mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" };

// A home with a `done` job of `alpha` carrying the pull request, whose close lease `worker` holds.
function closeHome(t, name, { worker = "close:test:1:aaaa", notice = "A", branch = "fix/worker" } = {}) {
  const env = makeHome(t, name);
  const checkout = makeProject(t, env, "alpha");
  const id = addJob({ project: "alpha", prompt: "fix the worker" }, env).id;
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
async function close(home, fake, { force = false } = {}) {
  const outcome = await runClosePipeline({ store: home.store, job: getJob(home.id, home.env), worker: home.worker, env: home.env, deps: fake.deps, timeoutS: 600, checkout: home.checkout, force });
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
  saveConfig(addProject(loadConfig(env, { warn: () => {} }), { path: checkout, name: "alpha" }).config, env);
  const worktree = addWorktree(checkout, "feat+abandoned");
  const id = addJob({ project: "alpha", prompt: "fix the worker" }, env).id;
  openDb(env).prepare("UPDATE jobs SET status = 'done', slug = 'abandoned', pr_url = ? WHERE id = ?").run(CLOSE_PR_URL, id);
  recordRunFields({ project: "alpha", slug: "abandoned", fields: { worktree: worktree.path }, env });
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

test("preflight stops at checks-red and checks-pending naming the checks, and never waits for them", async () => {
  const red = fakeCloseDeps({ checks: { ok: true, checks: [], failing: ["lint", "e2e"], pending: ["docs"] } });
  const redResult = await preflightStep({ ctx: ctxFor(), deps: red.deps });
  assert.equal(redResult.status, "failed");
  assert.equal(redResult.reason, "checks-red");
  assert.match(redResult.note, /failing checks: lint, e2e/);

  const pending = fakeCloseDeps({ checks: { ok: true, checks: [], failing: [], pending: ["e2e", "ci/legacy"] } });
  const pendingResult = await preflightStep({ ctx: ctxFor(), deps: pending.deps });
  assert.equal(pendingResult.reason, "checks-pending");
  assert.match(pendingResult.note, /checks still running: e2e, ci\/legacy/);
  assert.deepEqual(pending.log.sleeps, [], "preflight waited for pending checks");

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
    `pr-not-the-job-branch - PR #7 is on branch \`scratch/close-qa-20260921201325\`, but job \`${home.id}\` ran on \`worktree-feat+queue-close\`; it is not this job's pull request. Fix the job's pr_url before closing it`,
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
  assert.deepEqual(result.data, { headShaBefore: HEAD_SHA, headSha: PUSHED_SHA });
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

test("merge refuses a head that moved and a pull request that conflicts again, reopening the steps to check", async () => {
  const moved = await mergeStep({ ctx: ctxFor({ headSha: HEAD_SHA }), deps: fakeCloseDeps({ pr: openPr({ headRefOid: "9999999" }) }).deps });
  assert.equal(moved.reason, "head-moved");
  assert.deepEqual(moved.reopen, ["preflight", "conflict"]);
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
  saveConfig(addProject(loadConfig(env, { warn: () => {} }), { path: checkout, name: "alpha" }).config, env);
  const worktree = addWorktree(checkout, "feat+closed");
  const id = addJob({ project: "alpha", prompt: "fix the worker" }, env).id;
  mkdirSync(logsDir(env), { recursive: true });
  writeFileSync(jobLogPath(id, env), doneStream({ notice: "the run's notice" }));
  openDb(env)
    .prepare("UPDATE jobs SET status = 'done', slug = 'closed', pr_url = ?, notice_md = ?, result = ? WHERE id = ?")
    .run(CLOSE_PR_URL, "the run's notice", JSON.stringify({ logPath: jobLogPath(id, env) }), id);
  recordRunFields({ project: "alpha", slug: "closed", fields: { worktree: worktree.path }, env });
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
