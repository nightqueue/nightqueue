import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { dbPath, jobLogPath, runDir } from "../../src/config/paths.mjs";
import { addJob, bindRunSlug, claimJobById, countsByStatus, finishJob, retryJob } from "../../src/memory/jobs.mjs";
import { saveRunState } from "../../src/queue/resume.mjs";
import { snapshotPatch } from "../../src/studio/events.mjs";
import { ensureProject, makeHome, makeProject } from "../../test-support/memory.mjs";
import { agentToolUseEvent, assistantEvent, attemptMarker, LANE_TOOL_USE_ID, resultEvent, secondsIntoAttempt, systemInitEvent, taskNotificationEvent, toNdjson, toolResultEvent, toolUseEvent } from "../../test-support/streams.mjs";
import { readEvents, startStudio, studioCookie } from "../../test-support/studio.mjs";

// Waits the given number of milliseconds.
function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms));
}

// A home with one project and one pending job, the smallest queue a stream has something to say about.
function seededHome(t, name) {
  const env = makeHome(t, name);
  makeProject(t, env, "alpha");
  const id = addJob({ projectId: ensureProject(env, "alpha"), prompt: "fix the worker", tier: "complex" }, env).id;
  return { env, id };
}

// The size and modification time of the database file and its WAL, the witnesses of a write.
function dbWitness(env) {
  return [dbPath(env), `${dbPath(env)}-wal`].map((path) => (existsSync(path) ? `${statSync(path).size}:${statSync(path).mtimeMs}` : "absent"));
}

test("the first event is the decorated snapshot: jobs with their studio cells, runners, counts and the pause", async (t) => {
  const { env, id } = seededHome(t, "studio-events-snapshot");
  const { port } = await startStudio(t, env);
  const events = await readEvents(port, { headers: { cookie: studioCookie(port) }, until: (list) => list.length >= 1 });
  assert.equal(events[0].name, "snapshot");
  const snapshot = events[0].data;
  assert.equal(snapshot.counts.pending, 1);
  assert.deepEqual(snapshot.runners, []);
  assert.equal(snapshot.queue_paused, false);
  const job = snapshot.jobs.find((entry) => entry.id === id);
  assert.equal(job.title, "fix the worker");
  assert.deepEqual(job.studio, { status_label: "pending", close_state: null, closing: false, reason: null, tokens_label: "-", glyph: null });
});

test("a job added while a client listens arrives as a patch that upserts exactly that row", async (t) => {
  const { env, id } = seededHome(t, "studio-events-patch");
  const { port } = await startStudio(t, env);
  let added = null;
  const events = await readEvents(port, {
    headers: { cookie: studioCookie(port) },
    until: (list) => {
      if (list.length === 1 && added === null) added = addJob({ projectId: ensureProject(env, "alpha"), prompt: "write the changelog" }, env).id;
      return list.some((event) => event.name === "patch" && event.data.jobs?.upsert.some((job) => job.id === added));
    },
  });
  const patch = events.find((event) => event.name === "patch").data;
  assert.deepEqual(patch.jobs.upsert.map((job) => job.id), [added]);
  assert.deepEqual(patch.jobs.remove, []);
  assert.deepEqual(patch.jobs.order, [added, id]);
  assert.equal(patch.set.counts.pending, 2);
});

test("the poll only reads: the database and its WAL do not move across three ticks and the rows stay the same", async (t) => {
  const { env } = seededHome(t, "studio-events-read-only");
  const { port } = await startStudio(t, env);
  await sleep(1500);
  const before = dbWitness(env);
  const countsBefore = countsByStatus(env);
  const events = await readEvents(port, { headers: { cookie: studioCookie(port) }, until: () => false, timeoutMs: 3500 }).catch((err) => err);
  assert.match(String(events?.message ?? ""), /did not deliver in time; got: snapshot/, "the stream never delivered its snapshot");
  assert.deepEqual(dbWitness(env), before, "a poll of /events wrote to the database");
  assert.deepEqual(countsByStatus(env), countsBefore);
});

