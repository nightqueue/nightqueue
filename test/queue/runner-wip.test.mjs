import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { run as cli } from "../../src/cli/index.mjs";
import { wipProblemLines } from "../../src/cli/run-publish.mjs";
import { jobLogPath, jobWorktreePath, runDir } from "../../src/config/paths.mjs";
import { openDb } from "../../src/memory/db.mjs";
import { addJob, getJob } from "../../src/memory/jobs.mjs";
import { readRunState } from "../../src/queue/resume.mjs";
import { applyRetry } from "../../src/queue/retry.mjs";
import { recordRunFields, recordTermination, recordWip } from "../../src/queue/run-state.mjs";
import { runCycle } from "../../src/queue/runner.mjs";
import { fileURLToPath } from "node:url";
import { wipNoticeLine } from "../../src/queue/wip-commit.mjs";
import { releaseJobWorktree } from "../../src/queue/worktree.mjs";
import { isolatedHostVars } from "../../test-support/host.mjs";
import { ensureProject, makeDir, makeHome, registerCheckout } from "../../test-support/memory.mjs";
import { fakeCalls, useFakeClaude } from "../../test-support/queue-fake.mjs";
import { doneStream, failureStream, noticeText, resultEvent, SLUG, slugEvent, systemInitEvent, toNdjson, recordedDone } from "../../test-support/streams.mjs";
import { addWorktree, git, gitVars, publishedCheckout } from "../../test-support/worktrees.mjs";

const REASON = "INVALIDATED: [H6] the list reads one table";
const TERMINATE_SCRIPT = fileURLToPath(new URL("../../test-support/run-terminator.mjs", import.meta.url));
const PUBLISH_BODY = ["## Report", "", "the worker failed.", "", "## Cause", "", "a bug.", "", "## Changes", "", "- work.txt", "", "## QA", "", "### Automated", "- `npm test` — PASSED ✅", "", "Not tested: nothing else.", ""].join("\n");

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
  const { checkout, remote } = publishedCheckout(t, name);
  const worktree = addWorktree(checkout, name);
  const env = { ...makeHome(t, name), ...gitVars() };
  registerCheckout(env, { path: checkout, name: "alpha" });
  const plan = useFakeClaude(env, makeDir(t, `${name}-plan`), attempts);
  if (probe) writeFileSync(plan, JSON.stringify({ attempts, probeStatusOf: worktree.path }));
  const projectId = ensureProject(env, "alpha");
  const id = addJob({ projectId, prompt: "fix the worker" }, env).id;
  openDb(env).prepare("UPDATE jobs SET slug = ?, branch = ?, notice_md = ? WHERE id = ?").run(SLUG, worktree.branch, rowNotice, id);
  recordRunFields({ projectId, slug: SLUG, fields: { worktree: worktree.path, branch: worktree.branch }, env });
  return { env, id, projectId, plan, checkout, remote, base: git(["-C", worktree.path, "rev-parse", "HEAD"]).trim(), ...worktree };
}

