import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { run as runNightqueue } from "../../src/cli/index.mjs";
import { openPullRequest } from "../../src/cli/run-publish.mjs";
import { callerClaim, claimPin, JOB_CLAIM_ENV } from "../../src/config/job-home.mjs";
import { runDir } from "../../src/config/paths.mjs";
import { openDb } from "../../src/memory/db.mjs";
import { addJob, claimNextJob, getJob, listJobsWithSlug, parkJob, sweepOrphans } from "../../src/memory/jobs.mjs";
import { SILENT_STOP_NOTICE } from "../../src/queue/classify.mjs";
import { claimOfCaller, resolveJobRun } from "../../src/queue/job-run.mjs";
import { mergerEnv } from "../../src/queue/merger-spawn.mjs";
import { BLOCK_CODES } from "../../src/queue/preflight.mjs";
import { readRunState, recordsOfClaim, writeRunTerminal } from "../../src/queue/resume.mjs";
import { applyRetry } from "../../src/queue/retry.mjs";
import { runOwnNotice, withoutRuntimeAppendedLines } from "../../src/queue/run-notice.mjs";
import { consumeRunConclusion, recordCheck, recordOutcome, recordPhaseDone, recordPrUrl, recordRunFields, recordTermination, RUNTIME_AUTHOR } from "../../src/queue/run-state.mjs";
import { provisionalSlug } from "../../src/queue/run-slug.mjs";
import { runCycle } from "../../src/queue/runner.mjs";
import { mcpConfigArg } from "../../src/queue/spawn.mjs";
import { terminateRun } from "../../src/queue/terminate.mjs";
import { initGitRepo } from "../../test-support/git.mjs";
import { fakeJobWorktree } from "../../test-support/job-worktree.mjs";
import { ensureProject, makeDir, makeHome, makeProject } from "../../test-support/memory.mjs";
import { fakeCalls, useFakeClaude } from "../../test-support/queue-fake.mjs";
import { doneStream, PR_URL, rateLimitEvent, recordedDone, recordedGate, resultEvent, SLUG, slugEvent, systemInitEvent, toNdjson, transientFailureStream } from "../../test-support/streams.mjs";

const CLI = fileURLToPath(new URL("../../bin/nightqueue.mjs", import.meta.url));
const SILENT = toNdjson([systemInitEvent(), slugEvent(SLUG), resultEvent({ text: "" })]);
const FAILED = { stdout: SILENT, exitCode: 1 };
const CLEAN = { stdout: SILENT, exitCode: 0 };
const IGNORED_ONE = "ignored a record of attempt 1";
const QUESTION = "A question of the first claim?";

// A git double for the preflight: a clean checkout of the default branch.
function fakeGit() {
  const answers = { status: "", "rev-parse": "main", "symbolic-ref": "origin/main" };
  return ({ args }) => `${answers[args[0]]}\n`;
}

// A home with one job of project `alpha`, the fake `claude` replaying the given spawns.
function stampHome(t, name, spawns = [CLEAN]) {
  const env = makeHome(t, name);
  makeProject(t, env, "alpha");
  const planPath = useFakeClaude(env, makeDir(t, `${name}-plan`), spawns);
  const projectId = ensureProject(env, "alpha");
  return { env, planPath, projectId, id: addJob({ projectId, prompt: "fix the worker" }, env).id };
}

// Runs the home's one job through a real cycle with a fake worktree, a clean preflight and no real backoff.
function runJob({ env, id }, deps = {}) {
  return runCycle({ jobId: id, env, deps: { worktreeImpl: fakeJobWorktree(), gitImpl: fakeGit(), sleepImpl: async () => {}, ...deps } });
}

// The run's state.json as it is on disk.
function stateOf({ env, projectId }) {
  return readRunState({ projectId, slug: SLUG, env });
}

// The bytes of the run's state.json.
function stateBytes({ env, projectId }) {
  return readFileSync(join(runDir(projectId, SLUG, env), "state.json"), "utf8");
}

// Puts a job straight into the state a claim leaves it in, bound to the run's slug.
function seedRunning({ env, id }, { attempts = 1, worker = "host:1", session = "sess-1" } = {}) {
  openDb(env).prepare("UPDATE jobs SET status = 'running', attempts = ?, worker = ?, slug = ?, last_session_id = ? WHERE id = ?").run(attempts, worker, SLUG, session, id);
}

// What a session sees of its own claim when the runner pinned `pinned` on it.
function claimOf({ env, id }, pinned) {
  return claimOfCaller(getJob(id, env), { ...env, [JOB_CLAIM_ENV]: pinned });
}

// Connects a real `nightqueue mcp` whose environment says it serves the job under the pinned claim.
async function connectMcp(t, { env, id }, pinned) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [CLI, "mcp"], env: { ...env, NIGHTQUEUE_JOB_ID: String(id), [JOB_CLAIM_ENV]: pinned }, stderr: "pipe" });
  const client = new Client({ name: "nightqueue-tests", version: "0.0.0" });
  await client.connect(transport);
  t.after(() => client.close());
  return client;
}

// Plain text of a tool result.
function textOf(result) {
  return result.content.map((block) => block.text).join("\n");
}

test("the pinned claim reads back whole, and anything else reads as none", () => {
  assert.deepEqual(callerClaim({ [JOB_CLAIM_ENV]: "2:host:42" }), { attempt: 2, worker: "host:42" });
  assert.deepEqual(callerClaim({ [JOB_CLAIM_ENV]: "2:" }), { attempt: 2, worker: null });
  for (const value of [undefined, "", "x:host", "0:host", "2", 3]) assert.equal(callerClaim({ [JOB_CLAIM_ENV]: value }), null, String(value));
});