test("an unchanged queue makes no patch, and a changed one patches only what moved", () => {
  const base = { runners: [], counts: { pending: 1 }, jobs: [{ id: 1, status: "pending" }], sections: [{ name: "jobs", ok: true, ms: 3 }] };
  assert.equal(snapshotPatch(base, { ...base, sections: [{ name: "jobs", ok: true, ms: 9 }] }), null);
  const next = { ...base, counts: { pending: 0 }, jobs: [{ id: 1, status: "running" }] };
  assert.deepEqual(snapshotPatch(base, next), { set: { counts: { pending: 0 } }, jobs: { upsert: [{ id: 1, status: "running" }], remove: [], order: [1] } });
});

test("a running row whose only change is the active and wall time a read derives makes no patch, and a new attempt row does", () => {
  const job = { id: 1, status: "running", attempts_log: [{ attempt: 1, finished_at: null }], active_s: 10, wall_s: 10 };
  const base = { runners: [], counts: { running: 1 }, jobs: [job] };
  assert.equal(snapshotPatch(base, { ...base, jobs: [{ ...job, active_s: 12, wall_s: 12 }] }), null);
  const moved = { ...job, attempts_log: [...job.attempts_log, { attempt: 2, finished_at: null }], active_s: 12 };
  assert.deepEqual(snapshotPatch(base, { ...base, jobs: [moved] })?.jobs.upsert, [moved]);
});

// The log of one finished attempt: a coder lane that edits a file, then the orchestrator publishing.
function writeAttemptLog(env, id) {
  const path = jobLogPath(id, env);
  mkdirSync(dirname(path), { recursive: true });
  const events = [
    systemInitEvent(),
    agentToolUseEvent({ subagentType: "nightqueue:coder", description: "implement the fix", model: "opus", timestamp: secondsIntoAttempt(10) }),
    toolUseEvent({ name: "Edit", id: "toolu_edit", input: { file_path: "/repo/src/worker.mjs" }, parentToolUseId: LANE_TOOL_USE_ID, timestamp: secondsIntoAttempt(20) }),
    taskNotificationEvent({ durationMs: 60000 }),
    toolUseEvent({ name: "Bash", id: "toolu_pub", input: { command: "nightqueue run publish --message-file m.txt", description: "publish" }, timestamp: secondsIntoAttempt(80) }),
    resultEvent(),
  ];
  writeFileSync(path, `${attemptMarker(1)}\n${toNdjson(events)}`);
}

test("a job stream narrates the current attempt with structured fields, its timeline, its files and its end", async (t) => {
  const { env, id } = seededHome(t, "studio-events-job");
  claimJobById(id, { worker: "host:1", cap: 4 }, env);
  writeAttemptLog(env, id);
  finishJob(id, { worker: "host:1", status: "done", prUrl: "https://github.com/acme/api/pull/7" }, env);
  const { port } = await startStudio(t, env);
  const events = await readEvents(port, { path: `/events?job=J-${id}`, headers: { cookie: studioCookie(port) }, until: (list) => list.some((event) => event.name === "end") });
  assert.equal(events[0].name, "meta");
  assert.equal(events[0].data.log_path, jobLogPath(id, env));
  const narration = events.filter((event) => event.name === "narration").flatMap((event) => event.data);
  const laneOpen = narration.find((event) => event.kind === "laneOpen");
  assert.deepEqual([laneOpen.glyph, laneOpen.agent, laneOpen.phase, laneOpen.model], ["▶", "coder", 4, "opus"]);
  const laneClose = narration.find((event) => event.kind === "laneClose");
  assert.deepEqual([laneClose.agent, laneClose.durationMs], ["coder", 60000]);
  const edit = narration.find((event) => event.tool === "Edit");
  assert.equal(edit.file, "worker.mjs");
  const publish = narration.find((event) => event.tool === "Bash");
  assert.equal(publish.phase, 7);
  assert.equal(publish.clock, "01:20");
  const timeline = events.filter((event) => event.name === "timeline").at(-1).data;
  assert.equal(timeline.track, "Standard");
  const coder = timeline.phases.find((phase) => phase.number === 4);
  assert.deepEqual([coder.state, coder.durationMs, coder.model], ["done", 60000, "opus"]);
  assert.equal(timeline.phases.find((phase) => phase.number === 7).state, "done");
  assert.equal(timeline.phases.find((phase) => phase.number === 2).state, "skip");
  assert.deepEqual(events.find((event) => event.name === "files").data, ["worker.mjs"]);
  assert.deepEqual([events.at(-1).data.status, events.at(-1).data.final], ["done", true]);
});

