import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { run } from "../src/cli/index.mjs";
import { runDir } from "../src/config/paths.mjs";
import { openDb } from "../src/memory/db.mjs";
import { addJob, getJob } from "../src/memory/jobs.mjs";
import { readRunState, saveRunState } from "../src/queue/resume.mjs";
import { provisionalSlug } from "../src/queue/run-slug.mjs";
import { recordOutcome, recordRunFields, recordRuntimeField } from "../src/queue/run-state.mjs";
import { initGitRepo } from "../test-support/git.mjs";
import { ensureProject, makeDir, makeHome, makeProject } from "../test-support/memory.mjs";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "next");
const SLUG = "next-row";

// Every row of the table `NEXT:` answers, frozen: a row with no fixture and a fixture with no row both fail.
const ROWS = Object.freeze([
  "b1",
  "t1", "t1-gate", "t2", "t3", "t4", "t5", "t6", "t7", "t8", "t8-still",
  "e1", "e2", "e3",
  "p1", "p2", "p3", "p4", "p5", "p6", "p7a", "p7b", "p8", "p8-staged", "p9",
  "c1", "c1-resumed", "c2", "c3", "c3-staged", "c4", "c5", "c5-staged", "c6", "c7-resumed",
  "q1", "q2", "q3", "q4a", "q4b",
  "a1", "a2", "a3", "a4",
  "q5a", "q5a-lite", "q5b", "q6a", "q6b", "q6b-rounds", "q6c", "q7", "q8", "q9", "q10-resumed",
  "v1", "v2", "v3", "v3b", "v3c", "v3d", "v4", "v4b", "v5", "v6a", "v6b", "v7a", "v7b", "v7c-staged", "v8-resumed", "v9-resumed", "v10-retried",
  "r1", "r2", "r2-verdict", "r2b", "r3", "r4", "r4b", "r5a", "r5b", "r6", "r7", "r8", "r9a", "r9b",
]);

// One fixture: its spec, the run files it seeds and the `NEXT:` line it expects.
function readRow(id) {
  const dir = join(FIXTURES, id);
  const spec = JSON.parse(readFileSync(join(dir, "fixture.json"), "utf8"));
  const texts = Object.fromEntries(readdirSync(dir).filter((file) => file.endsWith(".md")).map((file) => [file, readFileSync(join(dir, file), "utf8")]));
  return { spec, texts, expected: readFileSync(join(dir, "expected.txt"), "utf8").trim() };
}

// A job bound to a run on the slug the row asks for, with its fields recorded.
function seedJob(t, id, spec) {
  const env = makeHome(t, `next-${id}`);
  makeProject(t, env, "alpha");
  const projectId = ensureProject(env, "alpha");
  const job = addJob({ projectId, prompt: "follow the next line" }, env).id;
  const slug = spec.provisional ? provisionalSlug(getJob(job, env)) : SLUG;
  openDb(env).prepare("UPDATE jobs SET slug = ?, worker = 'w1' WHERE id = ?").run(slug, job);
  return { env: { ...env, NIGHTQUEUE_JOB_ID: String(job) }, projectId, slug, dir: runDir(projectId, slug, env) };
}

// The state a row starts from: its Type, its question and answers, its seed and its loops.
function seedState({ env, projectId, slug }, spec) {
  if (spec.type) recordRunFields({ projectId, slug, fields: { type: spec.type }, env });
  if (spec.gateQuestionDigest) recordOutcome({ projectId, slug, status: "gate", questionDigest: spec.gateQuestionDigest, env });
  const extra = { ...(spec.answers ? { answers: spec.answers } : {}), ...(spec.seed ?? {}) };
  saveRunState({ projectId, slug, env, state: { ...readRunState({ projectId, slug, env }), ...extra } });
  if (spec.loopsSeed) recordRuntimeField({ projectId, slug, name: "pipelineLoops", value: spec.loopsSeed, env });
}

