import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { jobLogPath, queuePausedPath, queueResumePath, runDir } from "../../src/config/paths.mjs";
import { addProject } from "../../src/config/projects.mjs";
import { loadConfig, saveConfig } from "../../src/config/store.mjs";
import { openDb } from "../../src/memory/db.mjs";
import { addJob, claimJobById, getJob, parkJob } from "../../src/memory/jobs.mjs";
import { clockLabel } from "../../src/queue/hints.mjs";
import { writeRunnerRecord } from "../../src/queue/registry.mjs";
import { isolatedHostVars } from "../../test-support/host.mjs";
import { makeDir, makeHome } from "../../test-support/memory.mjs";
import { useFakeClaude } from "../../test-support/queue-fake.mjs";
import { assistantEvent, doneStream, GATE_MARKER, GATE_NOTICE, gateStream, PR_URL, SLUG } from "../../test-support/streams.mjs";

const CLI = fileURLToPath(new URL("../../bin/nightshift.mjs", import.meta.url));

// Runs the real CLI in its own process, with the isolated home of the test.
function runCli(env, args, { cwd } = {}) {
  return spawnSync(process.execPath, [CLI, ...args], { env, cwd, encoding: "utf8" });
}

// Registers a real (and empty) git repository as a project of the home.
function makeGitProject(t, env, name) {
  const path = makeDir(t, `repo-${name}`);
  execFileSync("git", ["-c", "init.defaultBranch=main", "init", "-q", path]);
  saveConfig(addProject(loadConfig(env, { warn: () => {} }), { path, name }).config, env);
  return path;
}

// The pause region a runner of this home would have merged into its own registration for a limit resetting at that instant.
function pauseRegion(resetsAt) {
  return {
    pausedAt: new Date().toISOString(),
    pausedUntil: new Date(resetsAt.getTime() + 60_000).toISOString(),
    resetsAt: resetsAt.toISOString(),
    type: "five_hour",
    utilization: 0.99,
  };
}

// A home with a registered git project and the fake `claude` the runner will spawn.
function makeCliHome(t, name, attempts = [{ stdout: doneStream(), exitCode: 0 }]) {
  const env = makeHome(t, name);
  makeGitProject(t, env, "alpha");
  useFakeClaude(env, makeDir(t, `${name}-plan`), attempts);
  return env;
}

// Path of the registered project of a home, the directory a `queue add` without project runs from.
function projectPath(env) {
  return loadConfig(env, { warn: () => {} }).projects.alpha.path;
}

// Enqueues one job of the test project straight in the database.
function enqueue(env, prompt = "fix the worker") {
  return addJob({ project: "alpha", prompt }, env).id;
}

test("--help lists the queue commands next to the ones that were already there", (t) => {
  const env = makeCliHome(t, "cli-help");
  const result = runCli(env, ["--help"]);
  assert.equal(result.status, 0);
  for (const line of ["queue add", "queue status", "queue run", "queue cancel", "queue retry", "queue pause", "queue log"]) {
    assert.ok(result.stdout.includes(line), `\`${line}\` is missing from the help`);
  }
});

test("queue add --help prints the job-cutting rule and the example, and enqueues nothing", (t) => {
  const env = makeCliHome(t, "cli-add-help");
  for (const flag of ["--help", "-h"]) {
    const helped = runCli(env, ["queue", "add", flag]);
    assert.equal(helped.status, 0, helped.stderr);
    assert.ok(helped.stdout.includes("nightshift queue add [project] <prompt...>"), `\`${flag}\` did not print the usage line`);
    assert.ok(helped.stdout.includes("self-contained deliverable"), `\`${flag}\` did not print the rule`);
    assert.ok(helped.stdout.includes("numbered stages"), `\`${flag}\` did not print the rule`);
    assert.ok(
      helped.stdout.includes('nightshift queue add "Self-contained install. Stages: 1) runtime under ~/.nightshift;'),
      `\`${flag}\` did not print the example`,
    );
  }
  assert.equal(getJob(1, env), null, "the help enqueued a job");

  const queued = runCli(env, ["queue", "add", "alpha", "fix the worker"], { cwd: makeDir(t, "cli-add-help-outside") });
  assert.equal(queued.status, 0, queued.stderr);
  assert.equal(getJob(1, env).prompt, "fix the worker");
});

test("queue add takes the registered NAME and reports the job it queued", (t) => {
  const env = makeCliHome(t, "cli-add");
  const outside = makeDir(t, "cli-add-outside");
  const queued = runCli(env, ["queue", "add", "alpha", "fix the worker", "--priority", "2", "--timeout", "600"], { cwd: outside });
  assert.equal(queued.status, 0, queued.stderr);
  assert.match(
    queued.stdout,
    /queued job #1 for `alpha` \(1 pending\)\. 0 runners online - pending jobs will wait until `nightshift queue run` starts one\./,
  );
  assert.equal(getJob(1, env).prompt, "fix the worker");

  writeRunnerRecord({ pid: process.pid, startedAt: new Date().toISOString(), mode: "watch", intervalS: 30, logPath: "/tmp/a.log" }, env);
  const withOneRunner = runCli(env, ["queue", "add", "alpha", "fix the worker"], { cwd: outside });
  assert.equal(withOneRunner.status, 0, withOneRunner.stderr);
  assert.match(withOneRunner.stdout, /1 runner online - it will be picked up\./);

  writeRunnerRecord({ pid: process.ppid, startedAt: new Date().toISOString(), mode: "watch", intervalS: 30, logPath: "/tmp/b.log" }, env);
  const withTwoRunners = runCli(env, ["queue", "add", "alpha", "fix the worker"], { cwd: outside });
  assert.equal(withTwoRunners.status, 0, withTwoRunners.stderr);
  assert.match(withTwoRunners.stdout, /2 runners online - it will be picked up\./);

  const byPath = runCli(env, ["queue", "add", "/tmp/alpha", "fix the worker"], { cwd: outside });
  assert.equal(byPath.status, 1);
  assert.match(byPath.stderr, /no project registered for .*; run `nightshift init` here, or pass the project NAME/);

  assert.equal(runCli(env, ["queue", "add", "ghost", "fix it"], { cwd: outside }).status, 1);
  assert.match(runCli(env, ["queue", "add", "alpha", "fix it", "--priority", "0"]).stderr, /`--priority` expects a positive integer/);
  assert.match(runCli(env, ["queue", "add", "alpha"]).stderr, /missing argument; usage: nightshift queue add/);
});

test("queue add without a project takes the one of the current directory and joins the words of the prompt", (t) => {
  const env = makeCliHome(t, "cli-add-cwd");
  const repo = projectPath(env);
  const queued = runCli(env, ["queue", "add", "fix", "the", "flaky", "worker"], { cwd: repo });
  assert.equal(queued.status, 0, queued.stderr);
  assert.match(queued.stdout, /project `alpha` resolved from the current directory/);
  assert.match(
    queued.stdout,
    /queued job #1 for `alpha` \(1 pending\)\. 0 runners online - pending jobs will wait until `nightshift queue run` starts one\./,
  );
  assert.equal(getJob(1, env).prompt, "fix the flaky worker");

  const escaped = runCli(env, ["queue", "add", "--", "explain", "--run", "to", "me"], { cwd: repo });
  assert.equal(escaped.status, 0, escaped.stderr);
  assert.equal(getJob(2, env).prompt, "explain --run to me");
  assert.equal(escaped.stdout.includes("running job"), false, "a prompt that mentions --run ran the job");
});