test("the claim reaches the session and its MCP server, and never the merger", async (t) => {
  const home = stampHome(t, "stamp-pinned", [{ stdout: doneStream(), runState: recordedDone(), exitCode: 0 }]);
  await runJob(home);
  const [call] = fakeCalls(home.planPath);
  const worker = `${call.claim}`.split(":").slice(1).join(":");
  assert.ok(call.claim.startsWith("1:") && worker.length > 0, call.claim);
  const config = JSON.parse(call.argv[call.argv.indexOf("--mcp-config") + 1]);
  assert.equal(config.mcpServers.nightqueue.env[JOB_CLAIM_ENV], call.claim);

  const noClaim = JSON.parse(mcpConfigArg(home.env, null));
  assert.equal(noClaim.mcpServers.nightqueue.env[JOB_CLAIM_ENV], undefined);
  assert.equal(mergerEnv({ env: { [JOB_CLAIM_ENV]: "1:host" }, dir: "/tmp/x", files: [] })[JOB_CLAIM_ENV], undefined);
});

test("a caller's claim: the row alone with no variable, the variable alone in an outage, over only when both exist and disagree", (t) => {
  const home = stampHome(t, "stamp-caller");
  seedRunning(home, { attempts: 2, worker: "host:1", session: "sess-2" });
  const row = getJob(home.id, home.env);

  assert.deepEqual(claimOfCaller(row, home.env), { attempt: 2, session: "sess-2" });
  assert.deepEqual(claimOf(home, "2:host:1"), { attempt: 2, session: "sess-2" });
  assert.deepEqual(claimOf(home, "2:"), { attempt: 2, session: "sess-2" });
  assert.deepEqual(claimOfCaller(null, { [JOB_CLAIM_ENV]: "2:host:1" }), { attempt: 2, session: null });
  assert.equal(claimOfCaller(null, {}), null);
  assert.equal(claimOf(home, "1:host:1").over, true, "an earlier attempt");
  assert.equal(claimOf(home, "2:host:9").over, true, "the same attempt under another runner");
  openDb(home.env).prepare("UPDATE jobs SET status = 'failed' WHERE id = ?").run(home.id);
  assert.equal(claimOf(home, "2:host:1").over, true, "a claim that ended");
});

test("a late gate or termination between the retry and the next claim stays on disk and decides nothing", async (t) => {
  for (const write of [
    (run, claim) => recordOutcome({ ...run, status: "gate", notice: QUESTION, claim }),
    (run, claim) => recordTermination({ ...run, phase: "qa", reason: QUESTION, by: "qa-guardian", claim }),
  ]) {
    const home = stampHome(t, "stamp-between", [FAILED, CLEAN]);
    await runJob(home);
    await applyRetry({ id: home.id, env: home.env });

    const row = getJob(home.id, home.env);
    write({ projectId: home.projectId, slug: row.slug, env: home.env }, { attempt: 1, session: null });
    await runJob(home);

    assert.equal(fakeCalls(home.planPath).length, 2, "the next claim did not spawn");
    const after = getJob(home.id, home.env);
    assert.equal(after.status, "failed");
    assert.equal(after.notice_md, `${SILENT_STOP_NOTICE}\n\n${IGNORED_ONE}`);
    const held = stateOf(home);
    assert.equal(JSON.stringify(held).includes(QUESTION), true, "the record was deleted");
  }
});

// A spawn that, once the session has run and before the runner reads the record, plays a survivor of attempt 1 calling a writer.
function survivorAtExit(home, write) {
  return (bin, args, options) => {
    const claim = claimOf(home, `1:${getJob(home.id, home.env).worker}`);
    const child = spawn(bin, args, options);
    child.once("exit", () => write({ projectId: home.projectId, slug: SLUG, env: home.env, claim }));
    return child;
  };
}

for (const [name, write, kind] of [
  ["run_outcome", (run) => recordOutcome({ ...run, status: "gate", notice: QUESTION }), "outcome"],
  ["run_terminate", (run) => recordTermination({ ...run, phase: "qa", reason: QUESTION, wip: { commit: "abc" } }), "termination"],
  ["run_phase_done", (run) => recordPhaseDone({ ...run, phase: "commit", verdict: QUESTION }), "phase"],
  ["run check", (run) => recordCheck({ ...run, check: "05", memo: { line: "VERDICT: PASSED", ok: true, completed: true, digest: "d" }, done: { phase: "qa", verdict: QUESTION } }), "check"],
]) {
  test(`${name} from a session of attempt 1 during attempt 2 changes no slot and no phase, and attempt 2's own done still ends done`, async (t) => {
    const stamped = { outcome: { status: "done", notice: "Delivered by attempt 2.", prUrl: PR_URL, claim: { attempt: 2, session: "s" } } };
    const home = stampHome(t, `stamp-during-${kind}`, [FAILED, { stdout: doneStream(), runState: stamped, exitCode: 0 }]);
    await runJob(home);
    await applyRetry({ id: home.id, env: home.env });

    let answer = null;
    const spawnImpl = survivorAtExit(home, (run) => {
      answer = write(run);
    });
    await runJob(home, { spawnImpl });

    assert.equal(answer.status, "kept");
    assert.match(answer.reason, /attempt 1 of this job is over/);
    const row = getJob(home.id, home.env);
    assert.equal(row.status, "done");
    assert.equal(row.notice_md, `Delivered by attempt 2.\n\n${IGNORED_ONE}`);
    const state = stateOf(home);
    assert.deepEqual(state.ignoredRecords.map((entry) => [entry.kind, entry.claim.attempt, entry.claim.over]), [[kind, 1, true]]);
    assert.equal(state.outcome.notice, "Delivered by attempt 2.");
    assert.equal(state.termination, undefined);
    assert.equal(JSON.stringify(state.phases ?? []).includes(QUESTION), false, "a late phase entered the list");
    assert.equal(JSON.stringify(state.checks ?? {}).includes("VERDICT"), false, "a late check memo entered the state");
  });
}