// The log of one attempt that plans, checks its artifact and hands a coder lane's report back.
function writeRichAttemptLog(env, id) {
  const path = jobLogPath(id, env);
  mkdirSync(dirname(path), { recursive: true });
  const events = [
    systemInitEvent(),
    assistantEvent("Plan written.\n\n| step | file |\n|---|---|\n| 1 | worker.mjs |", { timestamp: secondsIntoAttempt(5) }),
    toolUseEvent({ name: "Bash", id: "toolu_chk", input: { command: "nightqueue run check 03" }, timestamp: secondsIntoAttempt(6) }),
    agentToolUseEvent({ subagentType: "nightqueue:coder", model: "opus", timestamp: secondsIntoAttempt(10) }),
    toolUseEvent({ name: "Edit", id: "toolu_edit", input: { file_path: "/repo/src/worker.mjs" }, parentToolUseId: LANE_TOOL_USE_ID, timestamp: secondsIntoAttempt(20) }),
    taskNotificationEvent({ summary: "## Done\nthe worker is fixed" }),
    resultEvent(),
  ];
  writeFileSync(path, `${attemptMarker(1)}\n${toNdjson(events)}`);
}

test("a job stream carries the studio's rich narration: phase and report events, bodies and lane ids", async (t) => {
  const env = makeHome(t, "studio-events-rich");
  makeProject(t, env, "alpha");
  const projectId = ensureProject(env, "alpha");
  const id = addJob({ projectId, prompt: "fix the worker", tier: "complex" }, env).id;
  claimJobById(id, { worker: "host:1", cap: 4 }, env);
  bindRunSlug(id, { worker: "host:1", candidates: ["fix-the-worker"] }, env);
  mkdirSync(runDir(projectId, "fix-the-worker", env), { recursive: true });
  writeFileSync(join(runDir(projectId, "fix-the-worker", env), "03-plan.md"), "# The plan\n\nsteps\n");
  writeRichAttemptLog(env, id);
  finishJob(id, { worker: "host:1", status: "done", prUrl: "https://github.com/acme/api/pull/9" }, env);
  const { port } = await startStudio(t, env);
  const events = await readEvents(port, { path: `/events?job=J-${id}`, headers: { cookie: studioCookie(port) }, until: (list) => list.some((event) => event.name === "end") });
  const narration = events.filter((event) => event.name === "narration").flatMap((event) => event.data);
  assert.deepEqual(
    narration.filter((event) => event.kind === "phase").map((event) => [event.phase, event.agent, event.model]),
    [
      [0, "orchestrator", null],
      [4, "coder", "opus"],
    ],
  );
  const report = narration.find((event) => event.kind === "report");
  assert.deepEqual([report.artifact, report.title, report.bytes], ["03-plan.md", "The plan", 18]);
  const plan = narration.find((event) => event.kind === "text");
  assert.deepEqual([plan.text, plan.body_truncated, plan.body_offset], ["Plan written.", false, null]);
  assert.match(plan.body, /\| 1 \| worker\.mjs \|$/);
  assert.equal(narration.find((event) => event.tool === "Edit").laneId, LANE_TOOL_USE_ID);
  assert.equal(narration.find((event) => event.kind === "laneClose").body, "## Done\nthe worker is fixed");
  assert.deepEqual([report.body, report.at, narration.find((event) => event.kind === "attempt").artifact], [null, null, null]);
  const coder = events.filter((event) => event.name === "timeline").at(-1).data.phases.find((phase) => phase.number === 4);
  assert.deepEqual([coder.state, coder.model], ["done", "opus"]);
});

// A `run check 03` tool call of the orchestrator, `seconds` into the attempt.
function runCheckEvent(id, seconds) {
  return toolUseEvent({ name: "Bash", id, input: { command: "nightqueue run check 03" }, timestamp: secondsIntoAttempt(seconds) });
}