test("queue add --run --foreground runs the job here and answers with its outcome", (t) => {
  const env = makeCliHome(t, "cli-add-run");
  const ran = runCli(env, ["queue", "add", "alpha", "fix the worker", "--run", "--foreground"]);
  assert.equal(ran.status, 0, ran.stderr);
  assert.ok(
    ran.stdout.indexOf("queued job #1") < ran.stdout.indexOf("running job #1"),
    "the id has to be printed before the job runs",
  );
  assert.match(ran.stdout, /queued job #1 for project `alpha` \(priority \d+, timeout \d+s\)/);
  assert.equal(ran.stdout.includes("Start the batch"), false, "a job that is about to run still nudged for a batch");
  assert.match(ran.stdout, /running job #1 in the foreground; follow the stream with `nightshift queue log 1 --follow`/);
  assert.match(ran.stdout, /job #1 done https:\/\/github\.com\/acme\/api\/pull\/42/);
  assert.equal(getJob(1, env).status, "done");
});

test("queue add --run --foreground exits 1 on any outcome other than done, and when the job never started", (t) => {
  const env = makeCliHome(t, "cli-add-run-gate", [{ stdout: gateStream(), exitCode: 0 }]);
  const gated = runCli(env, ["queue", "add", "alpha", "fix the worker", "--run", "--foreground"]);
  assert.equal(gated.status, 1, gated.stdout);
  assert.match(gated.stdout, /job #1 gate/);
  assert.equal(getJob(1, env).status, "gate");

  saveConfig({ ...loadConfig(env, { warn: () => {} }), queue: { maxConcurrent: 2 } }, env);
  for (const prompt of ["hold the first slot", "hold the second slot"]) {
    claimJobById(addJob({ project: "alpha", prompt }, env).id, { worker: `host:${prompt.length}`, cap: 4 }, env);
  }
  const capped = runCli(env, ["queue", "add", "alpha", "fix the parser", "--run", "--foreground"]);
  assert.equal(capped.status, 1, capped.stdout);
  assert.match(capped.stdout, /job #4 waiting: concurrency cap reached/);
  assert.match(capped.stdout, /2 of 2 jobs already running/);
  assert.equal(getJob(4, env).status, "pending");
});

test("queue status --json answers with the jobs and the counts, and never with the prompt", (t) => {
  const env = makeCliHome(t, "cli-status");
  const first = enqueue(env, "fix the worker");
  const second = enqueue(env, "fix the parser");

  const listed = runCli(env, ["queue", "status", "--json"]);
  assert.equal(listed.status, 0, listed.stderr);
  const payload = JSON.parse(listed.stdout);
  assert.deepEqual(payload.jobs.map((job) => job.id), [second, first]);
  assert.equal("prompt" in payload.jobs[0], false, "the CLI printed the prompt of a job");
  assert.deepEqual(payload.counts, { pending: 2, running: 0, done: 0, gate: 0, failed: 0, cancelled: 0, closed: 0 });
  assert.equal(payload.jobs[0].pr_state, null, "a job without a pull request carries a pull request state");
  assert.equal(payload.counts.merged, undefined, "the retired merged status is still counted");
  assert.deepEqual(payload.suggestions, []);
  assert.deepEqual(payload.sections.map((section) => [section.name, section.ok]), [["jobs", true], ["counts", true], ["runners", true], ["advisories", true]]);

  const one = JSON.parse(runCli(env, ["queue", "status", String(first), "--json"]).stdout);
  assert.deepEqual({ id: one.job.id, status: one.job.status, project: one.job.project }, { id: first, status: "pending", project: "alpha" });
  assert.equal(JSON.parse(runCli(env, ["queue", "status", "--limit", "1", "--json"]).stdout).jobs.length, 1);

  const table = runCli(env, ["queue", "status"]);
  assert.match(table.stdout, /#1\s+○ pending\s+-\s+-\s+alpha/);
  assert.match(table.stdout, /pending=2/);
  assert.match(runCli(env, ["queue", "status", "99"]).stderr, /unknown job `99`/);
});

const MERGE_SHA = "d3605a5a4d7aaec342d649135cdbd128a042e29d";

// Marks a job as delivered with the URL of its pull request.
function deliver(env, id, prUrl = "https://github.com/acme/api/pull/42") {
  openDb(env).prepare("UPDATE jobs SET status = 'done', pr_url = ?, finished_at = ? WHERE id = ?").run(prUrl, "2026-09-10 10:00:00", id);
  return id;
}

// The same home with the fake `gh` in place of the real one and the pull request checks switched back on.
function withFakeGh(t, env, { state = "MERGED", sha = MERGE_SHA, mergeable } = {}) {
  const checked = { ...env, ...isolatedHostVars(makeDir(t, "cli-gh")), NIGHTSHIFT_FAKE_GH_PR_STATE: state, NIGHTSHIFT_FAKE_GH_PR_SHA: sha };
  if (mergeable) checked.NIGHTSHIFT_FAKE_GH_PR_MERGEABLE = mergeable;
  delete checked.NIGHTSHIFT_NO_PR_CHECK;
  return checked;
}

const CLOSE_SUGGESTION = "#1 PR merged - close it with nightshift queue close 1";

test("queue status never writes a delivered job whose pull request is merged: the row stays `done`, and it suggests the close", (t) => {
  const base = makeCliHome(t, "cli-status-merged");
  deliver(base, enqueue(base));
  const env = withFakeGh(t, base);

  const table = runCli(env, ["queue", "status"]);
  assert.equal(table.status, 0, table.stderr);
  assert.match(tableLine(table.stdout, 1), /^#1\s+✓ done\s+.*pull\/42 \(merged\)$/);
  assert.match(table.stdout, /done=1/);
  assert.match(table.stdout, /closed=0/);
  assert.ok(table.stdout.split("\n").includes(CLOSE_SUGGESTION), `the table did not suggest the close:\n${table.stdout}`);

  const payload = JSON.parse(runCli(env, ["queue", "status", "--json"]).stdout);
  assert.equal(payload.jobs[0].pr_state, "merged");
  assert.deepEqual(payload.suggestions, [CLOSE_SUGGESTION]);
  assert.equal(payload.counts.done, 1);
  assert.equal(payload.counts.merged, undefined, "the retired merged status is still counted");
  assert.equal("pr_checked_at" in payload.jobs[0], false);
  assert.equal("merged_at" in payload.jobs[0], false);
  assert.equal("merge_sha" in payload.jobs[0], false);

  const detail = runCli(env, ["queue", "status", "1"]);
  assert.equal(detail.status, 0, detail.stderr);
  assert.match(detail.stdout, /pr_state\s+merged/);
  assert.ok(detail.stdout.split("\n").includes(CLOSE_SUGGESTION), `the detail did not suggest the close:\n${detail.stdout}`);

  const row = getJob(1, env);
  assert.equal(row.status, "done");
  assert.equal("merged_at" in row, false, "the jobs row still carries the dropped merged_at column");
  assert.equal("merge_sha" in row, false, "the jobs row still carries the dropped merge_sha column");
});

test("a one-shot queue status behind a gh that hangs waits one overall deadline, prints `unknown` and exits", (t) => {
  const base = makeCliHome(t, "cli-status-gh-hangs");
  for (let n = 1; n <= 6; n += 1) deliver(base, enqueue(base, `job ${n}`), `https://github.com/acme/api/pull/${n}`);
  const env = { ...withFakeGh(t, base, { state: "OPEN" }), NIGHTSHIFT_FAKE_GH_SLEEP_MS: "8000" };

  const startedAt = Date.now();
  const table = runCli(env, ["queue", "status"]);
  const elapsedMs = Date.now() - startedAt;

  assert.equal(table.status, 0, table.stderr);
  assert.ok(elapsedMs < 5000 + 2500, `the one-shot waited ${elapsedMs}ms for a gh that hangs`);
  for (let id = 1; id <= 6; id += 1) {
    assert.match(tableLine(table.stdout, id), /pull\/\d+ \(unknown\)$/, `job #${id} did not print as unknown`);
  }
});

test("an open pull request gh cannot tell is mergeable reads `unknown`, and a conflicting one reads `conflicted`", (t) => {
  const base = makeCliHome(t, "cli-status-pr-state");
  deliver(base, enqueue(base));
  for (const [mergeable, expected] of [["UNKNOWN", "unknown"], ["CONFLICTING", "conflicted"]]) {
    const env = withFakeGh(t, base, { state: "OPEN", mergeable });
    const payload = JSON.parse(runCli(env, ["queue", "status", "--json"]).stdout);
    assert.equal(payload.jobs[0].pr_state, expected, mergeable);
    assert.deepEqual(payload.suggestions, [], `${mergeable} suggested a close`);
  }
});

test("a gh that cannot answer leaves the job delivered and still exits 0", (t) => {
  const base = makeCliHome(t, "cli-status-merged-fail-open");
  deliver(base, enqueue(base));
  const env = withFakeGh(t, base, { state: "" });
  env.NIGHTSHIFT_GH_BIN = join(makeDir(t, "cli-gh-missing"), "gh");

  const table = runCli(env, ["queue", "status"]);
  assert.equal(table.status, 0, table.stderr);
  assert.match(tableLine(table.stdout, 1), /^#1\s+✓ done\s+/);
  assert.match(table.stdout, /done=1/);
  assert.equal(table.stderr, "", `queue status printed on stderr: ${table.stderr}`);
  assert.equal(getJob(1, env).status, "done");
});

test("a closed job is terminal for cancel and for retry, and retry still takes a failed one", (t) => {
  const env = makeCliHome(t, "cli-closed-terminal");
  const closed = deliver(env, enqueue(env));
  assert.equal(runCli(env, ["queue", "close", String(closed)]).status, 0);

  const cancelled = runCli(env, ["queue", "cancel", String(closed)]);
  assert.equal(cancelled.status, 1);
  assert.match(cancelled.stderr, /already finished with status `closed`/);

  const retried = runCli(env, ["queue", "retry", String(closed)]);
  assert.equal(retried.status, 1);
  assert.match(retried.stderr, /cannot be retried from status `closed`/);
  assert.equal(getJob(closed, env).status, "closed");

  const failed = enqueue(env, "fix the parser");
  openDb(env).prepare("UPDATE jobs SET status = 'failed' WHERE id = ?").run(failed);
  assert.equal(runCli(env, ["queue", "retry", String(failed)]).status, 0);
  assert.equal(getJob(failed, env).status, "pending");
});

test("queue close closes a done job, prints it, answers --json, and refuses a pending one naming its status (exit 1)", (t) => {
  const env = makeCliHome(t, "cli-close");
  const first = deliver(env, enqueue(env));
  const second = deliver(env, enqueue(env, "fix the parser"), "https://github.com/acme/api/pull/43");
  const pending = enqueue(env, "fix the runner");

  const closed = runCli(env, ["queue", "close", String(first)]);
  assert.equal(closed.status, 0, closed.stderr);
  assert.match(closed.stdout, new RegExp(`closed job #${first}`));
  assert.equal(getJob(first, env).status, "closed");
  assert.equal(getJob(first, env).pr_url, "https://github.com/acme/api/pull/42");

  const json = runCli(env, ["queue", "close", String(second), "--json"]);
  assert.equal(json.status, 0, json.stderr);
  const payload = JSON.parse(json.stdout);
  assert.equal(payload.refused.length, 0);
  const [job] = payload.closed;
  assert.deepEqual({ id: job.id, status: job.status, pr_url: job.pr_url }, { id: second, status: "closed", pr_url: "https://github.com/acme/api/pull/43" });

  const refused = runCli(env, ["queue", "close", String(pending)]);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /is pending; the queue still owes work for it/);
  assert.equal(getJob(pending, env).status, "pending");
  assert.match(runCli(env, ["queue", "close"]).stderr, /missing argument; usage: nightshift queue close <id>/);
});

test("queue close takes several ids, closes what it can and reports the rest, in text and in --json", (t) => {
  const env = makeCliHome(t, "cli-close-many");
  const first = deliver(env, enqueue(env));
  const second = deliver(env, enqueue(env, "fix the parser"), "https://github.com/acme/api/pull/43");
  const pending = enqueue(env, "fix the runner");

  const text = runCli(env, ["queue", "close", String(first), String(second), String(pending), "99"]);
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, new RegExp(`closed job #${first}`));
  assert.match(text.stdout, new RegExp(`closed job #${second}`));
  assert.match(text.stdout, new RegExp(`job #${pending} not closed: job \`${pending}\` is pending; the queue still owes work for it`));
  assert.match(text.stdout, /job #99 not closed: unknown job `99`/);
  assert.equal(getJob(first, env).status, "closed");
  assert.equal(getJob(second, env).status, "closed");

  const third = deliver(env, enqueue(env, "fix the runner"), "https://github.com/acme/api/pull/44");
  const stillPending = enqueue(env, "fix the queue");
  const json = runCli(env, ["queue", "close", String(third), String(stillPending), "--json"]);
  assert.equal(json.status, 0, json.stderr);
  const payload = JSON.parse(json.stdout);
  assert.deepEqual(payload.closed.map((job) => job.id), [third]);
  assert.deepEqual(payload.refused, [{ id: stillPending, reason: `job \`${stillPending}\` is pending; the queue still owes work for it` }]);

  const everyRefused = runCli(env, ["queue", "close", String(stillPending)]);
  assert.equal(everyRefused.status, 1, "closing nothing must still fail like a refused command");
  assert.match(everyRefused.stderr, /is pending; the queue still owes work for it/);
});

test("`queue add --tier` records the tier, `queue status` shows it, and an unknown value queues nothing", (t) => {
  const env = makeCliHome(t, "cli-add-tier");
  const repo = projectPath(env);

  const added = runCli(env, ["queue", "add", "--tier", "simple", "fix the worker"], { cwd: repo });
  assert.equal(added.status, 0, added.stderr);
  assert.equal(getJob(1, env).tier, "simple");
  assert.equal(JSON.parse(runCli(env, ["queue", "status", "1", "--json"]).stdout).job.tier, "simple");
  assert.match(runCli(env, ["queue", "status", "1"]).stdout, /tier\s+simple/);

  runCli(env, ["queue", "add", "fix the parser"], { cwd: repo });
  assert.equal(JSON.parse(runCli(env, ["queue", "status", "2", "--json"]).stdout).job.tier, null);
  assert.equal(
    runCli(env, ["queue", "status", "2"]).stdout.includes("tier"),
    false,
    "the detail of a job with no tier printed a tier line",
  );

  const unknown = runCli(env, ["queue", "add", "--tier", "urgent", "fix the uploader"], { cwd: repo });
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /invalid `tier`: `urgent`; expected one of trivial\|simple\|complex/);
  assert.equal(getJob(3, env), null, "the refused tier still queued a job");

  const dangling = runCli(env, ["queue", "add", "fix the uploader", "--tier"], { cwd: repo });
  assert.equal(dangling.status, 1);
  assert.equal(getJob(3, env), null, "a `--tier` with no value still queued a job");
});

// The last line the CLI printed, the place the backlog nudge belongs to.
function lastLine(stdout) {
  const lines = stdout.trimEnd().split("\n");
  return lines[lines.length - 1];
}

test("queue status closes with the backlog nudge only when pending jobs sit with nobody working them", (t) => {
  const env = makeCliHome(t, "cli-status-backlog");
  const first = enqueue(env, "fix the worker");
  const one = runCli(env, ["queue", "status"]);
  assert.equal(one.status, 0, one.stderr);
  assert.equal(lastLine(one.stdout), "1 pending job waiting - start the batch: nightshift queue run");

  enqueue(env, "fix the parser");
  const two = runCli(env, ["queue", "status"]);
  assert.equal(lastLine(two.stdout), "2 pending jobs waiting - start the batch: nightshift queue run");
  assert.ok(
    two.stdout.indexOf("pending=2") < two.stdout.indexOf("2 pending jobs waiting"),
    "the nudge has to come after the counts",
  );

  claimJobById(first, { worker: "host:4242", cap: 4 }, env);
  const claimed = runCli(env, ["queue", "status"]);
  assert.equal(claimed.stdout.includes("start the batch"), false, "the nudge showed up while a job was running");

  const watched = makeCliHome(t, "cli-status-backlog-watched");
  enqueue(watched, "fix the worker");
  writeRunnerRecord({ pid: process.pid, startedAt: new Date().toISOString(), mode: "watch", intervalS: 30, logPath: "/tmp/a.log" }, watched);
  const alive = runCli(watched, ["queue", "status"]);
  assert.equal(alive.stdout.includes("start the batch"), false, "the nudge showed up while a watcher was alive");

  const empty = runCli(makeCliHome(t, "cli-status-backlog-empty"), ["queue", "status"]);
  assert.equal(empty.stdout.includes("start the batch"), false, "an empty queue got a nudge");
});

// Parks a pending job on the instant a rate limit resets, the way a runner that hit the limit leaves it behind before it exits.
function parkOnRateLimit(env, id, notBefore) {
  claimJobById(id, { worker: "host:4242", cap: 4 }, env);
  const parked = parkJob(id, { worker: "host:4242", notBefore, result: { rateLimited: true, notBefore } }, env);
  assert.equal(parked, true, `the fixture did not park job #${id}`);
}

test("a backlog parked by a rate limit says when it becomes claimable, instead of asking for a batch that would claim nothing", (t) => {
  const env = makeCliHome(t, "cli-status-parked");
  const parked = enqueue(env, "fix the worker");
  const notBefore = new Date(Date.now() + 3600_000).toISOString();
  parkOnRateLimit(env, parked, notBefore);

  const status = runCli(env, ["queue", "status"]);

  assert.equal(status.status, 0, status.stderr);
  assert.equal(status.stdout.split("\n")[0], "0 runners online - pending jobs will wait until `nightshift queue run` starts one", "the fixture left a live runner behind, so the nudge is not the one under test");
  assert.equal(
    lastLine(status.stdout),
    `1 pending job waiting - the rate limit resets at ${clockLabel(Date.parse(notBefore))} (in 1h00); a batch started now claims nothing before that`,
  );
  assert.match(tableLine(status.stdout, parked), /⏸ rate limit until /, "the row of a parked job reads exactly like an ordinary pending one");

  enqueue(env, "fix the parser");
  const mixed = runCli(env, ["queue", "status"]);
  assert.equal(
    lastLine(mixed.stdout),
    "2 pending jobs waiting - start the batch: nightshift queue run",
    "a job that could be claimed right now was held back by the park of another one",
  );
});

// Writes the log of a job, the file `queue status` reads the last narration from.
function writeJobLog(env, id, texts) {
  const path = jobLogPath(id, env);
  mkdirSync(dirname(path), { recursive: true });
  const events = texts.map((text) => JSON.stringify(assistantEvent(text)));
  writeFileSync(path, [`=== attempt 1 @ ${new Date().toISOString()} ===`, ...events, ""].join("\n"));
}

// The line of the table of `queue status` that belongs to a job.
function tableLine(stdout, id) {
  return stdout.split("\n").find((line) => line.startsWith(`#${id} `)) ?? "";
}

test("queue status shows the elapsed time and the last narration of a running job, and never breaks without a log", (t) => {
  const env = makeCliHome(t, "cli-status-running");
  makeGitProject(t, env, "beta");
  const narrating = enqueue(env, "fix the worker");
  const silent = addJob({ project: "beta", prompt: "fix the parser" }, env).id;
  const finished = enqueue(env, "fix the docs");
  claimJobById(narrating, { worker: "host:4242", cap: 4 }, env);
  claimJobById(silent, { worker: "host:4243", cap: 4 }, env);
  assert.equal(runCli(env, ["queue", "cancel", String(finished)]).status, 0);
  writeJobLog(env, narrating, ["Reading the runner and its tests.", "Opening the pull request now, and this sentence is long enough to be clipped by the table."]);

  const table = runCli(env, ["queue", "status"]);
  assert.equal(table.status, 0, table.stderr);

  const live = tableLine(table.stdout, narrating);
  assert.match(live, /^#1\s+● running\s+\d+s\s+-\s+alpha\s+» Opening the pull request now,/);
  assert.equal(live.includes("Reading the runner"), false, "the table showed an older narration than the last one");
  assert.equal(live.includes("clipped by the table"), false, "the table printed the whole narration instead of a short one");
  assert.ok(live.includes("... "), `the long narration was not clipped: ${live}`);

  const noLog = tableLine(table.stdout, silent);
  assert.match(noLog, /^#2\s+● running\s+\d+s\s+-\s+beta\s+-\s+-$/);
  assert.equal(existsSync(jobLogPath(silent, env)), false, "the job without a log had one");

  assert.match(tableLine(table.stdout, finished), /^#3\s+⊘ cancelled\s+-\s+-\s+alpha\s+-\s+-$/, "a job in a final state changed shape");
  assert.match(table.stdout, /^ID\s+STATUS\s+DURATION\s+TOKENS\s+PROJECT\s+SLUG\/LAST\s+PR$/m, "the table has no header");
  assert.equal(/\u001b\[/.test(table.stdout), false, "a piped table carried ANSI color");
  assert.match(table.stdout, /running=2/);
});

test("queue status keeps the shape of its json when a job is running with a log", (t) => {
  const env = makeCliHome(t, "cli-status-running-json");
  const id = enqueue(env);
  claimJobById(id, { worker: "host:4242", cap: 4 }, env);
  writeJobLog(env, id, ["Opening the pull request now."]);
  const payload = JSON.parse(runCli(env, ["queue", "status", "--json"]).stdout);
  assert.equal(payload.jobs[0].status, "running");
  assert.equal("prompt" in payload.jobs[0], false, "the CLI printed the prompt of a job");
  assert.deepEqual(payload.counts, { pending: 0, running: 1, done: 0, gate: 0, failed: 0, cancelled: 0, closed: 0 });
});

test("a log that cannot be read leaves the row of a running job without a narration, never without a table", (t) => {
  const env = makeCliHome(t, "cli-status-unreadable-log");
  const id = enqueue(env);
  claimJobById(id, { worker: "host:4242", cap: 4 }, env);
  mkdirSync(jobLogPath(id, env), { recursive: true });
  const table = runCli(env, ["queue", "status"]);
  assert.equal(table.status, 0, table.stderr);
  assert.match(tableLine(table.stdout, id), /^#1\s+● running\s+\d+s\s+-\s+alpha\s+-\s+-$/);
  assert.match(table.stdout, /running=1/);
});

test("the queue runs a job end to end: add, run, status and log", (t) => {
  const env = makeCliHome(t, "cli-smoke");
  assert.equal(runCli(env, ["queue", "add", "alpha", "fix the worker"]).status, 0);

  const ran = runCli(env, ["queue", "run", "--job", "1", "--foreground"]);
  assert.equal(ran.status, 0, ran.stderr);
  assert.match(ran.stdout, /job #1 done https:\/\/github\.com\/acme\/api\/pull\/42/);

  const job = JSON.parse(runCli(env, ["queue", "status", "1", "--json"]).stdout).job;
  assert.deepEqual({ status: job.status, pr: job.pr_url, slug: job.slug }, { status: "done", pr: PR_URL, slug: SLUG });
  assert.ok(job.notice_md, "the finished job kept no notice");

  const log = runCli(env, ["queue", "log", "1"]);
  assert.equal(log.status, 0, log.stderr);
  assert.match(log.stdout, /═ attempt 1/);
  assert.match(log.stdout, /» Opening the pull request now\./);
  assert.match(log.stdout, new RegExp(`⚑ slug: ${SLUG}`));
  assert.match(log.stdout, /✓ pull request: https:\/\/github\.com\/acme\/api\/pull\/42/);
  assert.match(log.stdout, /═ result: success/);
  assert.equal(log.stdout.includes('"type":"result"'), false, "the narration printed the raw stream");
  assert.equal(log.stdout.includes("\u001b["), false, "the narration coloured an output that is not a terminal");

  const raw = runCli(env, ["queue", "log", "1", "--raw"]);
  assert.equal(raw.status, 0, raw.stderr);
  assert.match(raw.stdout, /=== attempt 1 @ /);
  assert.match(raw.stdout, /"type":"result"/);
  assert.equal(raw.stdout, `${readFileSync(jobLogPath(1, env), "utf8").replace(/\n$/, "")}\n`, "--raw is not the log byte for byte");

  assert.match(runCli(env, ["queue", "log", "1", "--raw", "--all"]).stderr, /`--all` has no meaning with `--raw`/);
  assert.match(runCli(env, ["queue", "log", "2"]).stderr, /no log for job `2`/);
});

test("a log that is there but cannot be read is a message and an exit code of 1, never a stack trace", (t) => {
  const env = makeCliHome(t, "cli-log-unreadable");
  enqueue(env);
  mkdirSync(jobLogPath(1, env), { recursive: true });
  for (const args of [["queue", "log", "1"], ["queue", "log", "1", "--raw"]]) {
    const result = runCli(env, args);
    assert.equal(result.status, 1, `\`${args.join(" ")}\` did not exit 1: ${result.stderr}`);
    assert.match(result.stderr, /nightshift: could not read the log at /);
    assert.equal(result.stderr.includes("\n    at "), false, `\`${args.join(" ")}\` printed a stack trace`);
  }
});

test("queue run --dry only reports, and pause stops the claiming until resume", (t) => {
  const env = makeCliHome(t, "cli-pause");
  const id = enqueue(env);

  const dry = JSON.parse(runCli(env, ["queue", "run", "--dry", "--json"]).stdout);
  assert.deepEqual(
    { dry: dry.dry, next: dry.next, active: dry.active, paused: dry.paused, heartbeatS: dry.heartbeatS },
    { dry: true, next: id, active: 0, paused: false, heartbeatS: 5 },
  );
  assert.deepEqual({ pausedUntil: dry.pausedUntil, rateLimit: dry.rateLimit }, { pausedUntil: null, rateLimit: null }, "a home where no runner waits out a limit reported one");
  const report = runCli(env, ["queue", "run", "--dry"]).stdout;
  assert.match(report, /heartbeat {7}5s/, "the operator cannot see the heartbeat it can tune");
  assert.match(report, /^rate limit {6}-$/m, "the dry report is silent about the rate limit it read");
  assert.equal(getJob(id, env).status, "pending");

  assert.equal(runCli(env, ["queue", "pause"]).status, 0);
  assert.equal(existsSync(queuePausedPath(env)), true);
  assert.match(runCli(env, ["queue", "run", "--foreground"]).stdout, /the queue is paused - nothing will be claimed; resume with: nightshift queue resume/);
  assert.equal(getJob(id, env).status, "pending");

  assert.equal(runCli(env, ["queue", "resume"]).status, 0);
  assert.equal(existsSync(queuePausedPath(env)), false);
  assert.ok(Number.isFinite(Date.parse(readFileSync(queueResumePath(env), "utf8").trim())), "the resume left no instant a runner waiting out a rate limit could compare its pause against");
  assert.match(runCli(env, ["queue", "run", "--foreground"]).stdout, /job #1 done/);
});

test("queue run --dry tells the operator that a live runner of this home is waiting out a rate limit", (t) => {
  const env = makeCliHome(t, "cli-dry-rate-limit");
  const id = enqueue(env);
  const resetsAt = new Date(Date.now() + 3600_000);
  writeRunnerRecord({ pid: process.pid, startedAt: new Date().toISOString(), mode: "watch", intervalS: 30, rateLimit: pauseRegion(resetsAt) }, env);

  const dry = JSON.parse(runCli(env, ["queue", "run", "--dry", "--json"]).stdout);

  assert.deepEqual(
    { paused: dry.paused, next: dry.next, pausedUntil: dry.pausedUntil, rateLimit: dry.rateLimit },
    {
      paused: false,
      next: id,
      pausedUntil: new Date(resetsAt.getTime() + 60_000).toISOString(),
      rateLimit: { type: "five_hour", resetsAt: resetsAt.toISOString(), utilization: 0.99 },
    },
    "`--dry --json` answered that nothing holds a claim back while a runner waits out a limit",
  );
  assert.match(
    runCli(env, ["queue", "run", "--dry"]).stdout,
    new RegExp(`^rate limit {6}paused until ${clockLabel(resetsAt.getTime())} \\(5h limit, resets in 1h00\\)$`, "m"),
    "the dry report named the next job without a word about the limit it would wait for",
  );
});

test("queue status leads with the rate limit a runner is waiting out, and never tells the operator to start a batch beside it", (t) => {
  const env = makeCliHome(t, "cli-status-rate-limit");
  enqueue(env);
  const startedAt = new Date().toISOString();
  const resetsAt = new Date(Date.now() + 3600_000);
  const record = { pid: process.pid, startedAt, mode: "watch", intervalS: 30, logPath: "/tmp/a.log", detached: true };
  writeRunnerRecord(record, env);

  const running = runCli(env, ["queue", "status"]);
  assert.equal(running.stdout.split("\n")[0], "1 runner online");
  assert.equal(running.stdout.split("\n")[1], `runner: running (pid ${process.pid}, watch every 30 s, since ${startedAt})`);
  assert.equal(lastLine(running.stdout).includes("start the batch"), false, "a live runner still got the nudge to start another one");

  writeRunnerRecord({ ...record, rateLimit: pauseRegion(resetsAt) }, env);
  const paused = runCli(env, ["queue", "status"]);
  const clock = clockLabel(resetsAt.getTime());

  assert.equal(paused.status, 0, paused.stderr);
  assert.equal(paused.stdout.split("\n")[0], "1 runner online", "the count line no longer opens the listing when the runner is paused");
  assert.equal(paused.stdout.split("\n")[1], `runner: paused until ${clock} (5h limit, resets in 1h00) (pid ${process.pid}, watch every 30 s, since ${startedAt})`);
  assert.equal(lastLine(paused.stdout), `1 pending job waiting - the runner is paused until ${clock} (5h limit, resets in 1h00)`);

  const json = JSON.parse(runCli(env, ["queue", "status", "--json"]).stdout);
  assert.deepEqual(json.runner.rateLimit, { type: "five_hour", resetsAt: resetsAt.toISOString(), utilization: 0.99 });
  assert.equal(json.runner.pausedUntil, new Date(resetsAt.getTime() + 60_000).toISOString());
});

test("queue status shows a watch runner's window before it opens, and the backlog names the wait for it", (t) => {
  const env = makeCliHome(t, "cli-status-window-before");
  enqueue(env);
  const startedAt = new Date().toISOString();
  const fromMs = Date.now() + (3 * 60 + 12) * 60_000;
  const untilMs = fromMs + 6 * 3600_000;
  const window = { from: new Date(fromMs).toISOString(), until: new Date(untilMs).toISOString() };
  writeRunnerRecord({ pid: process.pid, startedAt, mode: "watch", intervalS: 30, window }, env);

  const status = runCli(env, ["queue", "status"]);

  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout.split("\n")[1], /watch every 30 s · window \d{2}:\d{2}-\d{2}:\d{2} · opens in 3h12/, status.stdout);
  assert.equal(lastLine(status.stdout), `1 pending job waiting - 1 runner waiting for its window (opens ${clockLabel(fromMs)})`);
});

test("a runner already inside its window shows a countdown to close, and still promises pickup with no backlog wait", (t) => {
  const env = makeCliHome(t, "cli-status-window-inside");
  enqueue(env);
  const startedAt = new Date().toISOString();
  const fromMs = Date.now() - 3600_000;
  const untilMs = Date.now() + (5 * 60 + 40) * 60_000;
  const window = { from: new Date(fromMs).toISOString(), until: new Date(untilMs).toISOString() };
  writeRunnerRecord({ pid: process.pid, startedAt, mode: "watch", intervalS: 30, window }, env);

  const status = runCli(env, ["queue", "status"]);

  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout.split("\n")[1], /watch every 30 s · window \d{2}:\d{2}-\d{2}:\d{2} · closes in 5h40/, status.stdout);
  assert.equal(lastLine(status.stdout).includes("waiting for its window"), false, "a runner already inside its window still reported a wait for it");
});

test("a runner both paused and waiting for its window is reported as paused - the nearer, harder fact wins", (t) => {
  const env = makeCliHome(t, "cli-status-window-and-paused");
  enqueue(env);
  const startedAt = new Date().toISOString();
  const resetsAt = new Date(Date.now() + 3600_000);
  const fromMs = Date.now() + 7200_000;
  const window = { from: new Date(fromMs).toISOString(), until: new Date(fromMs + 3600_000).toISOString() };
  writeRunnerRecord({ pid: process.pid, startedAt, mode: "watch", intervalS: 30, window, rateLimit: pauseRegion(resetsAt) }, env);

  const status = runCli(env, ["queue", "status"]);

  assert.equal(status.status, 0, status.stderr);
  assert.equal(lastLine(status.stdout), `1 pending job waiting - the runner is paused until ${clockLabel(resetsAt.getTime())} (5h limit, resets in 1h00)`);
  assert.equal(lastLine(status.stdout).includes("waiting for its window"), false, "the window wait was reported over the nearer rate-limit pause");
});

test("queue cancel takes a pending job and refuses one that is running under a live lease", (t) => {
  const env = makeCliHome(t, "cli-cancel");
  const pending = enqueue(env, "fix the worker");
  const running = enqueue(env, "fix the parser");
  claimJobById(running, { worker: "host:4242", cap: 4 }, env);

  const refused = runCli(env, ["queue", "cancel", String(running)]);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /is running with a live lease on worker `host:4242`/);
  assert.equal(getJob(running, env).status, "running");

  const cancelled = runCli(env, ["queue", "cancel", String(pending), "--reason", "no longer needed"]);
  assert.equal(cancelled.status, 0, cancelled.stderr);
  assert.match(cancelled.stdout, /cancelled job #1/);
  assert.equal(getJob(pending, env).status, "cancelled");
  assert.match(runCli(env, ["queue", "cancel", "99"]).stderr, /unknown job `99`/);
});

test("queue cancel closes a gated job and the status still shows it with its note", (t) => {
  const env = makeCliHome(t, "cli-cancel-gate", [{ stdout: gateStream(), exitCode: 0 }]);
  const gated = runCli(env, ["queue", "add", "alpha", "fix the worker", "--run", "--foreground"]);
  assert.equal(gated.status, 1, gated.stdout);
  assert.equal(getJob(1, env).status, "gate");
  const finishedAt = getJob(1, env).finished_at;

  const cancelled = runCli(env, ["queue", "cancel", "1", "--reason", "the human said no"]);
  assert.equal(cancelled.status, 0, cancelled.stderr);
  assert.match(cancelled.stdout, /cancelled job #1/);

  const row = getJob(1, env);
  assert.equal(row.status, "cancelled");
  assert.equal(row.finished_at, finishedAt, "the cancel overwrote the finish of the gated run");
  assert.equal(row.operator_note, "the human said no");
  assert.equal(JSON.parse(row.result).cancelledFrom, "gate");

  const status = runCli(env, ["queue", "status", "1"]);
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /status\s+cancelled/);
  assert.match(status.stdout, /operator_note\s+the human said no/);
});

test("queue status of a gated job spells the reason out and says how to answer it", (t) => {
  const env = makeCliHome(t, "cli-status-notice", [{ stdout: gateStream(), exitCode: 0 }]);
  assert.equal(runCli(env, ["queue", "add", "alpha", "fix the worker", "--run", "--foreground"]).status, 1);
  assert.equal(getJob(1, env).status, "gate");

  const status = runCli(env, ["queue", "status", "1"]);
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /status\s+gate/);
  assert.match(status.stdout, /^notice$/m);
  assert.match(status.stdout, /^ {2}## Requires user confirmation$/m);
  assert.match(status.stdout, /retry it with: nightshift queue retry 1 --note "<your answer>"/);
  assert.equal(status.stdout.includes("notice_md       "), false, "the notice was dumped as a field of the generic block");

  const json = runCli(env, ["queue", "status", "1", "--json"]);
  assert.equal(json.status, 0, json.stderr);
  assert.equal(JSON.parse(json.stdout).job.notice_md, GATE_NOTICE);
});

test("queue status of one job also shows the run's own notice, whole, whenever it differs from the row's", (t) => {
  const env = makeCliHome(t, "cli-status-run-notice", [{ stdout: doneStream({ notice: "the run's real notice, kept whole" }), exitCode: 0 }]);
  assert.equal(runCli(env, ["queue", "add", "alpha", "fix the worker", "--run", "--foreground"]).status, 0);
  assert.equal(getJob(1, env).status, "done");

  openDb(env).prepare("UPDATE jobs SET notice_md = ? WHERE id = ?").run("a stale summary the row kept", 1);

  const status = runCli(env, ["queue", "status", "1"]);
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /^notice$/m);
  assert.match(status.stdout, /^ {2}a stale summary the row kept$/m);
  assert.match(status.stdout, /^run_notice$/m);
  assert.match(status.stdout, /^ {2}the run's real notice, kept whole$/m);
  assert.equal(status.stdout.includes("run_notice      "), false, "the run's own notice was dumped as a field of the generic block");

  const json = runCli(env, ["queue", "status", "1", "--json"]);
  const job = JSON.parse(json.stdout).job;
  assert.equal(job.notice_md, "a stale summary the row kept");
  assert.equal(job.run_notice, "the run's real notice, kept whole");
});

test("queue retry refuses a gated job without --note, printing why the job is waiting", (t) => {
  const env = makeCliHome(t, "cli-retry-refusal", [{ stdout: gateStream(), exitCode: 0 }]);
  assert.equal(runCli(env, ["queue", "add", "alpha", "fix the worker", "--run", "--foreground"]).status, 1);

  const refused = runCli(env, ["queue", "retry", "1"]);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /## Requires user confirmation/);
  assert.match(refused.stderr, /This job is waiting for a decision\. Re-run with --note "<your answer>"\./);
  assert.equal(getJob(1, env).status, "gate", "the refused retry moved the job anyway");
});

test("queue retry answers the gate, sends the job back to the queue and keeps what makes it resume", (t) => {
  const env = makeCliHome(t, "cli-retry-gate", [{ stdout: gateStream(), exitCode: 0 }]);
  assert.equal(runCli(env, ["queue", "add", "alpha", "fix the worker", "--run", "--foreground"]).status, 1);
  const gated = getJob(1, env);

  const retried = runCli(env, ["queue", "retry", "1", "--note", "rename the column"]);
  assert.equal(retried.status, 0, retried.stderr);
  assert.match(retried.stdout, /job #1 is pending again$/m);

  const row = getJob(1, env);
  assert.equal(row.status, "pending");
  assert.equal(row.operator_note, "rename the column");
  assert.equal(row.slug, gated.slug);
  assert.equal(row.finished_at, null);
  assert.equal(JSON.parse(row.result).retriedFrom, "gate");
});

test("queue retry --fresh starts from phase 0 and drops the run directory of the previous attempt", (t) => {
  const env = makeCliHome(t, "cli-retry-fresh", [{ stdout: gateStream(), exitCode: 0 }]);
  assert.equal(runCli(env, ["queue", "add", "alpha", "fix the worker", "--run", "--foreground"]).status, 1);
  const dir = runDir("alpha", getJob(1, env).slug, env);
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}/01-triage.md`, "triage\n");

  const retried = runCli(env, ["queue", "retry", "1", "--note", "start over", "--fresh"]);
  assert.equal(retried.status, 0, retried.stderr);
  assert.match(retried.stdout, /job #1 is pending again, starting from phase 0/);
  assert.equal(existsSync(dir), false);
  assert.equal(getJob(1, env).slug, null);
});

test("queue retry --run --foreground takes the job through the runner in this process", (t) => {
  const env = makeCliHome(t, "cli-retry-run", [
    { stdout: gateStream(), exitCode: 0 },
    { stdout: doneStream(), exitCode: 0 },
  ]);
  assert.equal(runCli(env, ["queue", "add", "alpha", "fix the worker", "--run", "--foreground"]).status, 1);

  const retried = runCli(env, ["queue", "retry", "1", "--note", "go on", "--run", "--foreground"]);
  assert.equal(retried.status, 0, `${retried.stdout}\n${retried.stderr}`);
  assert.match(retried.stdout, /running job #1 in the foreground/);
  assert.equal(getJob(1, env).status, "done");
});

test("queue log narrates the reason of a gate even when the stream never printed a notice", (t) => {
  const env = makeCliHome(t, "cli-retry-log-notice");
  const id = enqueue(env);
  mkdirSync(dirname(jobLogPath(id, env)), { recursive: true });
  writeFileSync(jobLogPath(id, env), `${JSON.stringify(assistantEvent("working on it"))}\n`);
  openDb(env).prepare("UPDATE jobs SET status = 'gate', notice_md = ? WHERE id = ?").run("Rename the column or keep both?", id);

  const log = runCli(env, ["queue", "log", String(id)]);
  assert.equal(log.status, 0, log.stderr);
  assert.match(log.stdout, /ℹ notice/);
  assert.match(log.stdout, /Rename the column or keep both\?/);
});

// Code points the narration of `queue log` prints of a notice before cutting it.
const NARRATED_NOTICE_LIMIT = 400;

// A long notice, so every surface that cuts it has something to cut.
const LONG_NOTICE = "Decide between renaming the column and keeping both. ".repeat(12);

// A gated job whose reason lives only in its row, the shape `printJobNotice` reads.
function gatedJobWithNotice(env, notice) {
  const id = enqueue(env);
  mkdirSync(dirname(jobLogPath(id, env)), { recursive: true });
  writeFileSync(jobLogPath(id, env), `${JSON.stringify(assistantEvent("working on it"))}\n`);
  openDb(env).prepare("UPDATE jobs SET status = 'gate', notice_md = ? WHERE id = ?").run(notice, id);
  return id;
}

test("queue log says where the whole notice is read when it had to cut it", (t) => {
  const env = makeCliHome(t, "cli-log-notice-pointer");
  const id = gatedJobWithNotice(env, LONG_NOTICE);

  const log = runCli(env, ["queue", "log", String(id)]);
  assert.equal(log.status, 0, log.stderr);
  assert.match(log.stdout, /ℹ notice/);
  assert.ok(log.stdout.includes(`    ${Array.from(LONG_NOTICE).slice(0, NARRATED_NOTICE_LIMIT).join("")}...`), log.stdout);
  assert.match(log.stdout, new RegExp(`^ {4}read the whole notice with: nightshift queue status ${id}$`, "m"));
});

test("a notice between the two limits is cut once, by the narration, and only then points at the detail", (t) => {
  const env = makeCliHome(t, "cli-log-notice-once");
  const notice = "b".repeat(450);
  const id = gatedJobWithNotice(env, notice);

  const log = runCli(env, ["queue", "log", String(id)]);
  assert.equal(log.status, 0, log.stderr);
  assert.ok(log.stdout.includes(`    ${"b".repeat(NARRATED_NOTICE_LIMIT)}...`), log.stdout);
  assert.equal(log.stdout.includes("b".repeat(NARRATED_NOTICE_LIMIT + 1)), false, "the notice was cut somewhere other than the narration");
  assert.match(log.stdout, new RegExp(`^ {4}read the whole notice with: nightshift queue status ${id}$`, "m"));
});

test("a notice short enough to be narrated whole is never followed by a pointer", (t) => {
  const env = makeCliHome(t, "cli-log-notice-short");
  const id = gatedJobWithNotice(env, "Rename the column or keep both?");

  const log = runCli(env, ["queue", "log", String(id)]);
  assert.equal(log.status, 0, log.stderr);
  assert.match(log.stdout, /^ {4}Rename the column or keep both\?$/m);
  assert.equal(log.stdout.includes("read the whole notice"), false, log.stdout);
});

test("queue status of a job prints the whole notice, on the text and on --json", (t) => {
  const env = makeCliHome(t, "cli-status-notice-whole");
  const id = gatedJobWithNotice(env, LONG_NOTICE);

  const status = runCli(env, ["queue", "status", String(id)]);
  assert.equal(status.status, 0, status.stderr);
  assert.ok(status.stdout.includes(`  ${LONG_NOTICE}`), status.stdout);
  assert.equal(status.stdout.includes("..."), false, "the detail of a job cut the notice");

  const json = runCli(env, ["queue", "status", String(id), "--json"]);
  assert.equal(json.status, 0, json.stderr);
  assert.equal(JSON.parse(json.stdout).job.notice_md, LONG_NOTICE, "the JSON detail carries a prefix of the notice instead of the whole text");
});

test("queue status of a job shows a host-command counter only when it is not zero, on the text and on --json", (t) => {
  const env = makeCliHome(t, "cli-status-host-commands");
  const zero = enqueue(env, "never timed out");
  const some = enqueue(env, "timed out and got killed");
  openDb(env).prepare("UPDATE jobs SET status = 'done', bash_timeouts = 0, tasks_backgrounded = 0, tasks_killed = 0 WHERE id = ?").run(zero);
  openDb(env).prepare("UPDATE jobs SET status = 'done', bash_timeouts = 2, tasks_backgrounded = 0, tasks_killed = 1 WHERE id = ?").run(some);

  const zeroStatus = runCli(env, ["queue", "status", String(zero)]);
  assert.equal(zeroStatus.status, 0, zeroStatus.stderr);
  assert.equal(zeroStatus.stdout.includes("bash_timeouts"), false, zeroStatus.stdout);
  assert.equal(zeroStatus.stdout.includes("tasks_backgrounded"), false, zeroStatus.stdout);
  assert.equal(zeroStatus.stdout.includes("tasks_killed"), false, zeroStatus.stdout);

  const someStatus = runCli(env, ["queue", "status", String(some)]);
  assert.equal(someStatus.status, 0, someStatus.stderr);
  assert.match(someStatus.stdout, /^bash_timeouts {3}2$/m);
  assert.match(someStatus.stdout, /^tasks_killed {4}1$/m);
  assert.equal(someStatus.stdout.includes("tasks_backgrounded"), false, someStatus.stdout);

  const zeroJson = JSON.parse(runCli(env, ["queue", "status", String(zero), "--json"]).stdout).job;
  assert.equal(zeroJson.bash_timeouts, null);
  assert.equal(zeroJson.tasks_backgrounded, null);
  assert.equal(zeroJson.tasks_killed, null);

  const someJson = JSON.parse(runCli(env, ["queue", "status", String(some), "--json"]).stdout).job;
  assert.equal(someJson.bash_timeouts, 2);
  assert.equal(someJson.tasks_backgrounded, null);
  assert.equal(someJson.tasks_killed, 1);
});

// A gate notice near the size of a real multi-point confirmation block: the heading, eight bullet points and the answer line.
function bigGateNotice(id) {
  const points = Array.from(
    { length: 8 },
    (_, i) => `- **C${i + 1}:** ${"the plan departs from the brief on a point that needs a human call before it ships. ".repeat(5)}`,
  );
  return [GATE_MARKER, "", ...points, "", `Answer with: nightshift queue retry ${id} --note "<your answer>"`].join("\n");
}

test("a gate notice near three kilobytes is returned whole by `queue status <id>`, and clipped with a pointer in the list", (t) => {
  const env = makeCliHome(t, "cli-status-big-gate-notice");
  const id = gatedJobWithNotice(env, "placeholder");
  const notice = bigGateNotice(id);
  assert.ok(Array.from(notice).length > 2900, "setup: the notice must be close to three kilobytes");
  openDb(env).prepare("UPDATE jobs SET notice_md = ? WHERE id = ?").run(notice, id);

  const status = runCli(env, ["queue", "status", String(id)]);
  assert.equal(status.status, 0, status.stderr);
  assert.ok(status.stdout.includes(`  ${GATE_MARKER}`), status.stdout);
  assert.ok(status.stdout.includes(`  Answer with: nightshift queue retry ${id} --note "<your answer>"`), status.stdout);
  assert.equal(status.stdout.includes("..."), false, "the single-job detail cut a gate notice that has no length cap");

  const json = runCli(env, ["queue", "status", String(id), "--json"]);
  assert.equal(json.status, 0, json.stderr);
  assert.equal(JSON.parse(json.stdout).job.notice_md, notice, "the JSON detail cut a gate notice that has no length cap");

  const listed = runCli(env, ["queue", "status"]);
  assert.equal(listed.status, 0, listed.stderr);
  assert.equal(listed.stdout.includes("text cut at"), false, "the human table printed the truncation pointer");

  const listedJson = runCli(env, ["queue", "status", "--json"]);
  assert.equal(listedJson.status, 0, listedJson.stderr);
  assert.deepEqual(
    JSON.parse(listedJson.stdout).suggestions,
    [`#${id} text cut at 500 characters - read it whole with nightshift queue status ${id}`],
  );
});

test("queue retry says where the whole notice is read when the refusal had to cut it", (t) => {
  const env = makeCliHome(t, "cli-retry-refusal-pointer");
  const id = gatedJobWithNotice(env, LONG_NOTICE);

  const refused = runCli(env, ["queue", "retry", String(id)]);
  assert.equal(refused.status, 1);
  assert.ok(refused.stderr.includes(`${Array.from(LONG_NOTICE).slice(0, 500).join("")}...`), refused.stderr);
  assert.match(refused.stderr, new RegExp(`^Read the whole notice with: nightshift queue status ${id}\\.$`, "m"));
  assert.match(refused.stderr, /This job is waiting for a decision\. Re-run with --note "<your answer>"\./);
  assert.equal(getJob(id, env).status, "gate", "the refused retry moved the job anyway");
});

test("queue cancel without --reason closes a gated job and keeps the note it already had", (t) => {
  const env = makeCliHome(t, "cli-cancel-note");
  const id = enqueue(env);
  openDb(env)
    .prepare("UPDATE jobs SET status = 'gate', finished_at = ?, operator_note = ? WHERE id = ?")
    .run("2020-01-01 00:00:00", "the human asked for changes", id);

  const cancelled = runCli(env, ["queue", "cancel", String(id)]);
  assert.equal(cancelled.status, 0, cancelled.stderr);
  assert.match(cancelled.stdout, /cancelled job #1/);

  const row = getJob(id, env);
  assert.equal(row.status, "cancelled");
  assert.equal(row.operator_note, "the human asked for changes", "the cancel without --reason erased the note of the gate");
  assert.equal(row.finished_at, "2020-01-01 00:00:00", "the cancel overwrote the finish of the gated run");
  assert.equal(JSON.parse(row.result).cancelledFrom, "gate");
});

test("an unrecognized token is always an error, and never falls through to running the whole queue", (t) => {
  const env = makeCliHome(t, "cli-argv");
  const id = enqueue(env);

  const cases = [
    [["queue"], /unknown queue subcommand ``/],
    [["queue", "bogus"], /unknown queue subcommand `bogus`/],
    [["queue", "run", "--bogus"], /--bogus/],
    [["queue", "run", "--job", "abc"], /`--job` expects a positive integer/],
    [["queue", "run", "1"], /unexpected argument `1`/],
    [["queue", "status", "1", "2"], /unexpected argument `2`/],
    [["queue", "cancel"], /missing argument/],
    [["queue", "run", "--stop", "--job", "1"], /`--stop` takes no other option/],
    [["queue", "run", "--stop", "--foreground"], /`--stop` takes no other option/],
    [["queue", "add", "alpha", "fix it", "--foreground"], /`--foreground` only has meaning with `--run`/],
    [["queue", "retry", "1", "--foreground"], /`--foreground` only has meaning with `--run`/],
  ];
  for (const [args, message] of cases) {
    const result = runCli(env, args);
    assert.equal(result.status, 1, `\`${args.join(" ")}\` did not fail: ${result.stdout}`);
    assert.match(result.stderr, message);
    assert.equal(result.stdout, "", `\`${args.join(" ")}\` printed something on stdout`);
  }
  assert.equal(getJob(id, env).status, "pending", "a refused command still claimed a job");
});

test("queue status names a job the runner gave back, with the preflight code, and says the runner retries by itself", (t) => {
  const env = makeCliHome(t, "cli-status-blocked");
  const id = enqueue(env, "fix the worker");
  const other = enqueue(env, "fix the parser");
  openDb(env)
    .prepare("UPDATE jobs SET result = ?, blocked_code = ? WHERE id = ?")
    .run(JSON.stringify({ blocked: { code: "dirty-checkout", message: "/repo has uncommitted changes" } }), "dirty-checkout", id);
  const table = runCli(env, ["queue", "status"]);
  assert.equal(table.status, 0, table.stderr);
  assert.match(tableLine(table.stdout, id), /○ pending\s+-\s+-\s+alpha\s+⛔ dirty-checkout: \/repo has uncommitted changes/);
  assert.match(table.stdout, /pending=2 \(1 blocked\)/, "the counts line did not break the blocked pending out of the total");
  assert.match(table.stdout, /1 job blocked \(dirty-checkout\) - fix the cause, the runner retries by itself/);

  const blockedOnly = runCli(env, ["queue", "status", "--blocked"]);
  assert.equal(blockedOnly.status, 0, blockedOnly.stderr);
  assert.ok(tableLine(blockedOnly.stdout, id), "`--blocked` dropped the blocked job");
  assert.equal(tableLine(blockedOnly.stdout, other), "", "`--blocked` still listed a job that is not blocked");
});

test("`--blocked` with no blocked job says so instead of claiming the queue itself is empty", (t) => {
  const env = makeCliHome(t, "cli-status-blocked-empty");
  enqueue(env, "fix the worker");

  const result = runCli(env, ["queue", "status", "--blocked"]);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /no blocked job in the queue/);
  assert.equal(result.stdout.includes("no jobs in the queue"), false, "a non-empty queue was reported as empty under --blocked");
});
