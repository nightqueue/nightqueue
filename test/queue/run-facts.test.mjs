import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { run } from "../../src/cli/index.mjs";
import { runDir } from "../../src/config/paths.mjs";
import { openDb } from "../../src/memory/db.mjs";
import { addJob, getJob } from "../../src/memory/jobs.mjs";
import { questionDigest } from "../../src/queue/question-text.mjs";
import { jobPromptText } from "../../src/queue/job-prompt.mjs";
import { readRunState } from "../../src/queue/resume.mjs";
import { applyRetry } from "../../src/queue/retry.mjs";
import { recordClaim, recordOutcome, recordPhaseDone, recordRunFields, stalledPhases } from "../../src/queue/run-state.mjs";
import { runCycle } from "../../src/queue/runner.mjs";
import { openStore } from "../../src/store/open.mjs";
import { fakeJobWorktree } from "../../test-support/job-worktree.mjs";
import { ensureProject, makeDir, makeHome, makeProject } from "../../test-support/memory.mjs";
import { argValue, fakeCalls, useFakeClaude } from "../../test-support/queue-fake.mjs";
import { rateLimitEvent, resultEvent, SLUG, slugEvent, systemInitEvent, toNdjson, transientFailureStream } from "../../test-support/streams.mjs";

const SILENT = toNdjson([systemInitEvent(), slugEvent(SLUG), resultEvent({ text: "" })]);
const FAILED = { stdout: SILENT, exitCode: 1 };
const CLEAN = { stdout: SILENT, exitCode: 0 };
const PARKED = { stdout: toNdjson([systemInitEvent(), slugEvent(SLUG), rateLimitEvent({ status: "rejected" }), resultEvent({ text: "" })]), exitCode: 1 };
const QUESTION = "Approve C1?";
const PLAN = `## Implementation plan\n- x\n\n## Requires user confirmation\n**Question:** ${QUESTION}\n\n## Assumptions\n- [P1] a.\n\n## Pre-mortem\n- [PM1] a.\n\n## Identified risks\n- [R1] a.\n`;
const PRS = [{ title: "Fix the worker", url: "https://github.com/acme/app/pull/7", branch: "fix/worker" }];

// The run section of one agent definition, on one line.
function agentText(agent) {
  const text = readFileSync(new URL(`../../plugin/agents/${agent}.md`, import.meta.url), "utf8");
  return text.slice(text.indexOf("## Inside a run")).replace(/\s+/g, " ");
}

// A git double for the preflight: a clean checkout of the default branch.
function fakeGit() {
  const answers = { status: "", "rev-parse": "main", "symbolic-ref": "origin/main" };
  return ({ args }) => `${answers[args[0]] ?? ""}\n`;
}

// A home with one job of project `alpha`, the fake `claude` replaying the given spawns.
function makeJobHome(t, name, spawns = [CLEAN]) {
  const env = makeHome(t, name);
  makeProject(t, env, "alpha");
  const planPath = useFakeClaude(env, makeDir(t, `${name}-plan`), spawns);
  const projectId = ensureProject(env, "alpha");
  return { env, planPath, projectId, id: addJob({ projectId, prompt: "fix the worker" }, env).id };
}

// Runs the home's one job through a real cycle, with a fake worktree, a clean preflight and no real backoff.
function runJob({ env, id }, deps = {}) {
  return runCycle({ jobId: id, env, deps: { worktreeImpl: fakeJobWorktree(), gitImpl: fakeGit(), sleepImpl: async () => {}, ...deps } });
}

// Puts a job straight into the given status, bound to the run's slug.
function seedRow({ env, id }, status = "gate") {
  openDb(env).prepare("UPDATE jobs SET status = ?, slug = ?, worker = NULL WHERE id = ?").run(status, SLUG, id);
}

// The run of the home's job, under the slug its row holds now.
function runOf({ env, id, projectId }) {
  return { projectId, slug: getJob(id, env).slug, env };
}

// The state.json bytes of the run.
function stateBytes(home) {
  const { projectId, slug, env } = runOf(home);
  return readFileSync(join(runDir(projectId, slug, env), "state.json"), "utf8");
}

