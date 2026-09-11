import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { jobLogPath, queuePausedPath, runDir } from "../../src/config/paths.mjs";
import { addProject } from "../../src/config/projects.mjs";
import { loadConfig, saveConfig } from "../../src/config/store.mjs";
import { openDb } from "../../src/memory/db.mjs";
import { addJob, claimJobById, getJob } from "../../src/memory/jobs.mjs";
import { writeRunnerPidfile } from "../../src/queue/pidfile.mjs";
import { isolatedHostVars } from "../../test-support/host.mjs";
import { makeDir, makeHome } from "../../test-support/memory.mjs";
import { useFakeClaude } from "../../test-support/queue-fake.mjs";
import { assistantEvent, doneStream, gateStream, PR_URL, SLUG } from "../../test-support/streams.mjs";

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
  assert.match(queued.stdout, /queued job #1 for `alpha` \(1 pending\)\. Start the batch: nightshift queue run/);
  assert.equal(getJob(1, env).prompt, "fix the worker");

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
  assert.match(queued.stdout, /queued job #1 for `alpha` \(1 pending\)\. Start the batch: nightshift queue run/);
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

  claimJobById(addJob({ project: "alpha", prompt: "hold the only slot" }, env).id, { worker: "host:4242", cap: 4 }, env);
  const busy = runCli(env, ["queue", "add", "alpha", "fix the parser", "--run", "--foreground"]);
  assert.equal(busy.status, 1, busy.stdout);
  assert.match(busy.stdout, /job #3 did not start \(project-busy\); it stays in the queue/);
  assert.equal(getJob(3, env).status, "pending");
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
  assert.deepEqual(payload.counts, { pending: 2, running: 0, done: 0, gate: 0, failed: 0, cancelled: 0, merged: 0 });

  const one = JSON.parse(runCli(env, ["queue", "status", String(first), "--json"]).stdout);
  assert.deepEqual({ id: one.job.id, status: one.job.status, project: one.job.project }, { id: first, status: "pending", project: "alpha" });
  assert.equal(JSON.parse(runCli(env, ["queue", "status", "--limit", "1", "--json"]).stdout).jobs.length, 1);

  const table = runCli(env, ["queue", "status"]);
  assert.match(table.stdout, /#1\s+○ pending\s+-\s+-\s+alpha/);
  assert.match(table.stdout, /pending=2/);
  assert.match(runCli(env, ["queue", "status", "99"]).stderr, /unknown job `99`/);
});

const MERGE_SHA = "d3605a5a4d7aaec342d649135cdbd128a042e29d";

// Marks a job as delivered with the pull request URL the sweep will ask gh about.
function deliver(env, id, prUrl = "https://github.com/acme/api/pull/42") {
  openDb(env).prepare("UPDATE jobs SET status = 'done', pr_url = ?, finished_at = ? WHERE id = ?").run(prUrl, "2026-09-10 10:00:00", id);
  return id;
}

// The same home with the fake `gh` in place of the real one and the merge sweep switched back on.
function withFakeGh(t, env, { state = "MERGED", sha = MERGE_SHA } = {}) {
  const swept = { ...env, ...isolatedHostVars(makeDir(t, "cli-gh")), NIGHTSHIFT_FAKE_GH_PR_STATE: state, NIGHTSHIFT_FAKE_GH_PR_SHA: sha };
  delete swept.NIGHTSHIFT_NO_PR_CHECK;
  return swept;
}

// The `gh pr view` calls the fake gh of a home recorded so far.
function prViewCalls(env) {
  const log = env.NIGHTSHIFT_FAKE_GH_LOG;
  if (!existsSync(log)) return [];
  return readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)).filter((call) => call[0] === "pr");
}