// A running job claimed with no run slug yet, its log holding the attempt and one early `run check 03`.
function lateSlugJob(t, name) {
  const env = makeHome(t, name);
  makeProject(t, env, "alpha");
  const projectId = ensureProject(env, "alpha");
  const id = addJob({ projectId, prompt: "fix the worker", tier: "complex" }, env).id;
  claimJobById(id, { worker: "host:1", cap: 4 }, env);
  const path = jobLogPath(id, env);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${attemptMarker(1)}\n${toNdjson([systemInitEvent(), runCheckEvent("toolu_a", 5)])}`);
  return { env, id, projectId, path };
}

// Binds the job's run slug, optionally writing its plan artifact, the way a run started after the stream opened does.
function bindLateSlug({ env, id, projectId }, { plan }) {
  bindRunSlug(id, { worker: "host:1", candidates: ["fix-the-worker"] }, env);
  mkdirSync(runDir(projectId, "fix-the-worker", env), { recursive: true });
  if (plan) writeFileSync(join(runDir(projectId, "fix-the-worker", env), "03-plan.md"), "# The plan\n\nsteps\n");
}

// Reads a job stream, running `act` once on the first narration batch, until `done` holds.
async function readJobStream(t, job, { act, done }) {
  const { port } = await startStudio(t, job.env);
  let acted = false;
  const until = (list) => {
    if (!acted && list.some((event) => event.name === "narration")) {
      acted = true;
      act();
    }
    return done(list);
  };
  return await readEvents(port, { path: `/events?job=J-${job.id}`, headers: { cookie: studioCookie(port) }, timeoutMs: 8000, until });
}

// Every narration event of a stream, in order.
function narrationOf(events) {
  return events.filter((event) => event.name === "narration").flatMap((event) => event.data);
}

test("a stream opened before the job's slug was bound narrates the report signalled after it, past its tool line", async (t) => {
  const job = lateSlugJob(t, "studio-events-late-slug");
  const hasReport = (list) => narrationOf(list).some((event) => event.kind === "report");
  const act = () => {
    bindLateSlug(job, { plan: true });
    appendFileSync(job.path, toNdjson([runCheckEvent("toolu_b", 9)]));
  };
  const narration = narrationOf(await readJobStream(t, job, { act, done: hasReport }));
  const reportAt = narration.findIndex((event) => event.kind === "report");
  assert.deepEqual([narration[reportAt].artifact, narration[reportAt].title, narration[reportAt].bytes], ["03-plan.md", "The plan", 18]);
  assert.ok(reportAt > narration.findLastIndex((event) => event.tool === "Bash"), "the report follows its run check line");
});

test("a report whose artifact is missing after a late slug never reaches the wire, pending or not", async (t) => {
  const job = lateSlugJob(t, "studio-events-late-slug-missing");
  const act = () => {
    bindLateSlug(job, { plan: false });
    appendFileSync(job.path, toNdjson([runCheckEvent("toolu_b", 9), assistantEvent("Checked.", { timestamp: secondsIntoAttempt(10) })]));
  };
  const done = (list) => narrationOf(list).some((event) => event.kind === "text");
  const narration = narrationOf(await readJobStream(t, job, { act, done }));
  assert.equal(narration.filter((event) => event.kind === "report").length, 0);
});

test("a job that ends right after a pending report sends the resolved report before its end", async (t) => {
  const job = lateSlugJob(t, "studio-events-late-slug-end");
  const act = () => {
    bindLateSlug(job, { plan: true });
    appendFileSync(job.path, toNdjson([runCheckEvent("toolu_b", 9), resultEvent()]));
    finishJob(job.id, { worker: "host:1", status: "done", prUrl: "https://github.com/acme/api/pull/11" }, job.env);
  };
  const events = await readJobStream(t, job, { act, done: (list) => list.some((event) => event.name === "end") });
  const reportBatch = events.findIndex((event) => event.name === "narration" && event.data.some((entry) => entry.kind === "report"));
  assert.ok(reportBatch >= 0, "a report event arrived");
  assert.ok(reportBatch < events.findIndex((event) => event.name === "end"), "the report precedes the end");
  assert.equal(narrationOf(events).find((event) => event.kind === "report").bytes, 18);
});

const SECOND_ATTEMPT_ISO = "2026-09-07T21:00:00.000Z";

// The log of a resumed job: attempt 1 triages and explores then dies, attempt 2 codes and publishes.
function writeTwoAttemptLog(env, id) {
  const path = jobLogPath(id, env);
  mkdirSync(dirname(path), { recursive: true });
  const first = [
    systemInitEvent(),
    agentToolUseEvent({ id: "toolu_tri", subagentType: "nightqueue:triager", timestamp: secondsIntoAttempt(5) }),
    assistantEvent("triaging", { messageId: "msg_tri", usage: { tokensIn: 3000 }, parentToolUseId: "toolu_tri", timestamp: secondsIntoAttempt(6) }),
    taskNotificationEvent({ toolUseId: "toolu_tri", durationMs: 40000 }),
    agentToolUseEvent({ id: "toolu_exp", subagentType: "nightqueue:explore", timestamp: secondsIntoAttempt(50) }),
    taskNotificationEvent({ toolUseId: "toolu_exp", durationMs: 30000 }),
    resultEvent({ subtype: "error_during_execution" }),
  ];
  const second = [
    systemInitEvent(),
    agentToolUseEvent({ id: "toolu_cod", subagentType: "nightqueue:coder", timestamp: secondsIntoAttempt(10, SECOND_ATTEMPT_ISO) }),
    taskNotificationEvent({ toolUseId: "toolu_cod", durationMs: 60000 }),
    toolUseEvent({ name: "Bash", id: "toolu_pub", input: { command: "nightqueue run publish --message-file m.txt" }, timestamp: secondsIntoAttempt(80, SECOND_ATTEMPT_ISO) }),
    resultEvent(),
  ];
  writeFileSync(path, `${attemptMarker(1)}\n${toNdjson(first)}${attemptMarker(2, SECOND_ATTEMPT_ISO)}\n${toNdjson(second)}`);
}

test("a resumed job streams every attempt as narration in order, its timeline keeps both attempts' phases and the run's tier", async (t) => {
  const env = makeHome(t, "studio-events-resumed");
  makeProject(t, env, "alpha");
  const projectId = ensureProject(env, "alpha");
  const id = addJob({ projectId, prompt: "fix the worker" }, env).id;
  claimJobById(id, { worker: "host:1", cap: 4 }, env);
  bindRunSlug(id, { worker: "host:1", candidates: ["fix-the-worker"] }, env);
  saveRunState({ projectId, slug: "fix-the-worker", env, state: { tier: "complex" } });
  writeTwoAttemptLog(env, id);
  finishJob(id, { worker: "host:1", status: "done", prUrl: "https://github.com/acme/api/pull/8" }, env);
  const { port } = await startStudio(t, env);
  const events = await readEvents(port, { path: `/events?job=J-${id}`, headers: { cookie: studioCookie(port) }, until: (list) => list.some((event) => event.name === "end") });
  assert.equal(events[0].data.tier, "complex", "the run's tier stands in for the row's null tier");
  const narration = events.filter((event) => event.name === "narration").flatMap((event) => event.data);
  assert.deepEqual([narration[0].kind, narration[0].text], ["attempt", "attempt 1"]);
  const triager = narration.findIndex((event) => event.kind === "laneOpen" && event.agent === "triager");
  const second = narration.findIndex((event) => event.kind === "attempt" && event.text === "attempt 2");
  assert.ok(triager > 0 && second > triager, "the triager lane of attempt 1 comes before attempt 2");
  assert.equal(narration.some((event) => event.kind === "usage"), false);
  assert.deepEqual(events.at(-1).data, { status: "done", reason: "job done", final: true });
  const timeline = events.filter((event) => event.name === "timeline").at(-1).data;
  assert.equal(timeline.track, "Standard");
  const phase = (number) => timeline.phases.find((entry) => entry.number === number);
  assert.deepEqual([phase(1).state, phase(1).durationMs, phase(1).tokens_label], ["done", 40000, "~3k"]);
  assert.deepEqual([phase(2).state, phase(2).durationMs], ["done", 30000]);
  assert.deepEqual([phase(4).state, phase(4).durationMs], ["done", 60000]);
  assert.equal(phase(3).state, "skip");
});

// A claimed job whose first attempt stopped at a gate, its log holding that attempt.
function gatedJob(t, name) {
  const { env, id } = seededHome(t, name);
  claimJobById(id, { worker: "host:1", cap: 4 }, env);
  const path = jobLogPath(id, env);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${attemptMarker(1)}\n${toNdjson([systemInitEvent(), assistantEvent("Need a decision.", { timestamp: secondsIntoAttempt(5) }), resultEvent()])}`);
  finishJob(id, { worker: "host:1", status: "gate", noticeMd: "which way?" }, env);
  return { env, id, path };
}

