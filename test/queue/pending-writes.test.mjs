import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, utimesSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StoreUnavailableError } from "../../src/config/errors.mjs";
import { dbPath, pendingWritesPath, runDir } from "../../src/config/paths.mjs";
import { createServer } from "../../src/mcp/tools.mjs";
import { closeDb, openDb, openDbReadOnly } from "../../src/memory/db.mjs";
import { addJob, claimJobById, countAttempt, finishJob, getJob, persistRunFacts } from "../../src/memory/jobs.mjs";
import { claimBlocker } from "../../src/queue/claim.mjs";
import { appendPendingWrite, PENDING_KEYS, replayAllPendingWrites, replayPendingWrites } from "../../src/queue/pending-writes.mjs";
import { readRunState } from "../../src/queue/resume.mjs";
import { recordJobBlock } from "../../src/queue/run-state.mjs";
import { runCycle } from "../../src/queue/runner.mjs";
import { openStore } from "../../src/store/open.mjs";
import { fakeJobWorktree } from "../../test-support/job-worktree.mjs";
import { ensureProject, makeDir, makeHome, makeProject } from "../../test-support/memory.mjs";
import { useFakeClaude } from "../../test-support/queue-fake.mjs";
import { makeSickHome } from "../../test-support/sick-home.mjs";
import { gateStream, SLUG } from "../../test-support/streams.mjs";

const CLI = fileURLToPath(new URL("../../bin/nightqueue.mjs", import.meta.url));
const APPENDER = fileURLToPath(new URL("../../test-support/pending-write-appender.mjs", import.meta.url));
const WORKER = "test:worker";
const NOTICE = "gate: the plan needs an answer";

// A git double for the preflight: a clean checkout of the default branch.
function fakeGit() {
  const answers = { status: "", "rev-parse": "main", "symbolic-ref": "origin/main" };
  return ({ args }) => {
    const answer = answers[args[0]];
    if (answer === undefined) throw new Error(`git ${args[0]} failed`);
    return `${answer}\n`;
  };
}

// The real tool server and a client wired together in-process.
async function connectInProcess(t, env) {
  const server = createServer(env);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "nightqueue-tests-pending", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  t.after(async () => {
    await client.close();
    await server.close();
  });
  return client;
}

// The JSON a tool answered.
function answerOf(result) {
  return JSON.parse(result.content.map((block) => block.text).join("\n"));
}

// A home with project `alpha` and one job claimed by WORKER, whose run directory exists.
function claimedJobHome(t, name, slug = SLUG) {
  const env = makeHome(t, name);
  makeProject(t, env, "alpha");
  const projectId = ensureProject(env, "alpha");
  const id = addJob({ projectId, prompt: "fix the worker", slug }, env).id;
  claimJobById(id, { worker: WORKER, cap: null }, env);
  mkdirSync(runDir(projectId, slug, env), { recursive: true });
  return { env, projectId, id, slug };
}

// The finish a runner would have written for a gate, queued exactly as it would be.
function gateFinish(noticeMd = NOTICE) {
  return { worker: WORKER, status: "gate", result: { status: "gate", attempts: 1 }, prUrl: null, noticeMd };
}

// Queues one entry into the run of a claimed-job home, asserting it was queued.
function queue(home, entry) {
  const queued = appendPendingWrite({ projectId: home.projectId, slug: home.slug, entry, env: home.env });
  assert.equal(queued.status, "queued", queued.reason);
  return queued.path;
}

// Queues the gate finish of the claimed job.
function queueFinish(home, noticeMd = NOTICE) {
  return queue(home, { key: PENDING_KEYS.finish(home.id, WORKER), kind: "finish", jobId: home.id, payload: gateFinish(noticeMd) });
}

// Queues one pipeline run of the claimed job's run.
function queuePipelineLog(home, at = new Date().toISOString()) {
  const payload = { projectId: home.projectId, slug: home.slug, tier: "simple", outcome: "no_commit", gateStop: "architect", phases: [{ phase: "triage" }], model: null, sessionId: null };
  return queue(home, { key: PENDING_KEYS.pipelineLog(home.projectId, home.slug, at), kind: "pipeline_log", at, jobId: home.id, payload });
}

// How many pipeline runs the table holds for one run.
function pipelineRunCount(env, projectId, slug) {
  const db = openDbReadOnly(env);
  try {
    return db.prepare("SELECT COUNT(*) AS n FROM pipeline_runs WHERE project_id = ? AND slug = ?").get(projectId, slug).n;
  } finally {
    db.close();
  }
}