// The prompt of the given spawn.
function promptOfSpawn({ planPath }, index) {
  return argValue(fakeCalls(planPath)[index].argv, "-p");
}

// Runs `nightqueue run check 03` as the job, answering the lines it printed.
async function check03({ env, id }) {
  const out = [];
  await run(["run", "check", "03"], { env: { ...env, NIGHTQUEUE_JOB_ID: String(id) }, out: (line) => out.push(line), err: (line) => out.push(line), stdout: { write: () => {} } });
  return out;
}

// A job at the Phase 3 pause: its plan in the run directory and the pause recorded with the question's digest.
function pausedAtPhase3(t, name, spawns) {
  const home = makeJobHome(t, name, spawns);
  seedRow(home);
  const dir = runDir(home.projectId, SLUG, home.env);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "03-plan.md"), PLAN);
  recordRunFields({ projectId: home.projectId, slug: SLUG, fields: { type: "feature/refactor" }, env: home.env });
  writeFileSync(join(dir, "00-brief.md"), "## Brief\n**Affected area:** a\n**Objective:** b\n**Expected outcome:** c\n**Type:** feature/refactor\n");
  recordGate(home);
  return home;
}

// Records a pause on the plan's question.
function recordGate({ env, projectId }) {
  assert.equal(recordOutcome({ projectId, slug: SLUG, status: "gate", notice: "asked", questionDigest: questionDigest(QUESTION), env }).status, "written");
}

test("1: a run with four recorded phases, retried after a failure, gets them as facts: no decision and none of the lines the prompt dropped", async (t) => {
  const phases = ["triage", "explore", "architecture", "implementation"].map((phase, index) => ({ phase, artifact: `0${index + 1}-${phase}.md`, verdict: "ok", at: `2026-09-06T0${index}:00:00Z` }));
  const home = makeJobHome(t, "facts-four-phases", [{ ...FAILED, runState: { phases } }, CLEAN]);
  await runJob(home);
  await applyRetry({ id: home.id, env: home.env });

  await runJob(home);

  const prompt = promptOfSpawn(home, 1);
  const line = prompt.split("\n").find((text) => text.startsWith("Recorded phases: "));
  assert.equal(line, `Recorded phases: ${phases.map((entry) => `${entry.phase} · ok · ${entry.artifact} · ${entry.at}`).join(" | ")}`);
  assert.ok(prompt.includes(`RUN FACTS (slug \`${SLUG}\`)`), prompt);
  assert.equal(/resume from/i.test(prompt), false, prompt);
  for (const gone of ["Open the pull request", "Requires user confirmation", "Shell rule"]) assert.equal(prompt.includes(gone), false, gone);
  assert.match(prompt, /^\/nightqueue:resolve fix the worker\n/);
});

test("a first claim prints no facts block, and recording it leaves the pipeline version unpinned for the next one", async (t) => {
  const home = makeJobHome(t, "facts-first-claim");
  await runJob(home);
  assert.equal(promptOfSpawn(home, 0).includes("RUN FACTS"), false);
  const state = readRunState(runOf(home));
  assert.deepEqual(state.lastClaim, { attempt: 1, phases: 0, answers: 0 });
  assert.equal(state.previousClaim, undefined);
});

test("a respawn inside one claim reads the phases recorded before it", async (t) => {
  const home = makeJobHome(t, "facts-respawn", [
    { stdout: transientFailureStream(), runState: { phases: [{ phase: "triage", artifact: "01-triage.md", verdict: "PROCEED", at: "t" }] }, exitCode: 1 },
    CLEAN,
  ]);
  await runJob(home);
  assert.equal(promptOfSpawn(home, 0).includes("RUN FACTS"), false);
  assert.ok(promptOfSpawn(home, 1).includes("Recorded phases: triage · PROCEED · 01-triage.md · t"), promptOfSpawn(home, 1));
});