test("the real MCP tools answer a session of an earlier attempt with an error naming it, and the entry is kept", async (t) => {
  const home = stampHome(t, "stamp-mcp");
  seedRunning(home, { attempts: 2, worker: "host:1" });
  recordOutcome({ projectId: home.projectId, slug: SLUG, status: "done", notice: "Attempt 2 delivered.", claim: { attempt: 2, session: "sess-1" }, env: home.env });
  const before = stateOf(home);
  const client = await connectMcp(t, home, "1:host:1");

  for (const [name, args] of [
    ["run_outcome", { status: "gate", notice: QUESTION }],
    ["run_terminate", { phase: "qa", reason: QUESTION }],
    ["run_phase_done", { phase: "qa", verdict: QUESTION }],
  ]) {
    const answer = await client.callTool({ name, arguments: args });
    assert.equal(answer.isError, true, name);
    assert.match(textOf(answer), /attempt 1 of this job is over/, name);
  }

  const state = stateOf(home);
  assert.deepEqual(state.ignoredRecords.map((entry) => entry.kind), ["outcome", "termination", "phase"]);
  assert.deepEqual(state.outcome, before.outcome);
  assert.equal(state.termination, undefined);
  assert.equal(state.phases, undefined);
});

test("a session whose variable matches the row writes normally, with its claim on the record and no `over`", async (t) => {
  const home = stampHome(t, "stamp-own");
  seedRunning(home, { attempts: 2, worker: "host:1", session: "sess-2" });
  const client = await connectMcp(t, home, "2:host:1");

  for (const [name, args] of [
    ["run_phase_done", { phase: "triage", artifact: "01-triage.md", verdict: "CONFIRMED" }],
    ["run_outcome", { status: "gate", notice: "A real question?" }],
    ["run_terminate", { phase: "qa", reason: "Stopped on purpose." }],
  ]) {
    const answer = await client.callTool({ name, arguments: args });
    assert.notEqual(answer.isError, true, textOf(answer));
  }

  const state = stateOf(home);
  const stamp = { attempt: 2, session: "sess-2" };
  assert.deepEqual([state.phases[0].claim, state.outcome.claim, state.termination.claim], [stamp, stamp, stamp]);
  assert.equal(state.ignoredRecords, undefined);
});

test("the slot rule: a lower stamp is displaced with no merge, a higher one holds, the pull request stays and nothing is lost", (t) => {
  const home = stampHome(t, "stamp-slot");
  const run = { projectId: home.projectId, slug: SLUG, env: home.env };
  recordOutcome({ ...run, status: "gate", notice: "Old?", claim: { attempt: 1, session: "s1" } });
  recordPrUrl({ ...run, prUrl: PR_URL, prTitle: "fix" });
  recordTermination({ ...run, phase: "qa", reason: "Old stop.", claim: { attempt: 1, session: "s1" } });

  assert.equal(recordOutcome({ ...run, status: "done", claim: { attempt: 2, session: "s2" } }).status, "written");
  assert.equal(recordTermination({ ...run, phase: "commit", reason: "New stop.", claim: { attempt: 2, session: "s2" } }).status, "written");

  const state = stateOf(home);
  assert.deepEqual([state.outcome.status, state.outcome.notice, state.outcome.prUrl, state.outcome.prTitle, state.outcome.claim], ["done", undefined, PR_URL, "fix", { attempt: 2, session: "s2" }]);
  assert.equal(state.termination.reason, "New stop.");
  assert.deepEqual(state.ignoredRecords.map((entry) => [entry.kind, entry.claim.attempt, entry.record.notice ?? entry.record.reason]), [["outcome", 1, "Old?"], ["termination", 1, "Old stop."]]);

  const held = stateBytes(home);
  const late = recordOutcome({ ...run, status: "gate", notice: "Late?", claim: { attempt: 1, session: "s1" } });
  assert.equal(late.status, "kept");
  assert.notEqual(stateBytes(home), held);
  const after = stateOf(home);
  assert.equal(after.outcome.status, "done");
  assert.equal(after.ignoredRecords.at(-1).record.notice, "Late?");
});

test("a write with no claim stamps nothing and an old stamp does not stay on the new record", (t) => {
  const home = stampHome(t, "stamp-none");
  const run = { projectId: home.projectId, slug: SLUG, env: home.env };
  recordOutcome({ ...run, status: "gate", notice: "Stamped?", claim: { attempt: 1, session: null } });
  recordOutcome({ ...run, status: "gate", notice: "From outside a job." });
  const { outcome } = stateOf(home);
  assert.deepEqual([outcome.notice, outcome.claim], ["From outside a job.", undefined]);
});