// The finished (`.done.jsonl`) files of a run, oldest name first.
function doneFiles(env, projectId, slug) {
  const dir = runDir(projectId, slug, env);
  return readdirSync(dir).filter((name) => name.endsWith(".done.jsonl")).sort().map((name) => join(dir, name));
}

// The parsed lines of a pending-writes file.
function linesOf(path) {
  return readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

// Runs a CLI command as a child process started at once, answered when it exits.
function spawnCli(env, args) {
  return spawnNode(env, [CLI, ...args]);
}

// Runs a node script as a child process started at once, answered with its code and output when it exits.
function spawnNode(env, argv) {
  const child = spawn(process.execPath, argv, { env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("(b) fixture (iii) during a run: pipeline_log answers queued, the gate finish is queued with the witness, and one replay after restore writes the gate exactly once", async (t) => {
  const env = makeHome(t, "pending-run-sick");
  makeProject(t, env, "alpha");
  useFakeClaude(env, makeDir(t, "pending-run-sick-plan"), [{ stdout: gateStream(), exitCode: 0 }]);
  const projectId = ensureProject(env, "alpha");
  const id = addJob({ projectId, prompt: "fix the worker", slug: SLUG }, env).id;
  const client = await connectInProcess(t, { ...env, NIGHTQUEUE_JOB_ID: String(id) });
  let sick = null;
  let logged = null;
  const finishJobImpl = async (jobId, outcome) => {
    sick = makeSickHome(env);
    logged = answerOf(await client.callTool({ name: "pipeline_log", arguments: { tier: "simple", outcome: "no_commit", gate_stop: "architect" } }));
    return await openStore(env).jobs.finishJob(jobId, outcome);
  };
  t.after(() => sick?.restore());

  const cycle = await runCycle({ jobId: id, env, deps: { worktreeImpl: fakeJobWorktree(), gitImpl: fakeGit(), finishJobImpl } });

  const path = pendingWritesPath(projectId, SLUG, env);
  assert.deepEqual({ ...logged, contract: null }, { ok: true, queued: true, warning: `recorded in ${path}; replayed once the database is back`, pending: path, contract: null });
  const report = cycle.processed[0];
  assert.equal(report.status, "unrecorded", JSON.stringify(report));
  assert.equal(report.pending, path);
  const queued = linesOf(path);
  assert.deepEqual(queued.map((line) => line.kind), ["pipeline_log", "finish"]);
  const finish = queued[1].payload;
  assert.deepEqual({ status: finish.status, worker: typeof finish.worker, notice: typeof finish.noticeMd }, { status: "gate", worker: "string", notice: "string" });
  assert.equal(queued[1].key, `finish:${id}:${finish.worker}`);
  assert.equal(readRunState({ projectId, slug: SLUG, env }).terminal.status, "gate", "the witness was not written");

  sick.restore();
  assert.equal(getJob(id, env).status, "running", "setup: the finish should not have landed before the replay");
  const replayed = await replayAllPendingWrites({ env, store: openStore(env) });

  assert.equal(replayed.error, null);
  assert.deepEqual({ applied: replayed.runs[0].applied, superseded: replayed.runs[0].superseded }, { applied: 2, superseded: 0 });
  const row = getJob(id, env);
  assert.equal(row.status, "gate");
  assert.equal(row.notice_md, finish.noticeMd);
  assert.equal(pipelineRunCount(env, projectId, SLUG), 1);
  assert.equal(existsSync(path), false, "a fully replayed file stays live");
  assert.equal(doneFiles(env, projectId, SLUG).length, 1);
});

test("a second replay, and a replay after the markers are deleted (the crash window), change nothing", async (t) => {
  const home = claimedJobHome(t, "pending-twice");
  queuePipelineLog(home);
  queueFinish(home);
  const store = openStore(home.env);
  await replayPendingWrites({ ...home, store });
  const before = { row: getJob(home.id, home.env), runs: pipelineRunCount(home.env, home.projectId, home.slug) };

  const again = await replayAllPendingWrites({ env: home.env, store });
  const [done] = doneFiles(home.env, home.projectId, home.slug);
  const entriesOnly = linesOf(done).filter((line) => line.key);
  writeFileSync(pendingWritesPath(home.projectId, home.slug, home.env), entriesOnly.map((line) => `${JSON.stringify(line)}\n`).join(""));
  const crashed = await replayPendingWrites({ ...home, store });

  assert.deepEqual(again.runs, [], "a retired file was replayed again");
  assert.deepEqual({ applied: crashed.applied, filled: crashed.filled, superseded: crashed.superseded }, { applied: 0, filled: 0, superseded: 2 });
  assert.deepEqual(getJob(home.id, home.env), before.row);
  assert.equal(pipelineRunCount(home.env, home.projectId, home.slug), before.runs);
});

test("never demote: a row already done stays done, and its notice is untouched", async (t) => {
  const home = claimedJobHome(t, "pending-no-demote");
  queueFinish(home);
  finishJob(home.id, { worker: WORKER, status: "done", prUrl: "https://github.com/acme/api/pull/9", noticeMd: "delivered" }, home.env);

  const replayed = await replayPendingWrites({ ...home, store: openStore(home.env) });

  assert.equal(replayed.superseded, 1);
  const row = getJob(home.id, home.env);
  assert.deepEqual({ status: row.status, notice: row.notice_md }, { status: "done", notice: "delivered" });
  assert.equal(linesOf(doneFiles(home.env, home.projectId, home.slug)[0]).at(-1).result, "superseded");
});

test("a gate the witness reconcile wrote with no notice gets the queued notice filled, and keeps its status", async (t) => {
  const home = claimedJobHome(t, "pending-fill");
  queueFinish(home);
  finishJob(home.id, { worker: WORKER, status: "gate", noticeMd: null }, home.env);
  assert.equal(getJob(home.id, home.env).notice_md ?? null, null, "setup: the gate should carry no notice");

  const replayed = await replayPendingWrites({ ...home, store: openStore(home.env) });

  assert.equal(replayed.filled, 1);
  const row = getJob(home.id, home.env);
  assert.deepEqual({ status: row.status, notice: row.notice_md }, { status: "gate", notice: NOTICE });
});

test("entries replay in file order: the telemetry queued after its pipeline run lands on the run the replay just wrote", async (t) => {
  const home = claimedJobHome(t, "pending-order");
  queuePipelineLog(home);
  queue(home, { key: PENDING_KEYS.telemetry(home.id, WORKER), kind: "telemetry", jobId: home.id, payload: { projectId: home.projectId, slug: home.slug, durationS: 321, phases: [] } });

  const replayed = await replayPendingWrites({ ...home, store: openStore(home.env) });

  assert.equal(replayed.applied, 2);
  const db = openDbReadOnly(home.env);
  try {
    assert.equal(db.prepare("SELECT duration_s FROM pipeline_runs WHERE slug = ?").get(home.slug).duration_s, 321);
  } finally {
    db.close();
  }
});

test("a replay while the database is unavailable rethrows the store error and leaves the file byte for byte", async (t) => {
  const home = claimedJobHome(t, "pending-sick-replay");
  const path = queueFinish(home);
  const before = readFileSync(path, "utf8");
  const sick = makeSickHome(home.env);
  t.after(() => sick.restore());

  await assert.rejects(replayPendingWrites({ ...home, store: openStore(home.env) }), StoreUnavailableError);
  const all = await replayAllPendingWrites({ env: home.env, store: openStore(home.env) });

  assert.ok(all.error instanceof StoreUnavailableError);
  assert.equal(readFileSync(path, "utf8"), before);
});

test("malformed lines are skipped and counted, an unknown kind is marked refused, and nothing throws", async (t) => {
  const home = claimedJobHome(t, "pending-malformed");
  const path = pendingWritesPath(home.projectId, home.slug, home.env);
  const unknown = { v: 1, key: "mystery:1", kind: "mystery", at: new Date().toISOString(), jobId: null, projectId: home.projectId, slug: home.slug, payload: {} };
  writeFileSync(path, `{not json\n${JSON.stringify({ v: 1 })}\n${JSON.stringify(unknown)}\n`);
  queueFinish(home);

  const replayed = await replayPendingWrites({ ...home, store: openStore(home.env) });

  assert.deepEqual({ malformed: replayed.malformed, refused: replayed.refused, applied: replayed.applied }, { malformed: 2, refused: 1, applied: 1 });
  const retired = readFileSync(doneFiles(home.env, home.projectId, home.slug)[0], "utf8").split("\n");
  assert.equal(retired[0], "{not json", "the malformed line was not kept in the retired file");
  const markers = retired.slice(1).filter(Boolean).map((line) => JSON.parse(line)).filter((line) => typeof line.applied === "string");
  assert.equal(markers.find((marker) => marker.applied === "mystery:1").result, "refused: unknown kind");
});

test("an append refuses an unknown kind or a path that is not a run, and a key is queued once", (t) => {
  const home = claimedJobHome(t, "pending-append");
  const entry = { key: PENDING_KEYS.finish(home.id, WORKER), kind: "finish", jobId: home.id, payload: gateFinish() };

  assert.equal(appendPendingWrite({ projectId: home.projectId, slug: home.slug, entry: { ...entry, kind: "mystery" }, env: home.env }).status, "kept");
  assert.equal(appendPendingWrite({ projectId: home.projectId, slug: "../escape", entry, env: home.env }).status, "kept");
  queue(home, entry);
  queue(home, entry);

  assert.equal(linesOf(pendingWritesPath(home.projectId, home.slug, home.env)).length, 1);
});

test("an in-process replay and a child `nightqueue queue repair`, fired concurrently, leave one pipeline run and one finish", async (t) => {
  const home = claimedJobHome(t, "pending-concurrent");
  queuePipelineLog(home);
  queueFinish(home);

  const [child, inProcess] = await Promise.all([spawnCli(home.env, ["queue", "repair"]), replayPendingWrites({ ...home, store: openStore(home.env) })]);

  assert.equal(child.code, 0, child.stderr);
  assert.ok(inProcess.applied + inProcess.superseded <= 2);
  const row = getJob(home.id, home.env);
  assert.deepEqual({ status: row.status, notice: row.notice_md }, { status: "gate", notice: NOTICE });
  assert.equal(pipelineRunCount(home.env, home.projectId, home.slug), 1);
  assert.equal(existsSync(pendingWritesPath(home.projectId, home.slug, home.env)), false);
});

test("appends from a child that land while a replay retires the file go into a live file, and none is lost", async (t) => {
  const home = claimedJobHome(t, "pending-rename-race");
  queueFinish(home);

  const [child] = await Promise.all([
    spawnNode(home.env, [APPENDER, home.projectId, home.slug, "child", "20"]),
    replayPendingWrites({ ...home, store: openStore(home.env) }),
  ]);

  assert.equal(child.code, 0, child.stderr);
  assert.ok(JSON.parse(child.stdout).every((answer) => answer.status === "queued"), child.stdout);
  const live = pendingWritesPath(home.projectId, home.slug, home.env);
  const files = [...doneFiles(home.env, home.projectId, home.slug), ...(existsSync(live) ? [live] : [])];
  const keys = new Set(files.flatMap((path) => linesOf(path).filter((line) => line.key).map((line) => line.key)));
  for (let n = 0; n < 20; n += 1) assert.ok(keys.has(`child:${n}`), `child:${n} was lost`);
  for (const done of doneFiles(home.env, home.projectId, home.slug)) {
    const lines = linesOf(done);
    const marked = new Set(lines.filter((line) => line.applied).map((line) => line.applied));
    assert.ok(lines.filter((line) => line.key).every((line) => marked.has(line.key)), `${done} was retired with an unmarked entry`);
  }
});

test("bare `queue repair` answers `nothing pending` when no run queued anything, and one line per run otherwise", async (t) => {
  const home = claimedJobHome(t, "pending-repair-cli");
  const empty = await spawnCli(home.env, ["queue", "repair"]);
  queueFinish(home);

  const replayed = await spawnCli(home.env, ["queue", "repair"]);

  assert.equal(empty.stdout.trim(), "nothing pending");
  assert.equal(replayed.code, 0, replayed.stderr);
  assert.equal(replayed.stdout.trim(), `${home.projectId}/${home.slug}: applied 1, filled 0, superseded 0, refused 0`);
});

test("`run index-save` inside a job on fixture (iii) queues the save, exits 0, and the replay saves the index", async (t) => {
  const home = claimedJobHome(t, "pending-index-save");
  const repo = realpathSync(makeDir(t, "pending-index-repo"));
  const artifact = join(makeDir(t, "pending-index-artifact"), "02-explore.md");
  writeFileSync(artifact, `## File map\n\n- ${repo}/src/a.mjs — the one module\n\n## Third-party libraries\n\n- zod@4.5.4\n`);
  recordJobBlock({ projectId: home.projectId, slug: home.slug, block: { id: home.id, projectKey: "AP", itemRef: null, createdAt: new Date().toISOString() }, env: home.env });
  const sick = makeSickHome(home.env);
  t.after(() => sick.restore());

  const queued = await spawnCli({ ...home.env, NIGHTQUEUE_JOB_ID: String(home.id) }, ["run", "index-save", artifact, "--repo-root", repo]);

  const path = pendingWritesPath(home.projectId, home.slug, home.env);
  assert.equal(queued.code, 0, queued.stderr);
  assert.equal(queued.stderr.trim(), `QUEUED: ${path}`);
  sick.restore();
  const replayed = await replayPendingWrites({ ...home, store: openStore(home.env) });
  assert.equal(replayed.applied, 1);
  const index = await openStore(home.env).index.recallProjectIndex({ projectId: home.projectId, repoRoot: repo });
  assert.deepEqual(index.files.map((file) => file.path), ["src/a.mjs"]);
});

// Queues the session facts of the claimed job's attempt `attempts`, announced as `sessionId`.
function queueSession(home, { attempts, sessionId = "sess-queued-1" }) {
  const payload = { worker: WORKER, attempts, sessionId, lastSessionId: sessionId, lastSessionAttempt: attempts };
  return queue(home, { key: PENDING_KEYS.session(home.id, attempts), kind: "session", jobId: home.id, payload });
}

// The session columns of a job, read on a fresh connection.
function sessionRow(env, id) {
  const db = openDbReadOnly(env);
  try {
    return { ...db.prepare("SELECT session_id, last_session_id, last_session_attempt FROM jobs WHERE id = ?").get(id) };
  } finally {
    db.close();
  }
}

test("a queued session fills the row of the same claim, and is superseded once the job moved to a later attempt", async (t) => {
  const home = claimedJobHome(t, "pending-session-attempt");
  const attempts = getJob(home.id, home.env).attempts;
  queueSession(home, { attempts });
  countAttempt(home.id, { worker: WORKER }, home.env);

  const replayed = await replayPendingWrites({ ...home, store: openStore(home.env) });

  assert.equal(replayed.superseded, 1);
  assert.deepEqual(sessionRow(home.env, home.id), { session_id: null, last_session_id: null, last_session_attempt: null });

  const fresh = claimedJobHome(t, "pending-session-applied");
  queueSession(fresh, { attempts: getJob(fresh.id, fresh.env).attempts });
  const applied = await replayPendingWrites({ ...fresh, store: openStore(fresh.env) });
  assert.equal(applied.applied, 1);
  assert.equal(sessionRow(fresh.env, fresh.id).last_session_id, "sess-queued-1");
});

test("a queued session never rewinds the session a later attempt already recorded", async (t) => {
  const home = claimedJobHome(t, "pending-session-rewind");
  const attempts = getJob(home.id, home.env).attempts;
  queueSession(home, { attempts });
  persistRunFacts(home.id, { worker: WORKER, sessionId: "sess-first", lastSessionId: "sess-later", lastSessionAttempt: attempts + 1 }, home.env);
  const before = sessionRow(home.env, home.id);

  const replayed = await replayPendingWrites({ ...home, store: openStore(home.env) });

  assert.equal(replayed.superseded, 1);
  assert.deepEqual(sessionRow(home.env, home.id), before);
});

test("`queue run <id>` replays a dead owner's queued finish before its preview sweeps the orphans: the job ends done with its pull request", async (t) => {
  const env = makeHome(t, "pending-preview-sweep");
  makeProject(t, env, "alpha");
  const projectId = ensureProject(env, "alpha");
  const dead = `${hostname()}:2147483646`;
  const x = addJob({ projectId, prompt: "job x", slug: "job-x" }, env).id;
  const y = addJob({ projectId, prompt: "job y", slug: "job-y" }, env).id;
  claimJobById(x, { worker: dead, cap: null }, env);
  openDb(env).prepare("UPDATE jobs SET lease_until = datetime('now', '-100000 seconds') WHERE id = ?").run(x);
  mkdirSync(runDir(projectId, "job-x", env), { recursive: true });
  const prUrl = "https://github.com/acme/api/pull/7";
  const payload = { worker: dead, status: "done", result: { status: "done", attempts: 1 }, prUrl, noticeMd: null };
  queue({ env, projectId, slug: "job-x" }, { key: PENDING_KEYS.finish(x, dead), kind: "finish", jobId: x, payload });

  await claimBlocker({ jobId: y, mode: "once", env });

  const row = getJob(x, env);
  assert.deepEqual({ status: row.status, prUrl: row.pr_url }, { status: "done", prUrl });
  assert.equal(existsSync(pendingWritesPath(projectId, "job-x", env)), false, "the live file was not retired");
  assert.equal(doneFiles(env, projectId, "job-x").length, 1);
});

// A repository with `src/a.mjs` whose modification time is an hour ago, for the index replay cases.
function indexRepo(t, name) {
  const repoRoot = realpathSync(makeDir(t, name));
  mkdirSync(join(repoRoot, "src"), { recursive: true });
  writeFileSync(join(repoRoot, "src", "a.mjs"), "x");
  const hourAgo = new Date(Date.now() - 3_600_000);
  utimesSync(join(repoRoot, "src", "a.mjs"), hourAgo, hourAgo);
  return repoRoot;
}

// Queues an index save of the claimed job's project at the instant `at`.
function queueIndexSave(home, { repoRoot, files = [], libs = [], at = new Date().toISOString() }) {
  const payload = { projectId: home.projectId, repoRoot, files, libs };
  return queue(home, { key: PENDING_KEYS.indexSave(home.projectId, at), kind: "index_save", at, jobId: home.id, payload });
}

// The index row of one path and the lib row of one lib, read on a fresh connection.
function indexRows(env, projectId, { path, lib }) {
  const db = openDbReadOnly(env);
  try {
    const file = db.prepare("SELECT responsibility, mtime_ms FROM project_index WHERE project_id = ? AND path = ?").get(projectId, path);
    const version = db.prepare("SELECT version FROM project_libs WHERE project_id = ? AND lib = ?").get(projectId, lib);
    return { file: file ? { ...file } : null, version: version?.version ?? null };
  } finally {
    db.close();
  }
}

test("an index save queued before a live one is superseded: the later text and its modification time stay", async (t) => {
  const home = claimedJobHome(t, "pending-index-later");
  const repoRoot = indexRepo(t, "pending-index-later-repo");
  const earlier = new Date(Date.now() - 2000).toISOString();
  queueIndexSave(home, { repoRoot, files: [{ path: "src/a.mjs", responsibility: "old", mtimeMs: 1 }], libs: [{ lib: "zod", version: "3.0.0" }], at: earlier });
  await openStore(home.env).index.saveProjectIndex({ projectId: home.projectId, repoRoot, files: [{ path: "src/a.mjs", responsibility: "new" }], libs: [{ lib: "zod", version: "4.0.0" }] });
  const before = indexRows(home.env, home.projectId, { path: "src/a.mjs", lib: "zod" });

  const replayed = await replayPendingWrites({ ...home, store: openStore(home.env) });

  assert.equal(replayed.superseded, 1);
  assert.deepEqual(indexRows(home.env, home.projectId, { path: "src/a.mjs", lib: "zod" }), before);
  assert.equal(before.file.responsibility, "new");
  assert.equal(before.version, "4.0.0");
});

test("an index save queued for rows that do not exist yet is applied with the modification time measured when it was queued", async (t) => {
  const home = claimedJobHome(t, "pending-index-fill");
  const repoRoot = indexRepo(t, "pending-index-fill-repo");
  queueIndexSave(home, { repoRoot, files: [{ path: "src/a.mjs", responsibility: "queued", mtimeMs: 12345 }], libs: [{ lib: "zod", version: "4.5.4" }] });

  const replayed = await replayPendingWrites({ ...home, store: openStore(home.env) });

  assert.equal(replayed.applied, 1);
  assert.deepEqual(indexRows(home.env, home.projectId, { path: "src/a.mjs", lib: "zod" }), { file: { responsibility: "queued", mtime_ms: 12345 }, version: "4.5.4" });
});

test("(a) a random -shm during a run is survived: SQLite rebuilds the index, pipeline_log and the finish record normally, and no pending-writes file exists", async (t) => {
  const home = claimedJobHome(t, "pending-shm-random");
  const client = await connectInProcess(t, { ...home.env, NIGHTQUEUE_JOB_ID: String(home.id) });
  closeDb(home.env);
  writeFileSync(`${dbPath(home.env)}-shm`, randomBytes(32768));

  const logged = answerOf(await client.callTool({ name: "pipeline_log", arguments: { tier: "simple", outcome: "no_commit" } }));
  const finished = await openStore(home.env).jobs.finishJob(home.id, gateFinish());

  assert.equal(logged.ok, true);
  assert.equal(logged.queued, undefined, JSON.stringify(logged));
  assert.equal(finished, true);
  assert.equal(getJob(home.id, home.env).status, "gate");
  assert.equal(existsSync(pendingWritesPath(home.projectId, home.slug, home.env)), false);
});