// Answers the gate, appends the second attempt to the log and claims the job again, the way a retried run starts.
function resumeGatedJob({ env, id, path }) {
  retryJob(id, { note: "go left" }, env);
  appendFileSync(path, `${attemptMarker(2, SECOND_ATTEMPT_ISO)}\n${toNdjson([systemInitEvent(), assistantEvent("Going left.", { timestamp: secondsIntoAttempt(5, SECOND_ATTEMPT_ISO) })])}`);
  claimJobById(id, { worker: "host:1", cap: 4 }, env);
}

test("a gated job's stream ends without closing, then carries the retried attempt on the same connection after a resume", async (t) => {
  const job = gatedJob(t, "studio-events-gate-resume");
  const { port } = await startStudio(t, job.env);
  let answered = false;
  const until = (list) => {
    if (!answered && list.some((event) => event.name === "end")) {
      answered = true;
      resumeGatedJob(job);
    }
    return narrationOf(list).some((event) => event.text === "Going left.");
  };
  const events = await readEvents(port, { path: `/events?job=J-${job.id}`, headers: { cookie: studioCookie(port) }, timeoutMs: 15000, until });
  const end = events.findIndex((event) => event.name === "end");
  assert.deepEqual(events[end].data, { status: "gate", reason: "job gate", final: false });
  const resume = events.findIndex((event) => event.name === "resume");
  assert.ok(resume > end, "the resume follows the non-final end");
  assert.deepEqual(events[resume].data, { status: "running" });
  const afterResume = narrationOf(events.slice(resume));
  assert.deepEqual([afterResume[0].kind, afterResume[0].text], ["attempt", "attempt 2"]);
  assert.equal(narrationOf(events.slice(0, end)).filter((event) => event.kind === "attempt").length, 1);
});