test("2: a Phase 3 answer lands in the state and leaves the row empty; the block lists it, the check answers it, a second pause asks again and a new note answers that", async (t) => {
  const home = pausedAtPhase3(t, "facts-answer", [CLEAN]);
  const pause = `CONFIRM: requires-user-confirmation — ${QUESTION}`;
  assert.ok((await check03(home)).includes(pause));

  await applyRetry({ id: home.id, note: "go ahead", env: home.env });

  const state = readRunState(runOf(home));
  assert.deepEqual(state.answers, [{ text: "go ahead", at: state.answers[0].at, attempt: 0 }]);
  assert.equal(getJob(home.id, home.env).operator_note, null);
  const { at } = state.answers[0];
  assert.ok((await check03(home)).includes(`CONFIRM: answered (${at})`));

  await runJob(home);
  const prompt = promptOfSpawn(home, 0);
  assert.ok(prompt.includes(`Answers: 1. ${at} — go ahead`), prompt);
  assert.equal(prompt.includes("OPERATOR ANSWER TO THE GATE"), false, prompt);

  recordGate(home);
  assert.ok((await check03(home)).includes(pause), "a second pause on the same question read as answered");

  openDb(home.env).prepare("UPDATE jobs SET status = 'gate' WHERE id = ?").run(home.id);
  await applyRetry({ id: home.id, note: "and add the test", env: home.env });
  const answers = readRunState(runOf(home)).answers;
  assert.deepEqual(answers.map((entry) => [entry.text, entry.attempt]), [["go ahead", 0], ["and add the test", 1]]);
  assert.ok((await check03(home)).includes(`CONFIRM: answered (${answers[1].at})`));
});

test("every answer reaches the triager and the architect through state.json, oldest first", async (t) => {
  const home = pausedAtPhase3(t, "facts-answers-state");
  await applyRetry({ id: home.id, note: "first answer", env: home.env });
  recordGate(home);
  openDb(home.env).prepare("UPDATE jobs SET status = 'gate', attempts = 1 WHERE id = ?").run(home.id);
  await applyRetry({ id: home.id, note: "second answer", env: home.env });

  assert.deepEqual(readRunState(runOf(home)).answers.map((entry) => entry.text), ["first answer", "second answer"]);
  assert.ok(agentText("triager").includes("every entry of `answers` of `<RUN_DIR>/state.json`, oldest first"));
  assert.ok(agentText("architect").includes("Read `type` and `answers` of `<RUN_DIR>/state.json`"));
  assert.equal(agentText("coder").includes("`answers`"), false, "the coder reads the answers");
});

test("3: a note on a job with no run directory stays on the row and reaches the prompt and the triager", async (t) => {
  const home = makeJobHome(t, "facts-no-run-dir");
  openDb(home.env).prepare("UPDATE jobs SET status = 'gate' WHERE id = ?").run(home.id);

  await applyRetry({ id: home.id, note: "pick A", env: home.env });
  assert.equal(getJob(home.id, home.env).operator_note, "pick A");

  await runJob(home);
  const prompt = promptOfSpawn(home, 0);
  assert.ok(prompt.includes("OPERATOR ANSWER TO THE GATE: pick A"), prompt);
  assert.equal(prompt.includes("RUN FACTS"), false, prompt);
  assert.ok((await jobPromptText({ jobId: home.id }, home.env)).endsWith("pick A"), "the note does not reach 00-prompt.md, where the triager reads it");
});

test("a run directory with no state.json yet takes the answer in a state of its own", async (t) => {
  const home = makeJobHome(t, "facts-no-state");
  seedRow(home);
  mkdirSync(runDir(home.projectId, SLUG, home.env), { recursive: true });

  await applyRetry({ id: home.id, note: "go", env: home.env });

  const state = readRunState(runOf(home));
  assert.deepEqual([state.schemaVersion, state.slug, state.answers[0].text], [1, SLUG, "go"]);
  assert.equal(getJob(home.id, home.env).operator_note, null);
});

test("an unreadable state.json is never overwritten by an answer: its bytes stay and the note stays on the row", async (t) => {
  const home = makeJobHome(t, "facts-corrupt-state");
  seedRow(home);
  const dir = runDir(home.projectId, SLUG, home.env);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "state.json"), "{ not json");

  await applyRetry({ id: home.id, note: "go", env: home.env });

  assert.equal(readFileSync(join(dir, "state.json"), "utf8"), "{ not json");
  assert.equal(getJob(home.id, home.env).operator_note, "go");
});