// A real git worktree bound to the run, with the files the row leaves changed.
function seedWorktree(t, { env, projectId, slug }, files) {
  const repo = initGitRepo(makeDir(t, "next-worktree"));
  recordRunFields({ projectId, slug, fields: { worktree: repo }, env });
  for (const [name, text] of Object.entries(files)) writeFileSync(join(repo, name), text);
}

// A seeded run of one row, its artifacts written.
function seedRow(t, id, { spec, texts }) {
  const seeded = seedJob(t, id, spec);
  seedState(seeded, spec);
  if (spec.worktree) seedWorktree(t, seeded, spec.worktree);
  mkdirSync(seeded.dir, { recursive: true });
  for (const [file, body] of Object.entries(texts)) writeFileSync(join(seeded.dir, file), body);
  return seeded;
}

// Runs `nightqueue run check` in this process and answers what it printed.
async function runCheck(env, check, args = []) {
  const out = [];
  const err = [];
  const code = await run(["run", "check", check, ...args], { env, out: (line) => out.push(line), err: (line) => err.push(line), stdout: { write: () => {} } });
  return { code, out, err };
}

// The state of a seeded run after the check, on the slug the row ended on.
function loopsAfter({ env, projectId, slug }) {
  return readRunState({ projectId, slug, env })?.pipelineLoops ?? null;
}

// Ends the attempt of a seeded run as a plain retry does: the next attempt's claim, and no cache of the one that ended.
function retried({ env, projectId, slug }) {
  const { pipelineLoops: _cache, ...state } = readRunState({ projectId, slug, env });
  saveRunState({ projectId, slug, env, state: { ...state, lastClaim: { attempt: (state.lastClaim?.attempt ?? 1) + 1 } } });
}

// Runs a row's check, and once more on the next attempt when the row is retried; answers the last line of each run.
async function rowLastLines(seeded, spec) {
  const first = await runCheck(seeded.env, spec.check, spec.args ?? []);
  assert.equal(first.code, 0, first.err.join("\n"));
  if (spec.retried !== true) return { out: first.out, lasts: [first.out.at(-1)] };
  retried(seeded);
  const second = await runCheck(seeded.env, spec.check, spec.args ?? []);
  assert.equal(second.code, 0, second.err.join("\n"));
  return { out: second.out, lasts: [first.out.at(-1), second.out.at(-1)] };
}