test("a parked stream whose job reruns and finishes between two polls narrates the new attempt before the final end", async (t) => {
  const job = gatedJob(t, "studio-events-gate-final");
  const { port } = await startStudio(t, job.env);
  let answered = false;
  const until = (list) => {
    if (!answered && list.some((event) => event.name === "end")) {
      answered = true;
      resumeGatedJob(job);
      finishJob(job.id, { worker: "host:1", status: "done" }, job.env);
    }
    return list.some((event) => event.name === "end" && event.data.final === true);
  };
  const events = await readEvents(port, { path: `/events?job=J-${job.id}`, headers: { cookie: studioCookie(port) }, timeoutMs: 15000, until });
  const finalAt = events.findIndex((event) => event.name === "end" && event.data.final === true);
  assert.deepEqual(events[finalAt].data, { status: "done", reason: "job done", final: true });
  const beforeFinal = narrationOf(events.slice(0, finalAt));
  assert.ok(beforeFinal.some((event) => event.kind === "attempt" && event.text === "attempt 2"));
  assert.ok(beforeFinal.some((event) => event.text === "Going left."));
});

test("a parked gated job's stream only reads while it waits", async (t) => {
  const job = gatedJob(t, "studio-events-gate-read-only");
  const { port } = await startStudio(t, job.env);
  let before = null;
  const until = (list) => {
    if (before === null && list.some((event) => event.name === "end")) before = dbWitness(job.env);
    return false;
  };
  const outcome = await readEvents(port, { path: `/events?job=J-${job.id}`, headers: { cookie: studioCookie(port) }, until, timeoutMs: 3500 }).catch((err) => err);
  assert.match(String(outcome?.message ?? ""), /did not deliver in time; got: .*end/);
  assert.deepEqual(dbWitness(job.env), before, "a parked job stream wrote to the database");
});

const LARGE_HISTORY_BYTES = 48 * 1024 * 1024;
const MAX_LOOP_GAP_MS = 150;