// Leaves work in the worktree: one tracked change, one new file and one scratch file the wip never takes.
function leaveWork(path) {
  writeFileSync(join(path, "work.txt"), "the finished diff\n");
  writeFileSync(join(path, "tmp-note.md"), "kept\n");
  rmSync(join(path, "tmp"), { recursive: true, force: true });
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
  assert.ok(notice.startsWith(REASON), notice);
  assert.equal(countOf(notice, "Terminated run: "), 1, notice);
  assert.ok(notice.includes(`wip commit ${state.wip.short} kept on ${run.branch} (ref refs/nightqueue/wip/${SLUG}), local, never pushed, not reviewed.`), notice);
  assert.ok(notice.includes("the next attempt starts on the wip commit in the same worktree"), notice);
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
  for (const [label, attempt] of [["done", { stdout: doneStream({ notice: "the pull request is open" }), runState: recordedDone({ notice: "the pull request is open" }), exitCode: 0 }], ["failed", { stdout: failureStream(), exitCode: 1 }]]) {
    const run = makeWipRun(t, `wip-${label}`, { attempts: [attempt] });
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

// The job row's result, parsed from its stored form.
function resultOf(run) {
  return JSON.parse(getJob(run.id, run.env).result);
}

test("a non-fresh retry starts on the wip commit with a clean tree and no wip wording, and a failed ending keeps it with one kept-wip paragraph", async (t) => {
  const run = await terminatedAttempt(t, "wip-retry", { attempts: [{ stdout: terminatedStream(), exitCode: 0 }, failedAttempt()] });
  const wip = readRunState({ projectId: run.projectId, slug: SLUG, env: run.env }).wip;
  await applyRetry({ id: run.id, env: run.env });
  const cycle = await runJob(run);
  assert.equal(cycle.processed[0].status, "failed", JSON.stringify(cycle.processed));
  const [, second] = fakeCalls(run.plan);
  assert.equal(second.cwd, realpathSync(run.path));
  assert.deepEqual(probedLines(second), []);
  assert.equal(second.argv.join("\n").includes("RESTORED WIP"), false, second.argv.join("\n"));
  assert.equal(headOf(run.path).commit, wip.commit);
  assert.equal(git(["-C", run.path, "symbolic-ref", "--short", "HEAD"]).trim(), run.branch);
  assert.deepEqual(statusOf(run.path), []);
  assert.equal(wipRefOf(run), wip.commit);
  assert.equal(readRunState({ projectId: run.projectId, slug: SLUG, env: run.env }).wip.commit, wip.commit);
  const notice = String(getJob(run.id, run.env).notice_md);
  assert.equal(countOf(notice, "Wip commit: "), 1, notice);
  assert.ok(notice.includes(`keeps the wip commit ${wip.short} of a terminated attempt`), notice);
  await applyRetry({ id: run.id, fresh: true, env: run.env });
  assert.equal(git(["-C", run.checkout, "rev-parse", run.branch]).trim(), wip.commit, "the --fresh retry left the old branch off its wip commit");
});

test("a settled close after a retried attempt failed drops nothing but what that attempt added, and the work stays on the branch", async (t) => {
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

test("a branch an older runtime left on the wip's parent keeps its changes uncommitted: the claim resets nothing and moves nothing back", async (t) => {
  const run = await terminatedAttempt(t, "wip-upgrade", { attempts: [{ stdout: terminatedStream(), exitCode: 0 }, failedAttempt()] });
  const wip = readRunState({ projectId: run.projectId, slug: SLUG, env: run.env }).wip;
  recordWip({ projectId: run.projectId, slug: SLUG, wip: { ...wip, restored: true }, env: run.env });
  git(["-C", run.path, "reset", "--mixed", "-q", `${wip.commit}^`]);
  await applyRetry({ id: run.id, env: run.env });
  await runJob(run);
  const [, second] = fakeCalls(run.plan);
  assert.deepEqual(probedLines(second), ["?? tmp-note.md", "?? work.txt"]);
  assert.equal(headOf(run.path).commit, run.base);
  assert.equal(wipRefOf(run), wip.commit);
});

// The files `run publish` reads for a job: its list, its commit message and its pull request body.
function writePublishFiles(dir, listed) {
  mkdirSync(join(dir, "evidence"), { recursive: true });
  writeFileSync(join(dir, "evidence", "automated-verification.md"), "## Verification: PASSED\n");
  writeFileSync(join(dir, "04-implementation.md"), ["## Modified files", ...listed, ""].join("\n"));
  writeFileSync(join(dir, "message.txt"), "fix(worker): deliver the work\n\nTests: npm test\n");
  writeFileSync(join(dir, "body.md"), PUBLISH_BODY);
}

// Runs `run publish` in this process, as the given job.
async function publishAs(t, run, jobId, dir) {
  const out = [];
  const env = { ...run.env, ...isolatedHostVars(makeDir(t, `publish-host-${jobId}`)), NIGHTQUEUE_JOB_ID: String(jobId) };
  const code = await cli(["run", "publish", "--message-file", join(dir, "message.txt"), "--body-file", join(dir, "body.md")], { env, out: (line) => out.push(line), err: (line) => out.push(line), stdout: { write: () => {} } });
  return { code, text: out.join("\n") };
}

// The subjects a branch of the bare remote holds above `main`.
function pushedSubjects(run, branch) {
  return git(["-C", run.remote, "log", "--format=%s", `main..${branch}`]).split("\n").filter(Boolean);
}

test("a new start_branch job on a closed job's wip branch starts on the wip, and `run publish` delivers one commit with the inherited wip inside", async (t) => {
  const run = await terminatedAttempt(t, "wip-start", { attempts: [{ stdout: terminatedStream(), exitCode: 0 }, failedAttempt()], probe: false });
  const wip = readRunState({ projectId: run.projectId, slug: SLUG, env: run.env }).wip;
  const closed = await releaseJobWorktree({ job: { id: run.id, project: "alpha", project_id: run.projectId, slug: SLUG, pr_url: null }, env: run.env, force: true });
  assert.equal(closed?.status, "removed", JSON.stringify(closed));
  const follow = addJob({ projectId: run.projectId, prompt: "continue from the wip", startBranch: run.branch }, run.env).id;
  openDb(run.env).prepare("UPDATE jobs SET slug = 'follow-up' WHERE id = ?").run(follow);
  const path = jobWorktreePath(run.projectId, "follow-up", run.env);
  const attempts = JSON.parse(readFileSync(run.plan, "utf8")).attempts;
  writeFileSync(run.plan, JSON.stringify({ attempts, probeStatusOf: path }));
  await runCycle({ jobId: follow, env: run.env, deps: { gitImpl: preflightGit } });
  const [, second] = fakeCalls(run.plan);
  assert.equal(second.cwd, realpathSync(path));
  assert.equal(second.argv.join("\n").includes("RESTORED WIP"), false);
  assert.deepEqual(probedLines(second), []);
  assert.equal(headOf(path).commit, wip.commit);

  writeFileSync(join(path, "later.txt"), "the new work\n");
  const dir = runDir(run.projectId, "follow-up", run.env);
  writePublishFiles(dir, [join(path, "later.txt")]);
  const published = await publishAs(t, run, follow, dir);
  assert.equal(published.code, 0, published.text);
  assert.ok(published.text.includes("FOLDED: 1 wip commits (2 files)"), published.text);
  assert.deepEqual(git(["-C", path, "show", "--name-only", "--format=", "HEAD"]).trim().split("\n").sort(), ["later.txt", "tmp-note.md", "work.txt"]);
  const branch = git(["-C", path, "symbolic-ref", "--short", "HEAD"]).trim();
  assert.deepEqual(pushedSubjects(run, branch).filter((subject) => subject.startsWith("wip(")), []);
  assert.deepEqual(pushedSubjects(run, branch).slice(0, 1), ["fix(worker): deliver the work"]);
  assert.equal(git(["-C", path, "branch", "--contains", wip.commit, "--format=%(refname:short)"]).trim(), "", "a branch carries the wip commit");
  assert.equal(wipRefOf(run), wip.commit, "the publication moved the wip ref");
  assert.deepEqual(wipProblemLines(path, { projectId: run.projectId, slug: "follow-up", startBranch: run.branch }, run.env), []);
});

test("a retry of a terminated run with code publishes exactly one delivery commit, and the job's files are what it committed", async (t) => {
  const delivered = "fix(worker): deliver the work";
  const run = await terminatedAttempt(t, "wip-deliver", { attempts: [{ stdout: terminatedStream(), exitCode: 0 }, { stdout: doneStream({ notice: "the pull request is open" }), exitCode: 0 }] });
  const wip = readRunState({ projectId: run.projectId, slug: SLUG, env: run.env }).wip;
  const before = Number(git(["-C", run.path, "rev-list", "--count", "main..HEAD"]).trim());
  writeFileSync(join(run.path, "later.txt"), "the new work\n");
  const dir = runDir(run.projectId, SLUG, run.env);
  writePublishFiles(dir, [join(run.path, "later.txt")]);
  const published = await publishAs(t, run, run.id, dir);
  assert.equal(published.code, 0, published.text);
  assert.equal(Number(git(["-C", run.path, "rev-list", "--count", "main..HEAD"]).trim()), before, "the wip commit and the delivery are not one commit");
  assert.equal(headOf(run.path).subject, delivered);
  assert.equal(wipRefOf(run), wip.commit);
  const recorded = readRunState({ projectId: run.projectId, slug: SLUG, env: run.env }).outcome.files;
  assert.deepEqual([...recorded].sort(), git(["-C", run.path, "show", "--name-only", "--format=", "HEAD"]).trim().split("\n").sort());
});

test("the job's files come from the terminated run's wip commit, never from a planted implementation artifact", async (t) => {
  const run = makeWipRun(t, "wip-files", { attempts: [{ stdout: terminatedStream(), exitCode: 0 }] });
  leaveWork(run.path);
  recordTermination({ projectId: run.projectId, slug: SLUG, phase: "qa", reason: REASON, env: run.env });
  writeFileSync(join(runDir(run.projectId, SLUG, run.env), "04-implementation.md"), "## Modified files\nplanted.txt\n");
  assert.equal((await runJob(run)).processed[0].status, "cancelled");
  assert.deepEqual([...resultOf(run).files].sort(), ["tmp-note.md", "work.txt"]);
});

test("the job's files are empty for a run with neither a publication nor a wip, whatever the artifact lists", async (t) => {
  const run = makeWipRun(t, "wip-no-files", { attempts: [{ stdout: failureStream(), exitCode: 1 }] });
  mkdirSync(runDir(run.projectId, SLUG, run.env), { recursive: true });
  writeFileSync(join(runDir(run.projectId, SLUG, run.env), "04-implementation.md"), "## Modified files\nplanted.txt\n");
  assert.equal((await runJob(run)).processed[0].status, "failed");
  assert.deepEqual(resultOf(run).files, []);
});

test("a fresh retry drops the run, removes the worktree and leaves the old branch, named in its answer and its notice, at the wip commit", async (t) => {
  const run = await terminatedAttempt(t, "wip-fresh");
  const wip = readRunState({ projectId: run.projectId, slug: SLUG, env: run.env }).wip;
  assert.ok(getJob(run.id, run.env).notice_md.includes(`add --fresh to start over on a new branch, keeping ${run.branch})`));
  const answer = await applyRetry({ id: run.id, fresh: true, env: run.env });
  assert.equal(getJob(run.id, run.env).slug, null);
  assert.equal(readRunState({ projectId: run.projectId, slug: SLUG, env: run.env }), null);
  assert.equal(git(["-C", run.checkout, "rev-parse", run.branch]).trim(), wip.commit);
  assert.equal(answer.keptBranch, run.branch);
  assert.deepEqual(answer.worktree, { path: run.path, status: "removed" });
  assert.equal(existsSync(run.path), false, "the worktree of the old attempt stayed");
});

test("a worktree removed by hand is recreated from the branch that carries the wip, sitting on it", async (t) => {
  const run = await terminatedAttempt(t, "wip-removed", { attempts: [{ stdout: terminatedStream(), exitCode: 0 }, failedAttempt()], probe: false });
  const wip = readRunState({ projectId: run.projectId, slug: SLUG, env: run.env }).wip;
  rmSync(run.path, { recursive: true, force: true });
  git(["-C", run.checkout, "worktree", "prune"]);
  await applyRetry({ id: run.id, env: run.env });
  await runJob(run);
  const [, second] = fakeCalls(run.plan);
  assert.ok(existsSync(second.cwd), "the worktree was not recreated");
  assert.equal(git(["-C", second.cwd, "symbolic-ref", "--short", "HEAD"]).trim(), run.branch);
  assert.equal(headOf(second.cwd).commit, wip.commit);
  assert.deepEqual(statusOf(second.cwd), []);
});

test("a retry refused because a start_branch job holds the wip branch resets nothing and keeps the wip record", async (t) => {
  const run = await terminatedAttempt(t, "wip-held", { attempts: [{ stdout: terminatedStream(), exitCode: 0 }, { stdout: doneStream({ notice: "the pull request is open" }), runState: recordedDone({ notice: "the pull request is open" }), exitCode: 0 }] });
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

test("a HEAD moved past the wip is left as it is at the next claim, with no kept-wip paragraph", async (t) => {
  const run = await terminatedAttempt(t, "wip-moved", { attempts: [{ stdout: terminatedStream(), exitCode: 0 }, failedAttempt()] });
  git(["-C", run.path, "commit", "-q", "--allow-empty", "-m", "by hand on top"]);
  const moved = headOf(run.path).commit;
  await applyRetry({ id: run.id, env: run.env });
  await runJob(run);
  assert.equal(git(["-C", run.checkout, "rev-parse", run.branch]).trim(), moved);
  assert.equal(String(getJob(run.id, run.env).notice_md).includes("Wip commit: "), false);
});

test("a wip discarded by hand (a hard reset to its parent) stays discarded at the next claim, its ref kept", async (t) => {
  const run = await terminatedAttempt(t, "wip-discarded", { attempts: [{ stdout: terminatedStream(), exitCode: 0 }, failedAttempt()] });
  const wip = readRunState({ projectId: run.projectId, slug: SLUG, env: run.env }).wip;
  git(["-C", run.path, "reset", "--hard", "-q", run.base]);
  await applyRetry({ id: run.id, env: run.env });
  assert.equal((await runJob(run)).processed[0].status, "failed");
  assert.equal(git(["-C", run.checkout, "rev-parse", run.branch]).trim(), run.base);
  assert.equal(String(getJob(run.id, run.env).notice_md).includes("Wip commit: "), false);
  assert.equal(wipRefOf(run), wip.commit, "the discarded wip lost its ref");
  assert.deepEqual(resultOf(run).files, [], "the discarded wip's files are not delivered");
});

test("a HEAD moved past the wip reports no delivered files, and one still on the wip reports the wip's", async (t) => {
  const moved = await terminatedAttempt(t, "wip-files-moved", { attempts: [{ stdout: terminatedStream(), exitCode: 0 }, failedAttempt()] });
  git(["-C", moved.path, "commit", "-q", "--allow-empty", "-m", "by hand on top"]);
  await applyRetry({ id: moved.id, env: moved.env });
  assert.equal((await runJob(moved)).processed[0].status, "failed");
  assert.deepEqual(resultOf(moved).files, []);

  const onWip = await terminatedAttempt(t, "wip-files-kept", { attempts: [{ stdout: terminatedStream(), exitCode: 0 }, failedAttempt()] });
  await applyRetry({ id: onWip.id, env: onWip.env });
  assert.equal((await runJob(onWip)).processed[0].status, "failed");
  assert.deepEqual([...resultOf(onWip).files].sort(), ["tmp-note.md", "work.txt"]);
});

// An attempt whose session records, from inside itself, its triage termination and its no_change conclusion.
function noChangeAttempt(projectId, slug) {
  const stateUrl = new URL("../../src/queue/run-state.mjs", import.meta.url).href;
  const scope = `projectId: ${JSON.stringify(projectId)}, slug: ${JSON.stringify(slug)}, env: process.env`;
  const script = `import(${JSON.stringify(stateUrl)}).then(({ recordOutcome, recordTermination }) => { recordTermination({ ${scope}, phase: "triage", reason: "already fixed" }); recordOutcome({ ${scope}, status: "no_change", notice: "already fixed" }); });`;
  return { exec: ["-e", script], stdout: toNdjson([systemInitEvent(), slugEvent(slug), resultEvent({ text: noticeText("already fixed") })]), exitCode: 0 };
}

test("a start_branch job that concludes no_change on the wip it inherited names that commit, with no record of its own and no files", async (t) => {
  const run = await terminatedAttempt(t, "wip-inherited");
  const wip = readRunState({ projectId: run.projectId, slug: SLUG, env: run.env }).wip;
  await releaseJobWorktree({ job: { id: run.id, project: "alpha", project_id: run.projectId, slug: SLUG, pr_url: null }, env: run.env, force: true });
  const follow = addJob({ projectId: run.projectId, prompt: "continue from the wip", startBranch: run.branch }, run.env).id;
  openDb(run.env).prepare("UPDATE jobs SET slug = 'follow-up' WHERE id = ?").run(follow);
  mkdirSync(runDir(run.projectId, "follow-up", run.env), { recursive: true });
  writeFileSync(run.plan, JSON.stringify({ attempts: [noChangeAttempt(run.projectId, "follow-up")] }));

  const cycle = await runCycle({ jobId: follow, env: run.env, deps: { gitImpl: preflightGit } });

  assert.equal(cycle.processed[0].status, "done", JSON.stringify(cycle.processed));
  assert.equal(headOf(jobWorktreePath(run.projectId, "follow-up", run.env)).commit, wip.commit);
  const notice = String(getJob(follow, run.env).notice_md);
  assert.ok(notice.includes(`Wip commit: the branch ${run.branch} keeps the wip commit ${wip.short}`), notice);
  assert.deepEqual(JSON.parse(getJob(follow, run.env).result).files, []);
  assert.equal(readRunState({ projectId: run.projectId, slug: "follow-up", env: run.env })?.wip, undefined, "the inherited wip was written as this run's own record");
});