test("every row has its fixture and every fixture its row", () => {
  const dirs = readdirSync(FIXTURES, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  assert.deepEqual(dirs.sort(), [...ROWS].sort());
});

for (const id of ROWS) {
  test(`row ${id}: \`run check\` answers its \`NEXT:\` as the last line, and the loops it leaves`, async (t) => {
    const row = readRow(id);
    const seeded = seedRow(t, id, row);
    const { out, lasts } = await rowLastLines(seeded, row.spec);
    for (const last of lasts) {
      if (row.spec.nextPrefix) assert.ok(last.startsWith(`NEXT: ${row.spec.nextPrefix}`), last);
      else assert.equal(last, row.expected);
    }
    assert.equal(out.filter((line) => line.startsWith("NEXT: ")).length, 1);
    if (row.spec.prints) assert.ok(out.some((line) => line.startsWith(row.spec.prints)), `the row's situation \`${row.spec.prints}\` was not printed:\n${out.join("\n")}`);
    if (row.spec.provisional) return;
    const loops = loopsAfter(seeded);
    for (const [name, value] of Object.entries(row.spec.loops ?? {})) assert.deepEqual(loops[name], value, `${name} of ${JSON.stringify(loops)}`);
  });
}

test("the loops of a run that renames itself land on its new run directory", async (t) => {
  const row = readRow("t7");
  const seeded = seedRow(t, "t7-loops", row);
  const { out } = await runCheck(seeded.env, "01");
  assert.ok(out.some((line) => line.startsWith("recorded: slug the-named-slug (renamed from")), out.join("\n"));
  assert.equal(loopsAfter({ ...seeded, slug: "the-named-slug" }).lastNext, "launch explore");
  assert.equal(existsSync(seeded.dir), false);
});

test("a re-run of a counted row on the same text repeats its action and burns no iteration", async (t) => {
  const row = readRow("v4");
  const seeded = seedRow(t, "v4-twice", row);
  const first = await runCheck(seeded.env, "06");
  const second = await runCheck(seeded.env, "06");
  assert.equal(second.out.at(-1), first.out.at(-1));
  assert.equal(second.out.at(-1), row.expected);
  assert.equal(loopsAfter(seeded).fix, 2);
});

test("a new round of the same failure counts, and past the limit it publishes a draft", async (t) => {
  const row = readRow("v4");
  const seeded = seedRow(t, "v4-new-round", row);
  await runCheck(seeded.env, "06");
  writeFileSync(join(seeded.dir, "06-verification.md"), `${row.texts["06-verification.md"]}\n## Round 2\n\n## Checks run\n- test: FAILED\n\n## Failures\n- it still drops the row\n\n## Verification: FAILED\n`);
  const { out } = await runCheck(seeded.env, "06");
  assert.equal(out.at(-1), "NEXT: publish --draft remaining=it still drops the row");
});

test("the same failed text after a fix lane ran relaunches the verifier once, then publishes a draft that a re-run repeats", async (t) => {
  const seeded = seedRow(t, "v4-stale", readRow("v4"));
  writeFileSync(join(seeded.dir, "04-implementation.md"), "## Modified files\n/a.mjs\n\n## Done\nDone.\n");
  assert.match((await runCheck(seeded.env, "06")).out.at(-1), /^NEXT: launch coder-fix note=iteration 2: /);
  assert.equal((await runCheck(seeded.env, "04")).out.at(-1), "NEXT: launch verifier");
  assert.equal((await runCheck(seeded.env, "06")).out.at(-1), "NEXT: launch verifier note=06-verification.md unchanged since the last check");
  const stale = "NEXT: publish --draft remaining=check 06 wrote no new round after the last lane, so its failures stay open";
  assert.equal((await runCheck(seeded.env, "06")).out.at(-1), stale);
  assert.equal((await runCheck(seeded.env, "06")).out.at(-1), stale);
});

test("a new round written by the unchanged relaunch is read on its own verdict, never as a second unchanged text", async (t) => {
  const row = readRow("v7a");
  const seeded = seedRow(t, "v7a-new-round", row);
  await runCheck(seeded.env, "06");
  writeFileSync(join(seeded.dir, "06-verification.md"), `${row.texts["06-verification.md"]}\n## Round 2\n\n## Checks run\n- test: PASSED\n\n## Verification: PASSED\n`);
  assert.equal((await runCheck(seeded.env, "06")).out.at(-1), "NEXT: launch runtime");
});

test("a relaunch that wrote nothing reaches the still-missing row, with no digest dedupe", async (t) => {
  const seeded = seedRow(t, "e2-twice", readRow("e2"));
  const first = await runCheck(seeded.env, "02");
  assert.match(first.out.at(-1), /^NEXT: launch explore note=MISSING: /);
  const second = await runCheck(seeded.env, "02");
  assert.equal(second.out.at(-1), "NEXT: launch architect");
});

test("a check that passes drops its miss, so a later miss of that check is a first one again", async (t) => {
  const row = readRow("e2");
  const seeded = seedRow(t, "e2-recovered", row);
  await runCheck(seeded.env, "02");
  writeFileSync(join(seeded.dir, "02-explore.md"), readRow("e1").texts["02-explore.md"]);
  await runCheck(seeded.env, "02");
  assert.deepEqual(loopsAfter(seeded).missing, {});
  writeFileSync(join(seeded.dir, "02-explore.md"), row.texts["02-explore.md"]);
  assert.match((await runCheck(seeded.env, "02")).out.at(-1), /^NEXT: launch explore note=MISSING: /);
});

test("the coder-fix owed survives a re-run of check 04, and the verification clears it", async (t) => {
  const seeded = seedRow(t, "c3-twice", readRow("c3"));
  assert.equal((await runCheck(seeded.env, "04")).out.at(-1), "NEXT: launch verifier");
  assert.equal((await runCheck(seeded.env, "04")).out.at(-1), "NEXT: launch verifier");
  writeFileSync(join(seeded.dir, "06-verification.md"), readRow("v1").texts["06-verification.md"]);
  await runCheck(seeded.env, "06");
  assert.equal((await runCheck(seeded.env, "04")).out.at(-1), "NEXT: launch qa-triage");
});

// A phase entry attempt 1 recorded, from `phase` or `phase:verdict`.
function recorded(spec) {
  const [phase, verdict = "OK"] = spec.split(":");
  return { phase, verdict, claim: { attempt: 1 } };
}

// A seeded row resumed on attempt 2: its cache is attempt 1's, and its phases are what attempt 1 recorded.
function resumedRow(t, id, rowId, { cache, phases }) {
  const seeded = seedRow(t, id, readRow(rowId));
  const { env, projectId, slug } = seeded;
  saveRunState({ projectId, slug, env, state: { ...readRunState({ projectId, slug, env }), pipelineLoops: { attempt: 1, ...cache }, lastClaim: { attempt: 2 }, phases: phases.map(recorded) } });
  return seeded;
}

test("another attempt's cache is never read: with no decision record the counts come from phases[] alone", async (t) => {
  const reset = resumedRow(t, "attempt-reset", "v4b", { cache: { fix: 2 }, phases: [] });
  assert.equal((await runCheck(reset.env, "06")).out.at(-1), "NEXT: launch coder-fix note=iteration 1: test/a.test.mjs: the filter drops a row");
  assert.equal(loopsAfter(reset).attempt, 2);
  assert.equal(loopsAfter(reset).fix, 1);
  const replayed = resumedRow(t, "attempt-replayed", "v4b", { cache: { fix: 0 }, phases: ["triage:PROCEED", "explore", "architecture", "implementation", "qa:NEEDS FIX", "implementation"] });
  assert.equal((await runCheck(replayed.env, "06")).out.at(-1), "NEXT: launch coder-fix note=iteration 2: test/a.test.mjs: the filter drops a row");
  assert.equal(loopsAfter(replayed).fix, 2);
});

const REPLAYS = [
  {
    title: "a verification loop after an approved QA counts each fix lane",
    row: "v4",
    check: "06",
    phases: ["architecture", "implementation", "qa:APPROVED", "verification:FAILED", "implementation", "implementation"],
    next: "NEXT: publish --draft remaining=test/a.test.mjs: the filter drops a row",
    loops: { fix: 2 },
  },
  {
    title: "a stage lane after the fix limit starts its fix count over",
    row: "v4",
    check: "06",
    phases: ["architecture", "implementation", "verification:FAILED", "implementation", "verification:FAILED", "implementation", "verification:FAILED", "implementation"],
    next: "NEXT: launch coder-fix note=iteration 1: test/a.test.mjs: the filter drops a row",
    loops: { fix: 1 },
  },
  {
    title: "a triage after a runtime lane is the re-triage, so the coder lane goes straight to the verifier",
    row: "c3",
    check: "04",
    phases: ["triage:PROCEED", "architecture", "implementation", "qa:APPROVED", "verification:PASSED", "runtime:SYMPTOM-PERSISTS", "triage:PROCEED", "architecture"],
    next: "NEXT: launch verifier",
    loops: { retriage: 1, fixPending: false },
  },
  {
    title: "a triage relaunched before any runtime lane is no re-triage",
    row: "c3",
    check: "04",
    phases: ["triage:PROCEED", "triage:PROCEED", "explore", "architecture"],
    next: "NEXT: launch qa-triage",
    loops: { retriage: 0, fixPending: false },
  },
  {
    title: "only an architecture right after a QA counts as an architect round",
    row: "c3",
    check: "04",
    phases: ["triage:PROCEED", "explore", "architecture", "architecture", "implementation", "qa:APPROVED", "architecture"],
    next: "NEXT: launch qa-triage",
    loops: { architect: 1 },
  },
];

for (const replay of REPLAYS) {
  test(`replayed phases: ${replay.title}`, async (t) => {
    const seeded = resumedRow(t, `replay-${REPLAYS.indexOf(replay)}`, replay.row, { cache: {}, phases: replay.phases });
    assert.equal((await runCheck(seeded.env, replay.check)).out.at(-1), replay.next);
    const loops = loopsAfter(seeded);
    for (const [name, value] of Object.entries(replay.loops)) assert.deepEqual(loops[name], value, `${name} of ${JSON.stringify(loops)}`);
  });
}

const IMPLEMENTATION = readRow("c3").texts["04-implementation.md"];

const RESUMES = [
  {
    title: "a QA's coder-fix owed when the attempt ended sends the next attempt's lane to the verifier",
    row: "q8",
    then: [{ check: "04", file: ["04-implementation.md", IMPLEMENTATION], next: "NEXT: launch verifier" }],
  },
  {
    title: "a plan's owed QA row survives the retry and is what the revised plan answers",
    row: "q6b",
    then: [{ check: "03", file: ["03-plan.md", readRow("p8").texts["03-plan.md"]], next: "NEXT: launch verifier" }],
  },
  {
    title: "a re-triage launched before the attempt ended still sends the coder lane straight to the verifier",
    row: "r4",
    then: [{ check: "04", file: ["04-implementation.md", IMPLEMENTATION], next: "NEXT: launch verifier" }],
  },
  {
    title: "a stage lane that started before the attempt ended keeps its stage and its reset fix count",
    row: "v3",
    then: [{ check: "04", file: ["04-implementation.md", IMPLEMENTATION], next: "NEXT: launch verifier stage=2" }],
    loops: { stage: 2, fix: 0 },
  },
  {
    title: "a fix lane checked before the attempt ended is not fixed again: the same failed text relaunches the verifier once",
    row: "v4",
    before: [{ check: "04", file: ["04-implementation.md", IMPLEMENTATION], next: "NEXT: launch verifier" }],
    then: [
      { check: "04", next: "NEXT: launch verifier" },
      { check: "06", next: "NEXT: launch verifier note=06-verification.md unchanged since the last check" },
    ],
  },
];

// Runs each step of a resume case: its file written, then its check, which must answer the step's `NEXT:`.
async function runSteps(seeded, steps) {
  for (const step of steps) {
    if (step.file) writeFileSync(join(seeded.dir, step.file[0]), step.file[1]);
    assert.equal((await runCheck(seeded.env, step.check)).out.at(-1), step.next, `check ${step.check}`);
  }
}

for (const resume of RESUMES) {
  test(`resumed after a decision: ${resume.title}`, async (t) => {
    const row = readRow(resume.row);
    const seeded = seedRow(t, `resume-${resume.row}`, row);
    assert.equal((await runCheck(seeded.env, row.spec.check)).out.at(-1), row.expected);
    await runSteps(seeded, resume.before ?? []);
    retried(seeded);
    await runSteps(seeded, resume.then);
    const loops = loopsAfter(seeded);
    for (const [name, value] of Object.entries(resume.loops ?? {})) assert.deepEqual(loops[name], value, `${name} of ${JSON.stringify(loops)}`);
  });
}

test("a re-run of a counted row on the same text records no second decision", async (t) => {
  const seeded = seedRow(t, "v4-one-decision", readRow("v4"));
  await runCheck(seeded.env, "06");
  await runCheck(seeded.env, "06");
  const { decisions } = readRunState({ projectId: seeded.projectId, slug: seeded.slug, env: seeded.env });
  assert.equal(decisions.length, 1);
  assert.match(decisions[0].next, /^launch coder-fix note=iteration 2: /);
  assert.deepEqual([decisions[0].loops.fix, typeof decisions[0].at], [2, "string"]);
});

test("decision records of a hostile shape read as none and never break the check", async (t) => {
  const seeded = seedRow(t, "hostile-decisions", readRow("v4b"));
  const { env, projectId, slug } = seeded;
  const { pipelineLoops: _cache, ...state } = readRunState({ projectId, slug, env });
  saveRunState({ projectId, slug, env, state: { ...state, lastClaim: { attempt: 2 }, decisions: [3, null, { loops: "x" }, { loops: [1] }] } });
  assert.equal((await runCheck(env, "06")).out.at(-1), "NEXT: launch coder-fix note=iteration 1: test/a.test.mjs: the filter drops a row");
});

test("loops of a hostile shape read as zero and never break the check", async (t) => {
  const seeded = seedRow(t, "hostile", readRow("v4b"));
  const { env, projectId, slug } = seeded;
  saveRunState({ projectId, slug, env, state: { ...readRunState({ projectId, slug, env }), pipelineLoops: { fix: "2", missing: "x", invalidated: 3, stage: "1", counted: 7 } } });
  assert.equal((await runCheck(env, "06")).out.at(-1), "NEXT: launch coder-fix note=iteration 1: test/a.test.mjs: the filter drops a row");
});

const OWED_FIX = "NEXT: launch coder-fix note=iteration 2: test/a.test.mjs: the filter drops a row";

// Rewrites the state of a seeded run through a function of it.
function patchState({ env, projectId, slug }, patch) {
  const state = readRunState({ projectId, slug, env });
  saveRunState({ projectId, slug, env, state: { ...state, ...patch(state) } });
}

test("a decision whose check memo never landed still repeats its owed coder-fix on the retry", async (t) => {
  const seeded = seedRow(t, "v4-memo-lost", readRow("v4"));
  assert.equal((await runCheck(seeded.env, "06")).out.at(-1), OWED_FIX);
  patchState(seeded, ({ checks: { ["06"]: _memo, lastFailure: _failure, ...checks } }) => ({ checks }));
  retried(seeded);
  assert.equal((await runCheck(seeded.env, "06")).out.at(-1), OWED_FIX);
});

const OTHER_CHECKS = [
  { title: "a memo of a later sequence with an earlier time", memo: (decision) => ({ digest: "d04", seq: decision.seq, at: "2020-01-01T00:00:00.000Z" }), owed: false },
  { title: "a memo of an earlier sequence with a later time", memo: (decision) => ({ digest: "d04", seq: decision.seq - 1, at: "2999-01-01T00:00:00.000Z" }), owed: true },
  { title: "a memo with no sequence in the decision's own millisecond", memo: (decision) => ({ digest: "d04", at: decision.at }), owed: false },
  { title: "a memo with no sequence and no time", memo: () => ({ digest: "d04" }), owed: false },
  { title: "a memo with no sequence and a time off the ISO form", memo: () => ({ digest: "d04", at: "2026-11-04 10:00:00.500" }), owed: false },
  { title: "a memo with no sequence and a strictly earlier ISO time", memo: () => ({ digest: "d04", at: "2020-01-01T00:00:00.000Z" }), owed: true },
];

for (const other of OTHER_CHECKS) {
  test(`another check's memo orders against the decision by sequence, an unreadable order never earlier: ${other.title}`, async (t) => {
    const seeded = seedRow(t, `v4-order-${OTHER_CHECKS.indexOf(other)}`, readRow("v4"));
    assert.equal((await runCheck(seeded.env, "06")).out.at(-1), OWED_FIX);
    const [decision] = readRunState(seeded).decisions;
    assert.equal(decision.seq, readRunState(seeded).checks["06"].seq, "the decision does not take its memo's place in the sequence");
    patchState(seeded, (state) => ({ checks: { ...state.checks, "04": other.memo(decision) } }));
    retried(seeded);
    const last = (await runCheck(seeded.env, "06")).out.at(-1);
    if (other.owed) assert.equal(last, OWED_FIX);
    else assert.doesNotMatch(last, /^NEXT: launch coder-fix/);
  });
}

const HOSTILE_HELD = [
  { title: "a negative fix of a decision", row: "v4b", check: "06", patch: { decisions: [{ check: "06", digest: "x", next: "launch verifier", at: "2020-01-01T00:00:00.000Z", loops: { fix: -1000 } }] }, next: "NEXT: launch coder-fix note=iteration 1: test/a.test.mjs: the filter drops a row" },
  { title: "a negative fix of the cache", row: "v4b", check: "06", patch: { pipelineLoops: { attempt: 2, fix: -1000 } }, next: "NEXT: launch coder-fix note=iteration 1: test/a.test.mjs: the filter drops a row" },
  { title: "a negative stage", row: "c3", check: "04", patch: { pipelineLoops: { attempt: 2, stage: -1, fixPending: true } }, next: "NEXT: launch verifier" },
  { title: "a fractional stage", row: "c3", check: "04", patch: { pipelineLoops: { attempt: 2, stage: 2.5, fixPending: true } }, next: "NEXT: launch verifier" },
  { title: "a stage past the safe integers", row: "c3", check: "04", patch: { pipelineLoops: { attempt: 2, stage: 1e21, fixPending: true } }, next: "NEXT: launch verifier" },
];

for (const hostile of HOSTILE_HELD) {
  test(`a held loop fact off its range reads as none: ${hostile.title}`, async (t) => {
    const seeded = seedRow(t, `held-${HOSTILE_HELD.indexOf(hostile)}`, readRow(hostile.row));
    patchState(seeded, () => ({ lastClaim: { attempt: 2 }, pipelineLoops: undefined, ...hostile.patch }));
    assert.equal((await runCheck(seeded.env, hostile.check)).out.at(-1), hostile.next);
  });
}

test("a decision whose action is off the grammar is never answered back", async (t) => {
  const seeded = seedRow(t, "off-grammar", readRow("v4b"));
  await runCheck(seeded.env, "06");
  const { digest } = readRunState(seeded).checks["06"];
  const garbage = "launch verifier stage=2.5";
  patchState(seeded, () => ({ lastClaim: { attempt: 2 }, pipelineLoops: undefined, decisions: [{ check: "06", digest, next: garbage, at: "2999-01-01T00:00:00.000Z", loops: { counted: { key: "06", digest, next: garbage, unchanged: 0 } } }] }));
  const { code, out } = await runCheck(seeded.env, "06");
  assert.equal(code, 0);
  assert.equal(out.at(-1), "NEXT: launch coder-fix note=iteration 1: test/a.test.mjs: the filter drops a row");
});

test("a pipeline writer cannot set the loops: they are written by the runtime only", (t) => {
  const seeded = seedJob(t, "reserved", {});
  const refused = recordRunFields({ projectId: seeded.projectId, slug: seeded.slug, fields: { pipelineLoops: { fix: 0 } }, env: seeded.env });
  assert.equal(refused.status, "kept");
  assert.match(refused.reason, /`pipelineLoops` is written by the runtime only/);
});

test("the loops of a claim that is over are set aside, with the refusal line", (t) => {
  const seeded = seedJob(t, "late", {});
  const { env, projectId, slug } = seeded;
  const written = recordRuntimeField({ projectId, slug, name: "pipelineLoops", value: { fix: 1 }, claim: { attempt: 1, over: true }, env });
  assert.equal(written.status, "kept");
  assert.match(written.reason, /attempt 1 of this job is over/);
  const state = readRunState({ projectId, slug, env });
  assert.equal(state.pipelineLoops, undefined);
  assert.equal(state.ignoredRecords.length, 1);
});