test("queue status flips a delivered job whose pull request was merged, once per job every five minutes", (t) => {
  const base = makeCliHome(t, "cli-status-merged");
  deliver(base, enqueue(base));
  const env = withFakeGh(t, base);

  const table = runCli(env, ["queue", "status"]);
  assert.equal(table.status, 0, table.stderr);
  assert.match(tableLine(table.stdout, 1), /^#1\s+⇡ merged\s+/);
  assert.match(table.stdout, /merged=1/);
  assert.match(table.stdout, /done=0/);
  assert.equal(prViewCalls(env).length, 1, "the sweep did not ask gh about the pull request");
  assert.deepEqual(prViewCalls(env)[0], ["pr", "view", "https://github.com/acme/api/pull/42", "--json", "state,mergedAt,mergeCommit"]);

  const again = runCli(env, ["queue", "status"]);
  assert.equal(again.status, 0, again.stderr);
  assert.equal(prViewCalls(env).length, 1, "a second status inside the window asked gh again");

  const payload = JSON.parse(runCli(env, ["queue", "status", "--json"]).stdout);
  assert.equal(payload.counts.merged, 1);
  assert.equal(payload.jobs[0].merge_sha, MERGE_SHA);
  assert.match(payload.jobs[0].merged_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  assert.match(payload.jobs[0].pr_checked_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);

  const detail = runCli(env, ["queue", "status", "1"]);
  assert.match(detail.stdout, /status\s+merged/);
  assert.match(detail.stdout, new RegExp(`merge_sha\\s+${MERGE_SHA}`));
  assert.match(detail.stdout, /merged_at\s+\d{4}-\d{2}-\d{2}T/);
});

test("a gh that cannot answer leaves the job delivered, prints nothing about it and still exits 0", (t) => {
  const base = makeCliHome(t, "cli-status-merged-fail-open");
  deliver(base, enqueue(base));
  const env = withFakeGh(t, base, { state: "" });
  env.NIGHTSHIFT_GH_BIN = join(makeDir(t, "cli-gh-missing"), "gh");

  const table = runCli(env, ["queue", "status"]);
  assert.equal(table.status, 0, table.stderr);
  assert.match(tableLine(table.stdout, 1), /^#1\s+✓ done\s+/);
  assert.match(table.stdout, /done=1/);
  assert.equal(table.stderr, "", `the sweep printed on stderr: ${table.stderr}`);
  assert.equal(getJob(1, env).pr_checked_at, null, "a check nobody could make was stamped anyway");
});

test("a merged job is terminal for cancel and for retry, and retry still takes a failed one", (t) => {
  const env = makeCliHome(t, "cli-merged-terminal");
  const merged = deliver(env, enqueue(env));
  openDb(env).prepare("UPDATE jobs SET status = 'merged', merged_at = ?, merge_sha = ? WHERE id = ?").run("2026-09-11 15:54:01", MERGE_SHA, merged);

  const cancelled = runCli(env, ["queue", "cancel", String(merged)]);
  assert.equal(cancelled.status, 1);
  assert.match(cancelled.stderr, /already finished with status `merged`/);

  const retried = runCli(env, ["queue", "retry", String(merged)]);
  assert.equal(retried.status, 1);
  assert.match(retried.stderr, /cannot be retried from status `merged`/);
  assert.equal(getJob(merged, env).status, "merged");

  const failed = enqueue(env, "fix the parser");
  openDb(env).prepare("UPDATE jobs SET status = 'failed' WHERE id = ?").run(failed);
  assert.equal(runCli(env, ["queue", "retry", String(failed)]).status, 0);
  assert.equal(getJob(failed, env).status, "pending");
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
  writeRunnerPidfile({ pid: process.pid, startedAt: new Date().toISOString(), mode: "watch", intervalS: 30, logPath: "/tmp/a.log" }, watched);
  const alive = runCli(watched, ["queue", "status"]);
  assert.equal(alive.stdout.includes("start the batch"), false, "the nudge showed up while a watcher was alive");

  const empty = runCli(makeCliHome(t, "cli-status-backlog-empty"), ["queue", "status"]);
  assert.equal(empty.stdout.includes("start the batch"), false, "an empty queue got a nudge");
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
  assert.deepEqual(payload.counts, { pending: 0, running: 1, done: 0, gate: 0, failed: 0, cancelled: 0, merged: 0 });
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
  assert.match(runCli(env, ["queue", "run", "--dry"]).stdout, /heartbeat {7}5s/, "the operator cannot see the heartbeat it can tune");
  assert.equal(getJob(id, env).status, "pending");

  assert.equal(runCli(env, ["queue", "pause"]).status, 0);
  assert.equal(existsSync(queuePausedPath(env)), true);
  assert.match(runCli(env, ["queue", "run", "--foreground"]).stdout, /nothing to run \(paused\)/);
  assert.equal(getJob(id, env).status, "pending");

  assert.equal(runCli(env, ["queue", "resume"]).status, 0);
  assert.equal(existsSync(queuePausedPath(env)), false);
  assert.match(runCli(env, ["queue", "run", "--foreground"]).stdout, /job #1 done/);
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
  assert.match(status.stdout, /^ {2}Stopped at the gate\./m);
  assert.match(status.stdout, /retry it with: nightshift queue retry 1 --note "<your answer>"/);
  assert.equal(status.stdout.includes("notice_md       "), false, "the notice was dumped as a field of the generic block");

  const json = runCli(env, ["queue", "status", "1", "--json"]);
  assert.equal(json.status, 0, json.stderr);
  assert.match(JSON.parse(json.stdout).job.notice_md, /Stopped at the gate\./);
});

test("queue retry refuses a gated job without --note, printing why the job is waiting", (t) => {
  const env = makeCliHome(t, "cli-retry-refusal", [{ stdout: gateStream(), exitCode: 0 }]);
  assert.equal(runCli(env, ["queue", "add", "alpha", "fix the worker", "--run", "--foreground"]).status, 1);

  const refused = runCli(env, ["queue", "retry", "1"]);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /Stopped at the gate\./);
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