// The log of a resumed job whose first attempt carries tens of megabytes of triager chatter before it dies.
function writeLargeTwoAttemptLog(env, id) {
  const path = jobLogPath(id, env);
  mkdirSync(dirname(path), { recursive: true });
  const chatter = toNdjson([
    toolUseEvent({ name: "Read", id: "toolu_read", input: { file_path: `/repo/${"x".repeat(200)}` }, parentToolUseId: "toolu_tri", timestamp: secondsIntoAttempt(6) }),
    toolResultEvent({ toolUseId: "toolu_read", content: "y".repeat(600), parentToolUseId: "toolu_tri" }),
    assistantEvent("z ".repeat(150), { messageId: "msg_tri", usage: { tokensIn: 3000 }, parentToolUseId: "toolu_tri", timestamp: secondsIntoAttempt(6) }),
  ]);
  const filler = chatter.repeat(Math.ceil(LARGE_HISTORY_BYTES / chatter.length));
  const opening = [systemInitEvent(), agentToolUseEvent({ id: "toolu_tri", subagentType: "nightqueue:triager", timestamp: secondsIntoAttempt(5) })];
  const closing = [taskNotificationEvent({ toolUseId: "toolu_tri", durationMs: 40000 }), resultEvent({ subtype: "error_during_execution" })];
  const second = [
    systemInitEvent(),
    agentToolUseEvent({ id: "toolu_cod", subagentType: "nightqueue:coder", timestamp: secondsIntoAttempt(10, SECOND_ATTEMPT_ISO) }),
    taskNotificationEvent({ toolUseId: "toolu_cod", durationMs: 60000 }),
    resultEvent(),
  ];
  writeFileSync(path, `${attemptMarker(1)}\n${toNdjson(opening)}${filler}${toNdjson(closing)}${attemptMarker(2, SECOND_ATTEMPT_ISO)}\n${toNdjson(second)}`);
}

// Measures the longest stall of the event loop until `stop` is called.
function loopLagProbe() {
  let last = performance.now();
  let worst = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    worst = Math.max(worst, now - last);
    last = now;
  }, 10);
  return () => {
    clearInterval(timer);
    return Math.max(worst, performance.now() - last);
  };
}

test("a resumed job with a large earlier attempt streams its full timeline without stalling the server's event loop", async (t) => {
  const env = makeHome(t, "studio-events-large-log");
  makeProject(t, env, "alpha");
  const id = addJob({ projectId: ensureProject(env, "alpha"), prompt: "fix the worker", tier: "complex" }, env).id;
  claimJobById(id, { worker: "host:1", cap: 4 }, env);
  writeLargeTwoAttemptLog(env, id);
  finishJob(id, { worker: "host:1", status: "done", prUrl: "https://github.com/acme/api/pull/9" }, env);
  const { port } = await startStudio(t, env);
  const stopProbe = loopLagProbe();
  const events = await readEvents(port, { path: `/events?job=J-${id}`, headers: { cookie: studioCookie(port) }, until: (list) => list.some((event) => event.name === "end"), timeoutMs: 60000 });
  const worstGap = stopProbe();
  assert.ok(worstGap < MAX_LOOP_GAP_MS, `the event loop stalled ${Math.round(worstGap)} ms while the history replayed`);
  const first = narrationOf(events)[0];
  assert.equal(first.kind, "truncated");
  assert.match(first.text, /^log over 8 MB: the first \d+\.\d MB are not narrated; the track still counts them$/);
  const timeline = events.filter((event) => event.name === "timeline").at(-1).data;
  const phase = (number) => timeline.phases.find((entry) => entry.number === number);
  assert.deepEqual([phase(1).state, phase(1).durationMs, phase(1).tokens_label], ["done", 40000, "~3k"]);
  assert.deepEqual([phase(4).state, phase(4).durationMs], ["done", 60000]);
});

test("a job stream for an unknown job is a 404, and one for a malformed ref a 400", async (t) => {
  const { env } = seededHome(t, "studio-events-job-unknown");
  const { port } = await startStudio(t, env);
  await assert.rejects(readEvents(port, { path: "/events?job=J-999", headers: { cookie: studioCookie(port) }, until: () => true }), /answered 404/);
  await assert.rejects(readEvents(port, { path: "/events?job=nope", headers: { cookie: studioCookie(port) }, until: () => true }), /answered 400/);
});

test("the shared poller stops once its last client leaves", async (t) => {
  const { env } = seededHome(t, "studio-events-stop");
  const studio = await startStudio(t, env);
  await readEvents(studio.port, { headers: { cookie: studioCookie(studio.port) }, until: (list) => list.length >= 1 });
  await sleep(100);
  assert.equal(studio.queueStream.subscriberCount(), 0);
});