test("a late pull request record touches no outcome, while the runner's own and a live claim's land, stamped by the claim", (t) => {
  const home = stampHome(t, "stamp-publish");
  seedRunning(home, { attempts: 2, worker: "host:1" });
  const run = { projectId: home.projectId, slug: SLUG, env: home.env };
  const over = claimOf(home, "1:host:1");

  assert.equal(recordOutcome({ ...run, status: "done", claim: over }).status, "kept");
  assert.equal(recordPrUrl({ ...run, prUrl: PR_URL, prTitle: "fix", claim: over }).status, "kept");
  assert.equal(stateOf(home).outcome, undefined);

  assert.equal(recordPrUrl({ ...run, prUrl: PR_URL, prTitle: "fix" }).status, "written");
  assert.deepEqual([stateOf(home).outcome.prUrl, stateOf(home).outcome.claim], [PR_URL, undefined]);
  assert.equal(recordPrUrl({ ...run, prUrl: PR_URL, claim: claimOf(home, "2:host:1") }).status, "written");
  assert.deepEqual(stateOf(home).outcome.claim, { attempt: 2, session: "sess-1" });
});

test("the pin carries the claim's ordinal, and a pin that reads no ordinal keeps comparing the attempt and the worker", () => {
  assert.equal(claimPin({ attempt: 1, worker: "host:42", ordinal: 3 }), "1:host:42#3");
  assert.deepEqual(callerClaim({ [JOB_CLAIM_ENV]: "1:host:42#3" }), { attempt: 1, worker: "host:42", ordinal: 3 });
  assert.equal(claimPin({ attempt: 1, worker: null, ordinal: undefined }), "1:");
  assert.deepEqual(callerClaim({ [JOB_CLAIM_ENV]: "1:#3" }), { attempt: 1, worker: null, ordinal: 3 });
  assert.deepEqual(callerClaim({ [JOB_CLAIM_ENV]: "1:host#x" }), { attempt: 1, worker: "host#x" });
});

test("a pre-park session is over once the same runner re-claims at the same attempt, and its gate never replaces the re-claim's delivery", (t) => {
  const home = stampHome(t, "stamp-park-ghost");
  const { env, id, projectId } = home;
  openDb(env).prepare("UPDATE jobs SET slug = ? WHERE id = ?").run(SLUG, id);
  const worker = "host:1";
  const parked = claimNextJob({ worker, cap: null }, env);
  parkJob(id, { worker, notBefore: new Date(Date.now() - 60_000).toISOString() }, env);
  const again = claimNextJob({ worker, cap: null }, env);
  assert.deepEqual([parked.attempts, again.attempts, again.worker], [1, 1, worker]);
  const pinOf = (job) => claimPin({ attempt: job.attempts, worker: job.worker, ordinal: job.claim_attempt });
  assert.notEqual(pinOf(parked), pinOf(again), "the two claims share a pin");

  const run = { projectId, slug: SLUG, env };
  const live = claimOf(home, pinOf(again));
  assert.equal(live.over, undefined, "the live claim read as over");
  assert.equal(recordOutcome({ ...run, status: "done", notice: "Delivered.", claim: live }).status, "written");

  const ghost = claimOf(home, pinOf(parked));
  assert.equal(ghost.over, true, "the claim the park gave back read as live");
  assert.equal(recordOutcome({ ...run, status: "gate", notice: QUESTION, claim: ghost }).status, "kept");

  const state = stateOf(home);
  assert.deepEqual([state.outcome.status, state.outcome.notice], ["done", "Delivered."]);
  assert.deepEqual(state.ignoredRecords.map((entry) => entry.record.notice), [QUESTION]);
});

test("a zombie's late writes stay bounded, keep the first ones and every attempt's line, and never touch the live claim's record", (t) => {
  const home = stampHome(t, "stamp-bound");
  const run = { projectId: home.projectId, slug: SLUG, env: home.env };
  const notice = "z".repeat(20 * 1024);
  assert.equal(recordOutcome({ ...run, status: "gate", notice: "The live question?", claim: { attempt: 3, session: null } }).status, "written");
  recordOutcome({ ...run, status: "gate", notice: "First late.", claim: { attempt: 1, session: null, over: true } });
  for (let call = 0; call < 12; call += 1) recordOutcome({ ...run, status: "gate", notice, claim: { attempt: 1, session: null, over: true } });
  const refused = recordOutcome({ ...run, status: "gate", notice, claim: { attempt: 2, session: null, over: true } });

  assert.match(refused.reason, /attempt 2 of this job is over/);
  assert.ok(stateBytes(home).length < 64 * 1024, `state.json holds ${stateBytes(home).length} bytes`);
  const state = stateOf(home);
  assert.equal(state.outcome.notice, "The live question?");
  const ofAttempt = (attempt) => state.ignoredRecords.filter((entry) => entry.claim.attempt === attempt);
  assert.equal(ofAttempt(1).length, 5);
  assert.equal(ofAttempt(1)[0].record.notice, "First late.");
  assert.equal(ofAttempt(1)[4].notKept, 8);
  assert.ok(ofAttempt(2)[0].record.truncated.length <= 4096 + 3);
  assert.deepEqual(recordsOfClaim(state, 3).ignoredAttempts, [1, 2]);
});

test("a late `run publish` is refused before any side effect, with its record set aside", async (t) => {
  const home = stampHome(t, "stamp-late-publish");
  seedRunning(home, { attempts: 2, worker: "host:1" });
  const run = { projectId: home.projectId, slug: SLUG, env: home.env };
  recordRunFields({ ...run, fields: { branch: "job/live" } });
  const out = [];
  const code = await openPullRequest({ run: { ...run, claim: claimOf(home, "1:host:1") }, cwd: "/nonexistent", bodyFile: "/nonexistent", body: "", title: "t", removeWorktree: true, ctx: { env: home.env, out: (line) => out.push(line), err: () => {} } });
  assert.equal(code, 1);
  assert.match(out[0], /^REFUSED: attempt 1 of this job is over/);
  const state = stateOf(home);
  assert.deepEqual([state.branch, state.outcome, state.ignoredRecords.map((entry) => entry.kind)], ["job/live", undefined, ["outcome"]]);
});

