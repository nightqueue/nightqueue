import assert from "node:assert/strict";
import { existsSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { wipProblemLines } from "../../src/cli/run-publish.mjs";
import { jobLogPath, jobWorktreePath, runDir } from "../../src/config/paths.mjs";
import { openDb } from "../../src/memory/db.mjs";
import { addJob, getJob } from "../../src/memory/jobs.mjs";
import { logPipelineRun } from "../../src/memory/runs.mjs";
import { readRunState } from "../../src/queue/resume.mjs";
import { applyRetry } from "../../src/queue/retry.mjs";
import { recordRunFields, recordTermination } from "../../src/queue/run-state.mjs";
import { runCycle } from "../../src/queue/runner.mjs";
import { fileURLToPath } from "node:url";
import { wipNoticeLine } from "../../src/queue/wip-commit.mjs";
import { releaseJobWorktree } from "../../src/queue/worktree.mjs";
import { ensureProject, makeDir, makeHome, registerCheckout } from "../../test-support/memory.mjs";
import { fakeCalls, useFakeClaude } from "../../test-support/queue-fake.mjs";
import { doneStream, failureStream, noticeText, resultEvent, SLUG, slugEvent, systemInitEvent, toNdjson } from "../../test-support/streams.mjs";
import { addWorktree, git, gitVars, publishedCheckout } from "../../test-support/worktrees.mjs";

const REASON = "INVALIDATED: [H6] the list reads one table";
const TERMINATE_SCRIPT = fileURLToPath(new URL("../../test-support/run-terminator.mjs", import.meta.url));

// The stream of a run that stopped on purpose without a pull request, its own notice carrying the given text.
function terminatedStream(notice = "The run stopped at QA.") {
  return toNdjson([systemInitEvent(), slugEvent(SLUG), resultEvent({ text: noticeText(notice) })]);
}

// A git double for the preflight: a clean checkout of the default branch; the worktree calls of the runner use the real git.
function preflightGit({ args }) {
  const answers = { status: "", "rev-parse": "main", "symbolic-ref": "origin/main" };
  return `${answers[args[0]] ?? ""}\n`;
}

// A home whose project is a real published checkout and one job bound to a real worktree on its own branch, the fake `claude` playing the attempts.
function makeWipRun(t, name, { attempts, rowNotice = null, probe = true }) {
  const { checkout } = publishedCheckout(t, name);
  const worktree = addWorktree(checkout, name);
  const env = { ...makeHome(t, name), ...gitVars() };
  registerCheckout(env, { path: checkout, name: "alpha" });
  const plan = useFakeClaude(env, makeDir(t, `${name}-plan`), attempts);
  if (probe) writeFileSync(plan, JSON.stringify({ attempts, probeStatusOf: worktree.path }));
  const projectId = ensureProject(env, "alpha");
  const id = addJob({ projectId, prompt: "fix the worker" }, env).id;
  openDb(env).prepare("UPDATE jobs SET slug = ?, branch = ?, notice_md = ? WHERE id = ?").run(SLUG, worktree.branch, rowNotice, id);
  recordRunFields({ projectId, slug: SLUG, fields: { worktree: worktree.path, branch: worktree.branch }, env });
  return { env, id, projectId, plan, checkout, base: git(["-C", worktree.path, "rev-parse", "HEAD"]).trim(), ...worktree };
}

// Leaves work in the worktree: one tracked change, one new file and one scratch file the wip never takes.
function leaveWork(path) {
  writeFileSync(join(path, "work.txt"), "the finished diff\n");
  writeFileSync(join(path, "tmp-note.md"), "kept\n");
  rmSync(join(path, "tmp"), { recursive: true, force: true });
}

// Records that this attempt's telemetry committed nothing, which ends a clean no-PR run `cancelled`.
function noCommitTelemetry(run) {
  const { runId } = logPipelineRun({ projectId: run.projectId, slug: SLUG, outcome: "no_commit", phases: [] }, run.env);
  openDb(run.env).prepare("UPDATE pipeline_runs SET created_at = datetime('now', '+1 hour') WHERE id = ?").run(runId);
}

// Runs the one job of the home through a real cycle.
function runJob(run) {
  return runCycle({ jobId: run.id, env: run.env, deps: { gitImpl: preflightGit } });
}

// The HEAD commit of the run's worktree, and its subject.
function headOf(path) {
  return { commit: git(["-C", path, "rev-parse", "HEAD"]).trim(), subject: git(["-C", path, "log", "-1", "--format=%s"]).trim() };
}

// The short status lines of a worktree, trimmed and sorted.
function statusOf(path) {
  return git(["-C", path, "status", "--short"]).split("\n").map((line) => line.trim()).filter(Boolean).sort();
}

// How many times a text occurs in another.
function countOf(text, part) {
  return String(text).split(part).length - 1;
}

// A cancelled first attempt that terminated at QA with work left in its worktree.
async function terminatedAttempt(t, name, options = {}) {
  const run = makeWipRun(t, name, { attempts: options.attempts ?? [{ stdout: terminatedStream(options.notice), exitCode: 0 }], rowNotice: options.rowNotice, probe: options.probe });
  leaveWork(run.path);
  recordTermination({ projectId: run.projectId, slug: SLUG, phase: "qa", reason: REASON, env: run.env });
  noCommitTelemetry(run);
  const cycle = await runJob(run);
  assert.equal(cycle.processed[0].status, "cancelled", JSON.stringify(cycle.processed));
  return run;
}

test("a run that terminated by itself leaves its work as one wip commit, and the notice names it once with the retry and start_branch lines", async (t) => {
  const run = await terminatedAttempt(t, "wip-cancelled");
  const head = headOf(run.path);
  assert.equal(head.subject, `wip(${SLUG}): terminated at qa — ${REASON}`);
  assert.equal(git(["-C", run.path, "rev-parse", "HEAD^"]).trim(), run.base);
  assert.deepEqual(git(["-C", run.path, "show", "--name-only", "--format=", "HEAD"]).trim().split("\n").sort(), ["tmp-note.md", "work.txt"]);
  const state = readRunState({ projectId: run.projectId, slug: SLUG, env: run.env });
  assert.deepEqual([state.wip.status, state.wip.commit, state.wip.branch], ["committed", head.commit, run.branch]);
  const notice = getJob(run.id, run.env).notice_md;
  assert.ok(notice.startsWith("The run stopped at QA."), notice);
  assert.equal(countOf(notice, "Terminated run: "), 1, notice);
  assert.ok(notice.includes(`work kept as wip commit ${state.wip.short} on branch ${run.branch}`), notice);
  assert.equal(countOf(notice, `Retry: nightqueue queue retry J-${run.id} `), 1, notice);
  assert.equal(countOf(notice, `New job from it: start_branch: ${run.branch}`), 1, notice);
  assert.ok(readFileSync(jobLogPath(run.id, run.env), "utf8").includes(`Retry: nightqueue queue retry J-${run.id}`), "the wip paragraph never reached the job log");
});

test("a pasted run_terminate notice and a previous attempt's row notice still leave exactly one current wip paragraph", async (t) => {
  const stale = wipNoticeLine({ wip: { status: "committed", short: "dead000", branch: "old/branch" }, jobId: 999, branch: "old/branch" });
  const pasted = await terminatedAttempt(t, "wip-pasted", { notice: `The run stopped at QA.\n\n${stale}` });
  const fromRun = getJob(pasted.id, pasted.env).notice_md;
  assert.equal(countOf(fromRun, "Terminated run: "), 1, fromRun);
  assert.equal(fromRun.includes("dead000") || fromRun.includes("J-999") || fromRun.includes("old/branch"), false, fromRun);

  const empty = toNdjson([systemInitEvent(), slugEvent(SLUG), resultEvent({ text: "" })]);
  const carried = await terminatedAttempt(t, "wip-row-notice", { attempts: [{ stdout: empty, exitCode: 0 }], rowNotice: `earlier notice\n\n${stale}` });
  const fromRow = getJob(carried.id, carried.env).notice_md;
  assert.equal(countOf(fromRow, "Terminated run: "), 1, fromRow);
  assert.equal(countOf(fromRow, `Retry: nightqueue queue retry J-${carried.id} `), 1, fromRow);
  assert.equal(fromRow.includes("dead000"), false, fromRow);
});

test("a done or failed ending commits nothing and leaves HEAD where the run left it", async (t) => {
  for (const [label, stdout, exitCode] of [["done", doneStream({ notice: "the pull request is open" }), 0], ["failed", failureStream(), 1]]) {
    const run = makeWipRun(t, `wip-${label}`, { attempts: [{ stdout, exitCode }] });
    leaveWork(run.path);
    const cycle = await runJob(run);
    assert.equal(cycle.processed[0].status, label, JSON.stringify(cycle.processed));
    assert.equal(headOf(run.path).commit, run.base, `${label}: a wip commit was made`);
    assert.equal(readRunState({ projectId: run.projectId, slug: SLUG, env: run.env }).wip, undefined, label);
    assert.equal(String(getJob(run.id, run.env).notice_md).includes("Terminated run: "), false, label);
  }
});

test("a run that called run_terminate and then failed tells the operator once about the wip commit its branch keeps", async (t) => {
  const run = makeWipRun(t, "wip-terminate-failed", { attempts: [], probe: false });
  const exec = [TERMINATE_SCRIPT, String(run.projectId), SLUG, String(run.id), REASON];
  writeFileSync(run.plan, JSON.stringify({ attempts: [{ exec, stdout: failureStream(), exitCode: 1 }] }));
  leaveWork(run.path);
  const cycle = await runJob(run);
  assert.equal(cycle.processed[0].status, "failed", JSON.stringify(cycle.processed));
  const ended = readRunState({ projectId: run.projectId, slug: SLUG, env: run.env });
  assert.equal(ended.wip?.status, "committed", JSON.stringify(ended.wip));
  assert.equal(headOf(run.path).commit, ended.wip.commit);
  const notice = String(getJob(run.id, run.env).notice_md);
  assert.equal(countOf(notice, "Wip commit: "), 1, notice);
  assert.ok(notice.includes(`the branch ${run.branch} keeps the wip commit ${ended.wip.short} of a terminated attempt`), notice);
  assert.equal(countOf(notice, `New job from it: start_branch: ${run.branch}`), 1, notice);
  assert.equal(notice.includes("Terminated run: ") || notice.includes("Retry: nightqueue queue retry"), false, notice);
  assert.ok(readFileSync(jobLogPath(run.id, run.env), "utf8").includes(`keeps the wip commit ${ended.wip.short}`), "the kept-wip paragraph never reached the job log");
});

// A failed retried attempt, optionally running a node script (`node -e`) in the worktree before it fails.
function failedAttempt(script = null) {
  return { ...(script ? { exec: ["-e", script] } : {}), stdout: failureStream(), exitCode: 1 };
}

// The status lines a fake probed at its spawn, trimmed and sorted.
function probedLines(call) {
  return String(call.probedStatus ?? "").split("\n").map((line) => line.trim()).filter(Boolean).sort();
}

// The commit the runtime's wip ref of the run names in the checkout, or "" when it is gone.
function wipRefOf(run) {
  return git(["-C", run.checkout, "for-each-ref", "--format=%(objectname)", `refs/nightqueue/wip/${SLUG}`]).trim();
}

test("a non-fresh retry gives the wip back uncommitted, and a failed ending puts the branch back on it with one kept-wip paragraph", async (t) => {
  const run = await terminatedAttempt(t, "wip-retry", { attempts: [{ stdout: terminatedStream(), exitCode: 0 }, failedAttempt()] });
  const wip = readRunState({ projectId: run.projectId, slug: SLUG, env: run.env }).wip;
  await applyRetry({ id: run.id, env: run.env });
  const cycle = await runJob(run);
  assert.equal(cycle.processed[0].status, "failed", JSON.stringify(cycle.processed));
  const [, second] = fakeCalls(run.plan);
  assert.equal(second.cwd, realpathSync(run.path));
  assert.deepEqual(probedLines(second), ["?? tmp-note.md", "?? work.txt"]);
  assert.ok(second.argv.join("\n").includes(`RESTORED WIP: the previous attempt's changes from commit ${wip.short}`), second.argv.join("\n"));
  assert.equal(headOf(run.path).commit, wip.commit, "the failed ending left the work with no branch commit");
  assert.equal(git(["-C", run.path, "symbolic-ref", "--short", "HEAD"]).trim(), run.branch);
  assert.deepEqual(statusOf(run.path), []);
  assert.equal(wipRefOf(run), wip.commit);
  const ended = readRunState({ projectId: run.projectId, slug: SLUG, env: run.env }).wip;
  assert.deepEqual([ended.commit, ended.restored], [wip.commit, false]);
  const notice = String(getJob(run.id, run.env).notice_md);
  assert.equal(countOf(notice, "Wip commit: "), 1, notice);
  assert.ok(notice.includes(`keeps the wip commit ${wip.short} of a terminated attempt`), notice);
  const log = readFileSync(jobLogPath(run.id, run.env), "utf8");
  assert.ok(log.includes(`wip commit ${wip.short} given back to ${run.path}`), log);
  assert.ok(log.includes(`is back on the wip commit ${wip.short}`), log);
  await applyRetry({ id: run.id, fresh: true, env: run.env });
  assert.equal(git(["-C", run.checkout, "rev-parse", run.branch]).trim(), wip.commit, "the --fresh retry left the old branch off its wip commit");
});

test("a settled close after a restored attempt failed drops nothing but what that attempt added, and the work stays on the branch", async (t) => {
  for (const [label, script, dropped] of [["clean", null, undefined], ["extra", "require('fs').writeFileSync('extra.txt', 'later\\n')", "extra.txt"]]) {
    const run = await terminatedAttempt(t, `wip-close-${label}`, { attempts: [{ stdout: terminatedStream(), exitCode: 0 }, failedAttempt(script)] });
    const wip = readRunState({ projectId: run.projectId, slug: SLUG, env: run.env }).wip;
    await applyRetry({ id: run.id, env: run.env });
    assert.equal((await runJob(run)).processed[0].status, "failed", label);
    const job = { id: run.id, project: "alpha", project_id: run.projectId, slug: SLUG, pr_url: null };
    const released = await releaseJobWorktree({ job, env: run.env, force: true });
    assert.equal(released?.dropped, dropped, `${label}: ${JSON.stringify(released)}`);
    assert.equal(git(["-C", run.checkout, "rev-parse", run.branch]).trim(), wip.commit, label);
    assert.equal(wipRefOf(run), wip.commit, label);
    assert.match(git(["-C", run.checkout, "log", "--format=%H", run.branch, "--", "work.txt"]), new RegExp(wip.commit), label);
  }
});

test("a crash between the restore and its record still gives the prompt the restored wip, and the ending re-anchors it", async (t) => {
  const run = await terminatedAttempt(t, "wip-crash", { attempts: [{ stdout: terminatedStream(), exitCode: 0 }, failedAttempt()] });
  const wip = readRunState({ projectId: run.projectId, slug: SLUG, env: run.env }).wip;
  git(["-C", run.path, "reset", "--mixed", "-q", `${wip.commit}^`]);
  await applyRetry({ id: run.id, env: run.env });
  await runJob(run);
  const [, second] = fakeCalls(run.plan);
  assert.deepEqual(probedLines(second), ["?? tmp-note.md", "?? work.txt"]);
  assert.ok(second.argv.join("\n").includes(`RESTORED WIP: the previous attempt's changes from commit ${wip.short}`), second.argv.join("\n"));
  assert.ok(readFileSync(jobLogPath(run.id, run.env), "utf8").includes(`wip commit ${wip.short} was already given back`));
  assert.equal(headOf(run.path).commit, wip.commit);
});

test("a new start_branch job on a closed job's wip branch gets the wip back uncommitted, and its delivery never carries the wip commit", async (t) => {
  const deliver = "const g = (...a) => require('child_process').execFileSync('git', ['-c', 'user.name=f', '-c', 'user.email=f@x.invalid', '-c', 'commit.gpgsign=false', ...a]); g('add', 'work.txt', 'tmp-note.md'); g('commit', '-q', '--no-verify', '-m', 'fix: deliver the work');";
  const run = await terminatedAttempt(t, "wip-start", { attempts: [{ stdout: terminatedStream(), exitCode: 0 }, failedAttempt(deliver)], probe: false });
  const wip = readRunState({ projectId: run.projectId, slug: SLUG, env: run.env }).wip;
  const closed = await releaseJobWorktree({ job: { id: run.id, project: "alpha", project_id: run.projectId, slug: SLUG, pr_url: null }, env: run.env, force: true });
  assert.equal(closed?.status, "removed", JSON.stringify(closed));
  const follow = addJob({ projectId: run.projectId, prompt: "continue from the wip", startBranch: run.branch }, run.env).id;
  openDb(run.env).prepare("UPDATE jobs SET slug = 'follow-up' WHERE id = ?").run(follow);
  const path = jobWorktreePath(run.projectId, "follow-up", run.env);
  const attempts = JSON.parse(readFileSync(run.plan, "utf8")).attempts;
  writeFileSync(run.plan, JSON.stringify({ attempts, probeStatusOf: path, probeReadPath: join(runDir(run.projectId, "follow-up", run.env), "state.json") }));
  await runCycle({ jobId: follow, env: run.env, deps: { gitImpl: preflightGit } });
  const [, second] = fakeCalls(run.plan);
  assert.equal(second.cwd, realpathSync(path));
  assert.ok(second.argv.join("\n").includes(`RESTORED WIP: the previous attempt's changes from commit ${wip.short}`), second.argv.join("\n"));
  assert.deepEqual(probedLines(second), ["?? tmp-note.md", "?? work.txt"]);
  const atSpawn = JSON.parse(second.probedText).wip;
  assert.deepEqual([atSpawn.commit, atSpawn.parent, atSpawn.restored], [wip.commit, run.base, true]);
  assert.equal(headOf(path).subject, "fix: deliver the work", "the ending reset the attempt's delivery commit");
  assert.equal(git(["-C", path, "rev-parse", "HEAD^"]).trim(), run.base, "the delivery commit does not sit on the wip's parent");
  assert.equal(git(["-C", path, "branch", "--contains", wip.commit, "--format=%(refname:short)"]).trim(), "", "a branch carries the wip commit");
  assert.deepEqual(wipProblemLines(path, run.env), []);
  assert.equal(readRunState({ projectId: run.projectId, slug: "follow-up", env: run.env }).wip, undefined, "the moved HEAD kept the restored record");
});

test("a fresh retry drops the run and leaves the old branch at the wip commit", async (t) => {
  const run = await terminatedAttempt(t, "wip-fresh");
  const wip = readRunState({ projectId: run.projectId, slug: SLUG, env: run.env }).wip;
  await applyRetry({ id: run.id, fresh: true, env: run.env });
  assert.equal(getJob(run.id, run.env).slug, null);
  assert.equal(readRunState({ projectId: run.projectId, slug: SLUG, env: run.env }), null);
  assert.equal(git(["-C", run.checkout, "rev-parse", run.branch]).trim(), wip.commit);
});

test("a worktree removed by hand is recreated from the branch that carries the wip, then restored", async (t) => {
  const run = await terminatedAttempt(t, "wip-removed", { attempts: [{ stdout: terminatedStream(), exitCode: 0 }, failedAttempt()], probe: false });
  const wip = readRunState({ projectId: run.projectId, slug: SLUG, env: run.env }).wip;
  rmSync(run.path, { recursive: true, force: true });
  git(["-C", run.checkout, "worktree", "prune"]);
  await applyRetry({ id: run.id, env: run.env });
  await runJob(run);
  const [, second] = fakeCalls(run.plan);
  assert.ok(existsSync(second.cwd), "the worktree was not recreated");
  assert.equal(git(["-C", second.cwd, "symbolic-ref", "--short", "HEAD"]).trim(), run.branch);
  assert.ok(second.argv.join("\n").includes("RESTORED WIP: "), "the recreated worktree's prompt has no RESTORED WIP line");
  assert.equal(headOf(second.cwd).commit, wip.commit);
  assert.deepEqual(statusOf(second.cwd), []);
});

test("a retry refused because a start_branch job holds the wip branch resets nothing and keeps the wip record", async (t) => {
  const run = await terminatedAttempt(t, "wip-held", { attempts: [{ stdout: terminatedStream(), exitCode: 0 }, { stdout: doneStream({ notice: "the pull request is open" }), exitCode: 0 }] });
  const wip = readRunState({ projectId: run.projectId, slug: SLUG, env: run.env }).wip;
  const holder = addJob({ projectId: run.projectId, prompt: "continue from the wip", startBranch: run.branch }, run.env).id;
  openDb(run.env).prepare("UPDATE jobs SET slug = 'holder-run' WHERE id = ?").run(holder);
  recordRunFields({ projectId: run.projectId, slug: "holder-run", fields: { branch: run.branch, worktree: run.path }, env: run.env });
  await applyRetry({ id: run.id, env: run.env });
  const cycle = await runJob(run);
  assert.notEqual(cycle.processed[0]?.status, "done", JSON.stringify(cycle.processed));
  assert.match(String(getJob(run.id, run.env).notice_md), new RegExp(`belongs to J-${holder}, which is not closed`));
  assert.equal(fakeCalls(run.plan).length, 1, "the refused retry still spawned a session");
  assert.equal(headOf(run.path).commit, wip.commit);
  assert.equal(readRunState({ projectId: run.projectId, slug: SLUG, env: run.env }).wip.commit, wip.commit);
});

test("a HEAD moved past the wip is never reset at the next claim, and the record is dropped", async (t) => {
  const run = await terminatedAttempt(t, "wip-moved", { attempts: [{ stdout: terminatedStream(), exitCode: 0 }, { stdout: doneStream({ notice: "the pull request is open" }), exitCode: 0 }] });
  git(["-C", run.path, "commit", "-q", "--allow-empty", "-m", "by hand on top"]);
  const moved = headOf(run.path).commit;
  await applyRetry({ id: run.id, env: run.env });
  await runJob(run);
  const [, second] = fakeCalls(run.plan);
  assert.equal(git(["-C", run.checkout, "rev-parse", run.branch]).trim(), moved);
  assert.equal(second.argv.join("\n").includes("RESTORED WIP: "), false);
  assert.equal(readRunState({ projectId: run.projectId, slug: SLUG, env: run.env }).wip, undefined);
  assert.ok(readFileSync(jobLogPath(run.id, run.env), "utf8").includes("is no longer HEAD of"));
});

test("a wip discarded by hand (a hard reset to its parent) is never handed back or re-anchored at the next claim", async (t) => {
  const run = await terminatedAttempt(t, "wip-discarded", { attempts: [{ stdout: terminatedStream(), exitCode: 0 }, failedAttempt(), failedAttempt()] });
  const wip = readRunState({ projectId: run.projectId, slug: SLUG, env: run.env }).wip;
  await applyRetry({ id: run.id, env: run.env });
  assert.equal((await runJob(run)).processed[0].status, "failed");
  assert.equal(headOf(run.path).commit, wip.commit, "precondition: the failed ending re-anchored on the wip");
  git(["-C", run.path, "reset", "--hard", "-q", run.base]);
  await applyRetry({ id: run.id, env: run.env });
  assert.equal((await runJob(run)).processed[0].status, "failed");
  const third = fakeCalls(run.plan)[2];
  assert.equal(third.argv.join("\n").includes("RESTORED WIP: "), false, third.argv.join("\n"));
  assert.equal(git(["-C", run.checkout, "rev-parse", run.branch]).trim(), run.base);
  assert.equal(readRunState({ projectId: run.projectId, slug: SLUG, env: run.env }).wip, undefined);
  assert.equal(wipRefOf(run), wip.commit, "the discarded wip lost its ref");
  assert.ok(readFileSync(jobLogPath(run.id, run.env), "utf8").includes(`the wip commit ${wip.short} was discarded from ${run.path} by hand`));
});