test("a commit that fails after the answer was recorded says so, and the same retry again appends it once", async (t) => {
  const home = pausedAtPhase3(t, "facts-commit-fails");
  const failing = (env) => {
    const store = openStore(env);
    return { ...store, jobs: { ...store.jobs, retryJob: async () => { throw new Error("the commit failed"); } } };
  };
  await assert.rejects(applyRetry({ id: home.id, note: "go ahead", env: home.env, storeImpl: failing }), /the commit failed\n.*already consumed/);
  assert.equal(readRunState(runOf(home)).answers.length, 1);

  await applyRetry({ id: home.id, note: "go ahead", env: home.env });

  assert.equal(readRunState(runOf(home)).answers.length, 1, "the retried commit recorded the answer twice");
  assert.equal(getJob(home.id, home.env).operator_note, null);
});

// Puts the row back at a gate a preflight block wrote, its attempt given back.
function gatedByPreflight({ env, id }) {
  openDb(env).prepare("UPDATE jobs SET status = 'gate', blocked_code = 'worktree-unavailable', worker = NULL WHERE id = ?").run(id);
}

test("the same note sent again is its own answer once a claim ran after the first, on the attempt that claim gave back", async (t) => {
  const home = pausedAtPhase3(t, "facts-answer-after-claim");
  await applyRetry({ id: home.id, note: "go ahead", env: home.env });
  assert.equal(recordClaim({ ...runOf(home), attempt: 1 }).status, "written");
  gatedByPreflight(home);

  await applyRetry({ id: home.id, note: "go ahead", env: home.env });

  assert.deepEqual(readRunState(runOf(home)).answers.map((entry) => [entry.text, entry.attempt]), [["go ahead", 0], ["go ahead", 0]]);
  assert.equal(getJob(home.id, home.env).operator_note, null);
});

test("the same note sent again with no claim after the first appends nothing, even when an older claim is on record", async (t) => {
  const home = pausedAtPhase3(t, "facts-answer-older-claim");
  assert.equal(recordClaim({ ...runOf(home), attempt: 1 }).status, "written");
  await applyRetry({ id: home.id, note: "go ahead", env: home.env });
  gatedByPreflight(home);

  await applyRetry({ id: home.id, note: "go ahead", env: home.env });

  assert.equal(readRunState(runOf(home)).answers.length, 1);
});

test("an answer or a row note that is a piece of the job's prompt still reaches the triager, and a repeated answer stays repeated", async (t) => {
  const home = pausedAtPhase3(t, "facts-answer-in-prompt");
  await applyRetry({ id: home.id, note: "fix", env: home.env });
  assert.equal(recordClaim({ ...runOf(home), attempt: 1 }).status, "written");
  gatedByPreflight(home);
  await applyRetry({ id: home.id, note: "fix", env: home.env });
  openDb(home.env).prepare("UPDATE jobs SET operator_note = 'worker' WHERE id = ?").run(home.id);

  assert.deepEqual(readRunState(runOf(home)).answers.map((entry) => entry.text), ["fix", "fix"]);
  assert.equal(await jobPromptText({ jobId: home.id }, home.env), "fix the worker\n\nworker");
});

test("a pending row from before the upgrade keeps its note in the prompt, and the check still asks: no second mechanism", async (t) => {
  const home = pausedAtPhase3(t, "facts-pre-upgrade", [CLEAN]);
  openDb(home.env).prepare("UPDATE jobs SET status = 'pending', operator_note = 'old answer' WHERE id = ?").run(home.id);

  assert.ok((await check03(home)).includes(`CONFIRM: requires-user-confirmation — ${QUESTION}`));
  await runJob(home);
  assert.ok(promptOfSpawn(home, 0).includes("OPERATOR ANSWER TO THE GATE: old answer"), promptOfSpawn(home, 0));
});