test("run_set and run_skip of a session of an earlier attempt answer that it is over and write nothing but the set-aside", async (t) => {
  const home = stampHome(t, "stamp-mcp-fields");
  seedRunning(home, { attempts: 2, worker: "host:1" });
  recordRunFields({ projectId: home.projectId, slug: SLUG, fields: { branch: "job/live" }, env: home.env });
  const client = await connectMcp(t, home, "1:host:1");
  for (const [name, args] of [
    ["run_set", { branch: "job/late" }],
    ["run_set", { qa_stage_a: { artifact: "05-qa.md" } }],
    ["run_skip", { phase: "qa", by: "coder", reason: "A late skip." }],
  ]) {
    const answer = await client.callTool({ name, arguments: args });
    assert.equal(answer.isError, true, name);
    assert.match(textOf(answer), /attempt 1 of this job is over/, name);
  }
  const state = stateOf(home);
  assert.deepEqual([state.branch, state.qaStageA, state.skips], ["job/live", undefined, undefined]);
  assert.deepEqual(state.ignoredRecords.map((entry) => entry.kind), ["fields", "fields", "skip"]);
});

test("a late `run_terminate` never reaches the wip commit, and its stop is set aside", (t) => {
  const home = stampHome(t, "stamp-late-terminate");
  const run = { projectId: home.projectId, slug: SLUG, env: home.env };
  recordRunFields({ ...run, fields: { worktree: "/nonexistent/live-worktree" } });
  const answer = terminateRun({ ...run, phase: "qa", reason: QUESTION, claim: { attempt: 1, session: null, over: true } });
  assert.deepEqual([answer.status, answer.wip, answer.notice], ["kept", null, null]);
  const state = stateOf(home);
  assert.deepEqual([state.termination, state.wip, state.ignoredRecords.map((entry) => entry.kind)], [undefined, undefined, ["termination"]]);
});

test("the `run_terminate` description names when a retry does not resume", async (t) => {
  const home = stampHome(t, "stamp-terminate-text");
  const client = await connectMcp(t, home, "1:host:1");
  const { tools } = await client.listTools();
  const { description } = tools.find((tool) => tool.name === "run_terminate");
  for (const condition of [/resume cap/, /no completed phase/, /terminal verdict/, /already done/]) assert.match(description, condition);
});

test("a paragraph a run wrote that opens like the runtime's ignored line reaches the origins; the exact line alone does not", () => {
  const own = "Question?\n\nignored a record of attempt 3 because it was malformed, which one?";
  assert.equal(runOwnNotice(own), own);
  assert.equal(withoutRuntimeAppendedLines(own), own);
  assert.equal(runOwnNotice(`${own}\n\n${IGNORED_ONE}\n\nignored a record of attempt 12`), own);
  assert.equal(runOwnNotice("ignored a record of attempt 1 "), null);
});

test("a re-spawn inside one claim reads the first spawn's record, with no ignored line", async (t) => {
  const gate = { ...recordedGate({ notice: "Asked in spawn 1?" }) };
  gate.outcome.claim = { attempt: 1, session: "spawn-1" };
  const home = stampHome(t, "stamp-respawn", [{ stdout: transientFailureStream(), exitCode: 1 }, { stdout: SILENT, runState: gate, exitCode: 0 }]);
  await runJob(home);
  const row = getJob(home.id, home.env);
  assert.deepEqual([row.status, row.notice_md, row.attempts], ["gate", "Asked in spawn 1?", 1]);
});

test("a parked run re-claimed at the same attempt ends on its own record, with no ignored line", async (t) => {
  const limited = toNdjson([systemInitEvent(), slugEvent(SLUG), rateLimitEvent({ status: "rejected", resetsAt: Math.floor(Date.now() / 1000) - 3600 })]);
  const done = recordedDone({ notice: "Delivered before the park." });
  done.outcome.claim = { attempt: 1, session: "spawn-1" };
  const home = stampHome(t, "stamp-park", [{ stdout: limited, runState: done, exitCode: 1 }, CLEAN]);

  await runJob(home);
  assert.equal(getJob(home.id, home.env).attempts, 0, "the park did not give the attempt back");
  await runJob(home);

  const row = getJob(home.id, home.env);
  assert.deepEqual([row.status, row.pr_url, row.attempts, row.notice_md], ["done", PR_URL, 1, "Delivered before the park."]);
});

test("a retried terminated run resumes after its last phase; a termination of another attempt no longer closes it", async (t) => {
  const home = stampHome(t, "stamp-resume", [FAILED, CLEAN]);
  await runJob(home);
  const run = { projectId: home.projectId, slug: getJob(home.id, home.env).slug, env: home.env };
  recordPhaseDone({ ...run, phase: "triage", artifact: "01-triage.md", verdict: "PROCEED", claim: { attempt: 1, session: null } });
  await applyRetry({ id: home.id, env: home.env });
  recordTermination({ ...run, phase: "qa", reason: "A stop written after the retry.", claim: { attempt: 1, session: null } });

  await runJob(home);

  const prompt = fakeCalls(home.planPath)[1].argv.join("\n");
  assert.ok(prompt.includes("RESUME CANDIDATE"), prompt.slice(0, 400));
  assert.ok(prompt.includes("Last completed phase: triage"), prompt.slice(0, 400));
});

test("a claim over a run another job stamped gates before the spawn and gives the attempt back; a plain retry refuses and --fresh moves it", async (t) => {
  const home = stampHome(t, "stamp-foreign-claim");
  openDb(home.env).prepare("UPDATE jobs SET slug = ? WHERE id = ?").run(SLUG, home.id);
  writeRunTerminal({ projectId: home.projectId, slug: SLUG, terminal: { status: "gate", jobId: home.id + 1 }, env: home.env });
  const bytes = stateBytes(home);

  const cycle = await runJob(home);

  assert.deepEqual(cycle.processed.map((report) => report.code), [BLOCK_CODES.FOREIGN_RUN]);
  assert.equal(existsSync(`${home.planPath}.calls.jsonl`), false, "the claim spawned over a foreign stamp");
  const row = getJob(home.id, home.env);
  assert.deepEqual([row.status, row.attempts, row.blocked_code], ["gate", 0, BLOCK_CODES.FOREIGN_RUN]);
  assert.ok(row.notice_md.includes(`stamped by J-${home.id + 1}`), row.notice_md);
  assert.ok(row.notice_md.includes("--fresh"), row.notice_md);
  assert.equal(stateBytes(home), bytes);

  await assert.rejects(applyRetry({ id: home.id, env: home.env }), /stamped by/);
  assert.equal(stateBytes(home), bytes);
  const { job } = await applyRetry({ id: home.id, fresh: true, env: home.env });
  assert.equal(job.status, "pending");
});

const OVER_NOTHING_WRITTEN = /^nightqueue: attempt 1 of this job is over, so nothing was written; end this session$/;
const GIT_VARS = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "nightqueue",
  GIT_AUTHOR_EMAIL: "nightqueue@example.invalid",
  GIT_COMMITTER_NAME: "nightqueue",
  GIT_COMMITTER_EMAIL: "nightqueue@example.invalid",
};

// Runs `nightqueue run ...` in this process as a session of the job under the pinned claim.
async function runAsClaim({ env, id }, pinned, argv) {
  const out = [];
  const err = [];
  const callerEnv = { ...env, NIGHTQUEUE_JOB_ID: String(id), [JOB_CLAIM_ENV]: pinned };
  const code = await runNightqueue(["run", ...argv], { env: callerEnv, out: (line) => out.push(line), err: (line) => err.push(line), stdout: { write: () => {} } });
  return { code, out, err };
}

// A home whose job runs attempt 2 under `host:1`, with a real git worktree recorded on its run.
function liveWorktreeHome(t, name) {
  const base = stampHome(t, name);
  const home = { ...base, env: { ...base.env, ...GIT_VARS } };
  seedRunning(home, { attempts: 2, worker: "host:1" });
  const repo = initGitRepo(makeDir(t, `${name}-worktree`));
  recordRunFields({ projectId: home.projectId, slug: SLUG, fields: { worktree: repo }, env: home.env });
  return { home, repo };
}

// What git answers in the worktree, trimmed.
function gitIn(repo, args) {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
}

test("a late `run commit` commits nothing in the live worktree and writes nothing, while the live claim's commits", async (t) => {
  const { home, repo } = liveWorktreeHome(t, "stamp-late-commit");
  writeFileSync(join(repo, "a.txt"), "the live attempt's work\n");
  writeFileSync(join(runDir(home.projectId, SLUG, home.env), "04-implementation.md"), `# Implementation\n\n## Modified files\n${join(repo, "a.txt")}\n`);
  const message = join(makeDir(t, "late-commit-message"), "message.txt");
  writeFileSync(message, "fix: the worker\n");
  const head = gitIn(repo, ["rev-parse", "HEAD"]);
  const before = stateBytes(home);

  const late = await runAsClaim(home, "1:host:1", ["commit", "--message-file", message]);

  assert.equal(late.code, 1);
  assert.match(late.err[0], OVER_NOTHING_WRITTEN);
  assert.equal(gitIn(repo, ["rev-parse", "HEAD"]), head);
  assert.equal(gitIn(repo, ["status", "--porcelain"]), "?? a.txt");
  assert.equal(stateBytes(home), before);

  const live = await runAsClaim(home, "2:host:1", ["commit", "--message-file", message]);
  assert.equal(live.code, 0, live.err.join("\n"));
  assert.notEqual(gitIn(repo, ["rev-parse", "HEAD"]), head);
});

test("a late `run pr` writes no template and no record, with or without a body, while the live claim's records the template", async (t) => {
  const { home } = liveWorktreeHome(t, "stamp-late-pr");
  const body = join(makeDir(t, "late-pr-body"), "body.md");
  writeFileSync(body, "# fix: the worker\n");
  const before = stateBytes(home);

  for (const argv of [["pr", "--template"], ["pr", "--body-file", body]]) {
    const late = await runAsClaim(home, "1:host:1", argv);
    assert.equal(late.code, 1, argv.join(" "));
    assert.deepEqual(late.out, [], argv.join(" "));
    assert.match(late.err[0], OVER_NOTHING_WRITTEN, argv.join(" "));
    assert.equal(stateBytes(home), before, argv.join(" "));
  }

  assert.equal((await runAsClaim(home, "2:host:1", ["pr", "--template"])).code, 0);
  assert.notEqual(stateOf(home).prTemplate, undefined);
});