// The refusal line of a run stalled on a count of phases.
function stalledLine(id, phases) {
  return `J-${id} made no progress in its last two attempts (same ${phases} phases, no new answer): answer with a note, or retry --fresh`;
}

// A job whose last two attempts both ended with nothing new recorded, through real claims.
async function stalledHome(t, name) {
  const home = makeJobHome(t, name, [FAILED, FAILED, CLEAN]);
  await runJob(home);
  await applyRetry({ id: home.id, env: home.env });
  await runJob(home);
  return home;
}

test("5: after two no-progress claims a plain retry is refused with the exact line and nothing written", async (t) => {
  const home = await stalledHome(t, "guard-refused");
  const bytes = stateBytes(home);
  const row = getJob(home.id, home.env);

  await assert.rejects(applyRetry({ id: home.id, env: home.env }), (err) => err.message === stalledLine(home.id, 0));

  assert.equal(stateBytes(home), bytes, "the refusal wrote the state");
  assert.deepEqual(getJob(home.id, home.env), row, "the refusal wrote the row");
});

test("5: the same stalled job passes with a note", async (t) => {
  const home = await stalledHome(t, "guard-note");
  const { job } = await applyRetry({ id: home.id, note: "try the other way", env: home.env });
  assert.equal(job.status, "pending");
  assert.equal(readRunState(runOf(home)).answers.at(-1).text, "try the other way");
});

test("5: the same stalled job passes with --fresh", async (t) => {
  const home = await stalledHome(t, "guard-fresh");
  const { job } = await applyRetry({ id: home.id, fresh: true, env: home.env });
  assert.equal(job.status, "pending");
});

test("a job the preflight gated on a stalled run passes with no note, and the guard refuses again once a claim fails with nothing new", async (t) => {
  const home = makeJobHome(t, "guard-preflight", [FAILED, PARKED, FAILED]);
  await runJob(home);
  await applyRetry({ id: home.id, env: home.env });
  await runJob(home);
  assert.equal(stalledPhases(readRunState(runOf(home))), 0, "the park did not stall the run");
  openDb(home.env).prepare("UPDATE jobs SET not_before = NULL WHERE id = ?").run(home.id);
  await runJob(home, { resolveBinImpl: () => null });
  assert.notEqual(getJob(home.id, home.env).blocked_code, null, "the preflight did not gate the row");

  const { job } = await applyRetry({ id: home.id, env: home.env });

  assert.equal(job.status, "pending");
  assert.equal(job.blocked_code, null);
  await runJob(home);
  assert.equal(getJob(home.id, home.env).status, "failed");
  await assert.rejects(applyRetry({ id: home.id, env: home.env }), (err) => err.message === stalledLine(home.id, 0));
});

test("one no-progress claim passes, and so does a new phase or a new answer between the claims", async (t) => {
  const home = makeJobHome(t, "guard-progress", [FAILED, FAILED, CLEAN]);
  await runJob(home);
  assert.equal((await applyRetry({ id: home.id, env: home.env })).job.status, "pending");
  await runJob(home);
  recordPhaseDone({ ...runOf(home), phase: "triage", artifact: "01-triage.md", verdict: "PROCEED" });
  assert.equal((await applyRetry({ id: home.id, env: home.env })).job.status, "pending", "a new phase counts as progress");
});

test("the guard counts the claims: another attempt shifts the last one, the same attempt claimed again does not, and a wip record is no progress", (t) => {
  const env = makeHome(t, "guard-claims");
  const projectId = ensureProject(env, "alpha");
  const target = { projectId, slug: SLUG, env };
  recordRunFields({ ...target, fields: { type: "bug/error" } });

  assert.equal(recordClaim({ ...target, attempt: 1 }).status, "written");
  assert.equal(stalledPhases(readRunState(target)), null, "one claim stalled the run");
  assert.equal(recordClaim({ ...target, attempt: 1 }).status, "written");
  assert.equal(readRunState(target).previousClaim, undefined, "the same attempt claimed again moved the last claim");
  assert.equal(stalledPhases(readRunState(target)), null);

  assert.equal(recordClaim({ ...target, attempt: 2 }).status, "written");
  assert.deepEqual(readRunState(target).previousClaim, { attempt: 1, phases: 0, answers: 0 });
  assert.equal(stalledPhases(readRunState(target)), 0);

  const withWip = { ...readRunState(target), wip: { commit: "abcdef1234", short: "abcdef1", files: ["a.mjs"] } };
  assert.equal(stalledPhases(withWip), 0, "a wip commit counted as progress");
  assert.equal(stalledPhases({ ...withWip, answers: [{ text: "go" }] }), null, "a new answer did not count");
  assert.equal(stalledPhases({ ...withWip, phases: [{ phase: "triage" }] }), null, "a new phase did not count");
  for (const held of [null, undefined, [], "text"]) assert.equal(stalledPhases(held), null);
});