test("a late `run check 01` writes no brief, keeps the termination and the slug and records nothing, while the live claim's does all of it", async (t) => {
  const home = stampHome(t, "stamp-late-check");
  const slug = provisionalSlug(getJob(home.id, home.env));
  openDb(home.env).prepare("UPDATE jobs SET status = 'running', attempts = 2, worker = 'host:1', slug = ? WHERE id = ?").run(slug, home.id);
  const run = { projectId: home.projectId, slug, env: home.env };
  recordTermination({ ...run, phase: "triage", reason: "A stop of the triage.", by: RUNTIME_AUTHOR });
  const dir = runDir(home.projectId, slug, home.env);
  const brief = "## Brief\n**Affected area:** src/a.mjs\n**Context:** the listing\n**Objective:** list the jobs\n**Expected outcome:** the archived jobs are listed\n**Type:** bug/error\n**Commit type:** fix\n**Slug:** active-jobs-filter\n\n";
  const triage = `# Triage\n\n${brief}## Verdict: PROCEED\n\nEvidence level: 3\n\n## Diagnosis\n- Confirmed root cause: y (src/a.mjs:1)\n- Symptom proof: a.mjs:1 calls b\n\n## Validated brief\nFix the thing.\n\n## Out of scope\n- None.\n\n## Request gaps\n- None.\n\n## Open items\n- Which listing is meant?\n`;
  writeFileSync(join(dir, "01-triage.md"), triage);
  const before = readFileSync(join(dir, "state.json"), "utf8");

  const late = await runAsClaim(home, "1:host:1", ["check", "01"]);

  assert.equal(late.code, 1);
  assert.deepEqual(late.out, []);
  assert.match(late.err[0], OVER_NOTHING_WRITTEN);
  assert.equal(existsSync(join(dir, "00-brief.md")), false, "the late check wrote the brief");
  assert.equal(readFileSync(join(dir, "state.json"), "utf8"), before);
  assert.equal(getJob(home.id, home.env).slug, slug);

  const live = await runAsClaim(home, "2:host:1", ["check", "01"]);
  const moved = runDir(home.projectId, "active-jobs-filter", home.env);
  assert.ok(live.out.includes("recorded: termination cleared"), live.out.join("\n"));
  assert.equal(getJob(home.id, home.env).slug, "active-jobs-filter");
  assert.ok(existsSync(join(moved, "00-brief.md")));
});

test("the read-only `run dir` of a late session still answers", async (t) => {
  const { home } = liveWorktreeHome(t, "stamp-late-dir");
  const answer = await runAsClaim(home, "1:host:1", ["dir"]);
  assert.deepEqual([answer.code, answer.out], [0, [runDir(home.projectId, SLUG, home.env)]]);
});

const PRE_PARK_STAMP = { attempt: 1, session: "spawn-1", ordinal: 1 };
const PARKED_STREAM = toNdjson([systemInitEvent(), slugEvent(SLUG), rateLimitEvent({ status: "rejected", resetsAt: Math.floor(Date.now() / 1000) - 3600 })]);

for (const [kind, runState] of [
  ["gate", { outcome: { status: "gate", notice: QUESTION, claim: PRE_PARK_STAMP } }],
  ["termination", { termination: { phase: "qa", reason: QUESTION, by: "qa-guardian", claim: PRE_PARK_STAMP } }],
]) {
  test(`a ${kind} written before a park does not decide the re-claim, stays on disk, and the notice names it`, async (t) => {
    const home = stampHome(t, `stamp-park-${kind}`, [{ stdout: PARKED_STREAM, runState, exitCode: 1 }, CLEAN]);

    await runJob(home);
    assert.equal(getJob(home.id, home.env).attempts, 0, "the park did not give the attempt back");
    await runJob(home);

    const row = getJob(home.id, home.env);
    assert.deepEqual([row.status, row.attempts, row.notice_md], ["failed", 1, `${SILENT_STOP_NOTICE}\n\n${IGNORED_ONE}`]);
    assert.equal(JSON.stringify(stateOf(home)).includes(QUESTION), true, "the record was deleted");
    assert.equal(stateOf(home).terminal.claim.ordinal, 2, "the witness does not carry the re-claim's ordinal");

    await applyRetry({ id: home.id, env: home.env });
    assert.equal(stateOf(home).terminal, undefined, "the retry did not consume the re-claim's witness");
    assert.equal(JSON.stringify(stateOf(home)).includes(QUESTION), true, "the retry consumed the record from before the park");
  });
}

test("a parked run still resumes after its last completed phase: `phases[]` stays read whole, and a termination from before the park closes nothing", async (t) => {
  const phase = { phase: "triage", at: new Date().toISOString(), artifact: "01-triage.md", verdict: "PROCEED", claim: PRE_PARK_STAMP };
  const runState = { phases: [phase], termination: { phase: "qa", reason: QUESTION, claim: PRE_PARK_STAMP } };
  const home = stampHome(t, "stamp-park-phases", [{ stdout: PARKED_STREAM, runState, exitCode: 1 }, CLEAN]);

  await runJob(home);
  await runJob(home);

  const prompt = fakeCalls(home.planPath)[1].argv.join("\n");
  assert.ok(prompt.includes("RESUME CANDIDATE"), prompt.slice(0, 400));
  assert.ok(prompt.includes("Last completed phase: triage"), prompt.slice(0, 400));
});