test("a claim creates no state where none exists and needs a real attempt", (t) => {
  const env = makeHome(t, "guard-no-state");
  const target = { projectId: ensureProject(env, "alpha"), slug: SLUG, env };
  assert.equal(recordClaim({ ...target, attempt: 1 }).status, "kept");
  assert.equal(existsSync(join(runDir(target.projectId, SLUG, env), "state.json")), false);
  assert.equal(recordClaim({ ...target, attempt: "1" }).status, "kept");
});

test("6: a real claim reads the job's pipeline: `resolve` by default, the row's when it holds another, nothing spawned on a name out of the pattern", async (t) => {
  const named = makeJobHome(t, "pipeline-named");
  openDb(named.env).prepare("UPDATE jobs SET pipeline = 'close-x' WHERE id = ?").run(named.id);
  await runJob(named);
  assert.match(promptOfSpawn(named, 0), /^\/nightqueue:close-x fix the worker\n/);

  const bad = makeJobHome(t, "pipeline-bad");
  openDb(bad.env).prepare("UPDATE jobs SET pipeline = 'Bad_Name' WHERE id = ?").run(bad.id);
  await runJob(bad).catch(() => null);
  assert.equal(fakeCalls(bad.planPath).length, 0, "a bad pipeline name reached a spawn");
});

test("7: open pull requests found at claim are in origin/open-prs.md and the triager's prompt, never in the root prompt, and an undetermined lookup removes a stale file", async (t) => {
  const home = makeJobHome(t, "prs-origin", [FAILED, CLEAN]);
  delete home.env.NIGHTQUEUE_NO_PR_CHECK;
  seedRow(home, "pending");
  const origin = join(runDir(home.projectId, SLUG, home.env), "origin");
  mkdirSync(origin, { recursive: true });
  writeFileSync(join(origin, "linear-ENG-7.md"), "the ticket");

  await runJob(home, { prListImpl: () => PRS });

  const prompt = promptOfSpawn(home, 0);
  assert.ok(prompt.includes("### linear-ENG-7"), prompt);
  assert.equal(prompt.includes("Open pull requests"), false, prompt);
  assert.equal(prompt.includes("open-prs"), false, prompt);
  const file = join(origin, "open-prs.md");
  assert.ok(readFileSync(file, "utf8").includes("- Fix the worker · https://github.com/acme/app/pull/7 · fix/worker"));
  assert.ok(agentText("triager").includes("Read every file of `<RUN_DIR>/origin/`, when the directory exists, `open-prs.md` included"), "the triager no longer reads the open pull requests");

  await applyRetry({ id: home.id, env: home.env });
  await runJob(home, { prListImpl: () => null });
  assert.equal(existsSync(file), false, "an undetermined lookup left the stale file");
});

test("an empty lookup writes the frame alone", async (t) => {
  const home = makeJobHome(t, "prs-empty");
  delete home.env.NIGHTQUEUE_NO_PR_CHECK;
  seedRow(home, "pending");
  await runJob(home, { prListImpl: () => [] });
  const text = readFileSync(join(runDir(home.projectId, SLUG, home.env), "origin", "open-prs.md"), "utf8");
  assert.match(text, /^Open pull requests matching this job:\n<<<UNTRUSTED DATA[^\n]*>>>\n\n<<<END UNTRUSTED DATA>>>\n$/);
});