test("a stamp holds the pin's ordinal, and the slot rule compares it inside one attempt", (t) => {
  const home = stampHome(t, "stamp-ordinal-slot");
  seedRunning(home, { attempts: 1, worker: "host:1", session: "sess-1" });
  const run = { projectId: home.projectId, slug: SLUG, env: home.env };
  const [first, second] = [{ attempt: 1, session: "s", ordinal: 1 }, { attempt: 1, session: "s", ordinal: 2 }];

  recordOutcome({ ...run, status: "gate", notice: "Before the park?", claim: claimOf(home, "1:host:1#1") });
  assert.deepEqual(stateOf(home).outcome.claim, { attempt: 1, session: "sess-1", ordinal: 1 });

  recordOutcome({ ...run, status: "done", notice: "After the park.", claim: second });
  const state = stateOf(home);
  assert.deepEqual([state.outcome.status, state.outcome.notice, state.outcome.claim], ["done", "After the park.", second]);
  assert.deepEqual(state.ignoredRecords.map((entry) => [entry.kind, entry.record.notice, entry.claim.ordinal]), [["outcome", "Before the park?", 1]]);

  assert.equal(recordOutcome({ ...run, status: "gate", notice: "Stale.", claim: first }).status, "kept");
  assert.equal(stateOf(home).outcome.notice, "After the park.");
});

test("a reader compares the ordinal where the stamp holds one; an older stamp or a reader with none compares the attempt", () => {
  const withStampOf = (claim) => ({ outcome: { status: "gate", notice: "Asked?", claim } });
  const notice = (state, attempt, ordinal) => recordsOfClaim(state, attempt, ordinal).outcome.notice;

  assert.equal(notice(withStampOf({ attempt: 1, session: "s", ordinal: 1 }), 1, 2), undefined);
  assert.deepEqual(recordsOfClaim(withStampOf({ attempt: 1, session: "s", ordinal: 1 }), 1, 2).ignoredAttempts, [1]);
  assert.equal(notice(withStampOf({ attempt: 1, session: "s", ordinal: 2 }), 1, 2), "Asked?");
  assert.equal(notice(withStampOf({ attempt: 1, session: "s" }), 1, 2), "Asked?");
  assert.equal(notice(withStampOf({ attempt: 2, session: "s" }), 1, 2), undefined);
  assert.equal(notice(withStampOf({ attempt: 1, session: "s", ordinal: 1 }), 1, null), "Asked?");
});

test("a retry leaves a record from before the park on disk and consumes the last claim's own", async (t) => {
  const home = stampHome(t, "stamp-consume-ordinal");
  const run = { projectId: home.projectId, slug: SLUG, env: home.env };
  recordOutcome({ ...run, status: "gate", notice: "Before the park?", claim: PRE_PARK_STAMP });

  assert.equal((await consumeRunConclusion({ ...run, jobId: home.id, attempt: 1, ordinal: 2 })).status, "absent");
  assert.equal(stateOf(home).outcome.notice, "Before the park?");

  assert.equal((await consumeRunConclusion({ ...run, jobId: home.id, attempt: 1, ordinal: 1 })).status, "written");
  assert.equal(stateOf(home).outcome.notice, undefined);
});

test("the rows of the sweep and of the reconciliation carry their last claim's ordinal", (t) => {
  const home = stampHome(t, "stamp-row-ordinal");
  const { env, id } = home;
  openDb(env).prepare("UPDATE jobs SET slug = ? WHERE id = ?").run(SLUG, id);
  const worker = "host:1";
  claimNextJob({ worker, cap: null }, env);
  parkJob(id, { worker, notBefore: new Date(Date.now() - 60_000).toISOString() }, env);
  claimNextJob({ worker, cap: null }, env);
  assert.equal(listJobsWithSlug(env).find((row) => row.id === id).claim_attempt, 2);

  openDb(env).prepare("UPDATE jobs SET lease_until = NULL WHERE id = ?").run(id);
  const seen = [];
  sweepOrphans(env, { orphanTailImpl: (row) => { seen.push(row); return null; } });
  assert.deepEqual(seen.map((row) => [row.id, row.claim_attempt]), [[id, 2]]);
});

// Starts a second process holding the run's lock for the given time, answering once it holds it with the promise of its exit.
async function holdRunLock(t, lock, holdMs) {
  const source = `
    const { mkdirSync, writeFileSync, rmSync } = require("node:fs");
    mkdirSync(${JSON.stringify(lock)}, { recursive: true });
    writeFileSync(${JSON.stringify(join(lock, "owner"))}, String(process.pid));
    setTimeout(() => rmSync(${JSON.stringify(lock)}, { recursive: true, force: true }), ${holdMs});
  `;
  const holder = spawn(process.execPath, ["-e", source], { stdio: "ignore" });
  t.after(() => holder.kill());
  const exited = new Promise((done) => holder.once("exit", done));
  while (!existsSync(join(lock, "owner"))) await new Promise((done) => setTimeout(done, 10));
  return { exited };
}

test("a second process holding the run lock: the witness refuses instead of landing, and lands once it let go", async (t) => {
  const home = stampHome(t, "stamp-witness-lock");
  const run = { projectId: home.projectId, slug: SLUG, env: home.env };
  recordOutcome({ ...run, status: "gate", notice: "A question." });
  const before = stateBytes(home);
  const { exited } = await holdRunLock(t, `${runDir(home.projectId, SLUG, home.env)}.lock`, 6000);

  const refused = writeRunTerminal({ ...run, terminal: { status: "gate", jobId: home.id, claim: { attempt: 1, session: null } } });

  assert.equal(refused.status, "kept");
  assert.match(refused.reason, /could not be locked/);
  assert.equal(stateBytes(home), before);
  await exited;
  assert.equal(writeRunTerminal({ ...run, terminal: { status: "gate", jobId: home.id, claim: { attempt: 1, session: null } } }).status, "written");
  assert.equal(stateOf(home).terminal.status, "gate");
});
