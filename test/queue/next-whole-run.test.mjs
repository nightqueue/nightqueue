import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { run } from "../../src/cli/index.mjs";
import { runDir } from "../../src/config/paths.mjs";
import { openDb } from "../../src/memory/db.mjs";
import { addJob, getJob } from "../../src/memory/jobs.mjs";
import { recordRunFields } from "../../src/queue/run-state.mjs";
import { runCycle } from "../../src/queue/runner.mjs";
import { fakeJobWorktree } from "../../test-support/job-worktree.mjs";
import { ensureProject, makeDir, makeHome, makeProject } from "../../test-support/memory.mjs";
import { useFakeClaude } from "../../test-support/queue-fake.mjs";
import { fillBlock, phasePrompts } from "../../test-support/skill-size.mjs";
import { agentToolUseEvent, assistantEvent, noticeText, PR_URL, recordedDone, resultEvent, slugEvent, SLUG, systemInitEvent, taskNotificationEvent, toNdjson, toolResultEvent } from "../../test-support/streams.mjs";

const MAX_STEPS = 40;

const TRIAGE = "# Triage\n\n## Brief\n**Affected area:** src/a.mjs\n**Context:** the listing\n**Objective:** list the jobs\n**Expected outcome:** the jobs are listed\n**Commit type:** feat\n\n## Verdict: PROCEED\n\nEvidence level: 3\n\n## Validated brief\nFix it.\n\n## Out of scope\n- None.\n\n## Request gaps\n- None.\n";
const EXPLORE = "# Explore\n\n## File map\n- /a.mjs — a\n\n## Access map\n- **No entry point:** text · grep\n\n## Third-party libraries\n- None\n";
const PLAN_TAIL = "\n## Assumptions\n- [P1] it reads one table (`src/a.mjs:12`) — invalidated if: a view joins it.\n\n## Pre-mortem\n- [PM1] rows leak — mitigation: a test.\n\n## Identified risks\n- [R1] the default changes — how to test it: node --test.\n";
const FLAT_PLAN = `# Plan\n\n## Implementation plan\n- Add the filter.\n${PLAN_TAIL}`;
const IMPLEMENTATION = "## Modified files\n/a.mjs\n\n## Done\nDone.\n";

// A two-stage plan whose stages carry the given QA lines, empty for none.
function stagedPlan(first, second) {
  return `# Plan\n\n## Implementation plan\n### Stage 1 — one\n- a\n${first}\n\n### Stage 2 — two\n- b\n${second}\n${PLAN_TAIL}`;
}

// A QA triage round deciding one mode.
function qaTriageRound(mode) {
  return `source: qa-triage\n\n## Diff classification\n- copy/docs: README.md\n\n## New risk\nnone\n\n## QA mode\n${mode} — only documentation text changed.\n`;
}

// A QA round of one verdict, with an optional `fix:` mark after it.
function qaRound(verdict, breaks = "None", mark = null) {
  return `\n## Proven breaks\n${breaks}\n\n## Validated risks\n- R1 UPHELD by test/a.test.mjs\n\n## Invalidated assumptions\nNone\n\n## Generated PoCs\nNone\n\n## Verdict\n${verdict}\n${mark === null ? "" : `\n${mark}\n`}`;
}

// An analyst round with no hypothesis, so there is no prover to launch.
function analystRound() {
  return `\n## Proven breaks\nNone\n\n## Break hypotheses\nNone\n\n## Test recipe\nnode --test\n\n## Validated risks\n- R1\n\n## Invalidated assumptions\nNone\n\n## Generated PoCs\nNone\n\n## Verdict\nAPPROVED\n`;
}

// A verification round of one verdict, `FAILED | fix: design` adding the mark after it.
function verificationRound(spec) {
  const [verdict, mark = null] = spec.split(" | ");
  const failed = verdict.startsWith("FAILED");
  return `\n## Checks run\n- test: ${failed ? "FAILED" : "PASSED"}\n\n${failed ? "## Failures\n- test/a.test.mjs: it drops a row\n\n" : ""}## Verification: ${verdict}\n${mark === null ? "" : `\n${mark}\n`}`;
}

// A runtime round of one verdict.
function runtimeRound(verdict, diff = "n/a") {
  return `\n## Runtime verdict\n${verdict}\n\nDiff applies plan: ${diff}\n\n| # | Scenario (declared entry point) | Result | Evidence |\n|---|---|---|---|\n| 1 | queue retry J-1 | MET | evidence/a.log |\n`;
}

// A run in a job of its own, its directory ready for the lanes to write into.
function seedRun(t, name) {
  const env = makeHome(t, `next-whole-${name}`);
  makeProject(t, env, "alpha");
  const projectId = ensureProject(env, "alpha");
  const id = addJob({ projectId, prompt: "follow the next line" }, env).id;
  openDb(env).prepare("UPDATE jobs SET slug = ? WHERE id = ?").run("next-whole", id);
  recordRunFields({ projectId, slug: "next-whole", fields: { type: "feature/refactor" }, env });
  const dir = runDir(projectId, "next-whole", env);
  mkdirSync(dir, { recursive: true });
  return { env: { ...env, NIGHTQUEUE_JOB_ID: String(id) }, dir, rounds: {} };
}

// A lane appending its next `## Round <n>` to a round artifact.
function appendRound(seeded, file, body) {
  seeded.rounds[file] = (seeded.rounds[file] ?? 0) + 1;
  appendFileSync(join(seeded.dir, file), `${seeded.rounds[file] > 1 ? "\n" : ""}## Round ${seeded.rounds[file]}\n${body}`);
}

// A coder lane rewriting the implementation with a block of its own, as a cumulative report does.
function writeCoderLane(seeded) {
  seeded.lanes = (seeded.lanes ?? 0) + 1;
  writeFileSync(join(seeded.dir, "04-implementation.md"), `${IMPLEMENTATION}\n### Lane ${seeded.lanes}\n- done\n`);
}

// The canned work of each lane and the check that follows it; the scenario picks the verdicts, in order, per lane.
function laneWork(seeded, scenario) {
  const take = (lane) => (scenario[lane] ?? []).shift();
  return {
    triager: { write: () => writeFileSync(join(seeded.dir, "01-triage.md"), TRIAGE), check: ["01"] },
    explore: { write: () => writeFileSync(join(seeded.dir, "02-explore.md"), EXPLORE), check: ["02"] },
    architect: { write: () => writeFileSync(join(seeded.dir, "03-plan.md"), scenario.plan ?? FLAT_PLAN), check: ["03"] },
    coder: { write: () => writeCoderLane(seeded), check: ["04"] },
    "coder-fix": { write: () => appendFileSync(join(seeded.dir, "04-implementation.md"), "\n### Fix loop\n- fixed\n"), check: ["04"] },
    "qa-triage": { write: () => appendRound(seeded, "05-qa.md", qaTriageRound(take("qa-triage"))), check: ["05", "--stage", "triage"] },
    "qa-lite": { write: () => appendRound(seeded, "05-qa.md", take("qa-lite")), check: ["05"] },
    "qa-analyst": { write: () => appendRound(seeded, "05-qa.md", analystRound()), check: ["05", "--stage", "analyst"] },
    verifier: { write: () => appendRound(seeded, "06-verification.md", verificationRound(take("verifier"))), check: ["06"] },
    runtime: { write: () => appendRound(seeded, "07-runtime.md", runtimeRound(take("runtime"))), check: ["07"] },
  };
}

// Runs `run check` for real and answers its last line, the only thing the loop may read.
async function nextAfter(env, check) {
  const out = [];
  const err = [];
  const code = await run(["run", "check", ...check], { env, out: (line) => out.push(line), err: (line) => err.push(line), stdout: { write: () => {} } });
  assert.equal(code, 0, err.join("\n"));
  const last = out.at(-1);
  assert.ok(last.startsWith("NEXT: "), `the check ended on ${last}`);
  return last.slice("NEXT: ".length);
}

// Follows `NEXT:` from the first lane until it leaves the launches, answering every action in order.
async function followNext(seeded, scenario) {
  const work = laneWork(seeded, scenario);
  const actions = [];
  let action = "launch triager";
  for (let step = 0; step < MAX_STEPS; step += 1) {
    actions.push(action);
    const check = /^check (\S+)$/.exec(action);
    if (check !== null) {
      action = await nextAfter(seeded.env, [check[1]]);
      continue;
    }
    const target = /^launch (\S+)/.exec(action)?.[1];
    if (target === undefined) return actions;
    assert.ok(work[target], `no canned lane for \`${action}\``);
    work[target].write();
    action = await nextAfter(seeded.env, work[target].check);
  }
  throw new Error(`the run did not end in ${MAX_STEPS} steps: ${actions.join(" → ")}`);
}

// The action names of a followed run, its notes dropped.
function shortened(actions) {
  return actions.map((action) => action.replace(/ (?:note|remaining)=.*$/, ""));
}

// The stream of the lanes a followed run launched, each from its own SKILL block, ending on a delivered pull request.
function streamOf(actions) {
  const { blocks } = phasePrompts();
  const launches = actions.filter((action) => action.startsWith("launch "));
  const lanes = launches.flatMap((action, index) => {
    const target = /^launch (\S+)/.exec(action)[1];
    assert.ok(blocks[target], `\`${target}\` is not a block of SKILL.md`);
    const [, agent] = /AGENT: (\S+) ·/.exec(blocks[target][0]);
    return [
      agentToolUseEvent({ id: `lane${index}`, subagentType: agent, model: "sonnet", description: target, prompt: fillBlock(blocks[target]).join("\n") }),
      taskNotificationEvent({ toolUseId: `lane${index}`, durationMs: 1000 }),
      toolResultEvent({ toolUseId: `lane${index}`, content: "VERDICT: DONE · ARTIFACT: x.md · OPEN: 0" }),
    ];
  });
  return toNdjson([systemInitEvent(), slugEvent(SLUG), ...lanes, assistantEvent(noticeText()), resultEvent({ text: `Done. Pull request: ${PR_URL}` })]);
}

// Hands the lanes of a followed run to the runner through the fake `claude`, and answers the job it ended.
async function deliverThroughRunner(t, actions) {
  const env = makeHome(t, "next-whole-runner");
  makeProject(t, env, "alpha");
  const projectId = ensureProject(env, "alpha");
  useFakeClaude(env, makeDir(t, "next-whole-plan"), [{ stdout: streamOf(actions), runState: recordedDone(), exitCode: 0 }]);
  const id = addJob({ projectId, prompt: "fix the worker" }, env).id;
  const git = ({ args }) => ({ status: "\n", "rev-parse": "main\n", "symbolic-ref": "origin/main\n" })[args[0]] ?? "\n";
  await runCycle({ jobId: id, env, deps: { worktreeImpl: fakeJobWorktree(), gitImpl: git } });
  return getJob(id, env);
}

test("a run following only `NEXT:` reaches `publish`, and the runner delivers the lanes it launched", async (t) => {
  const seeded = seedRun(t, "lite");
  const actions = await followNext(seeded, { "qa-triage": ["lite"], "qa-lite": [qaRound("APPROVED")], verifier: ["PASSED"], runtime: ["CONFIRMED"] });
  assert.deepEqual(actions, ["launch triager", "launch explore", "launch architect", "launch coder", "launch verifier", "launch qa-triage", "launch qa-lite", "launch runtime", "publish"]);
  assert.equal(existsSync(join(seeded.dir, "00-brief.md")), true);
  const job = await deliverThroughRunner(t, actions);
  assert.equal(job.status, "done", JSON.stringify(job));
});

test("a NEEDS FIX run goes coder-fix, verifier, FAILED, a second coder-fix, FAILED, and `publish --draft` at the limit", async (t) => {
  const seeded = seedRun(t, "fix");
  const actions = await followNext(seeded, { "qa-triage": ["lite"], "qa-lite": [qaRound("NEEDS FIX", "- H1 it drops a row")], verifier: ["PASSED", "FAILED", "FAILED"] });
  assert.deepEqual(shortened(actions), ["launch triager", "launch explore", "launch architect", "launch coder", "launch verifier", "launch qa-triage", "launch qa-lite", "launch coder-fix", "launch verifier", "launch coder-fix", "launch verifier", "publish --draft"]);
  assert.equal(actions.at(-1), "publish --draft remaining=test/a.test.mjs: it drops a row");
  assert.match(actions[7], /note=iteration 1: H1 it drops a row$/);
  assert.match(actions[9], /note=iteration 2: test\/a\.test\.mjs: it drops a row$/);
});

const HEAD = ["launch triager", "launch explore", "launch architect"];

test("a two-stage plan runs coder → verifier → QA on the attacked stage, coder → verifier on the `QA: none` one, then the whole change", async (t) => {
  const seeded = seedRun(t, "staged");
  const actions = await followNext(seeded, { plan: stagedPlan("QA: attack", "QA: none"), "qa-triage": ["lite"], "qa-lite": [qaRound("APPROVED")], verifier: ["PASSED", "PASSED", "PASSED"], runtime: ["CONFIRMED"] });
  assert.deepEqual(actions, [...HEAD, "launch coder stage=1", "launch verifier stage=1", "launch qa-triage stage=1", "launch qa-lite stage=1", "launch coder stage=2", "launch verifier stage=2", "launch verifier", "launch runtime", "publish"]);
});

test("a stage with no QA line, or an odd one, is attacked", async (t) => {
  const seeded = seedRun(t, "odd-qa");
  const actions = await followNext(seeded, { plan: stagedPlan("", "- **QA:** maybe"), "qa-triage": ["skip", "skip"], verifier: ["PASSED", "PASSED", "PASSED"], runtime: ["CONFIRMED"] });
  assert.deepEqual(actions, [...HEAD, "launch coder stage=1", "launch verifier stage=1", "launch qa-triage stage=1", "launch coder stage=2", "launch verifier stage=2", "launch qa-triage stage=2", "launch verifier", "launch runtime", "publish"]);
});

const QUIET = stagedPlan("QA: none", "QA: none");

test("a stage verifier's `fix: design` goes to the architect, then the coder of that stage and its verifier", async (t) => {
  const seeded = seedRun(t, "design");
  const actions = await followNext(seeded, { plan: QUIET, verifier: ["FAILED | fix: design", "PASSED", "PASSED", "PASSED"], runtime: ["CONFIRMED"] });
  assert.deepEqual(shortened(actions), [...HEAD, "launch coder stage=1", "launch verifier stage=1", "launch architect", "launch coder stage=1", "launch verifier stage=1", "launch coder stage=2", "launch verifier stage=2", "launch verifier", "launch runtime", "publish"]);
  assert.equal(actions[5], "launch architect note=fix: design — test/a.test.mjs: it drops a row");
});

for (const mark of ["fix: code", null]) {
  test(`a stage verifier's FAILED ${mark === null ? "with no mark" : `with \`${mark}\``} goes to the coder-fix of that stage`, async (t) => {
    const seeded = seedRun(t, `code-${mark === null ? "none" : "mark"}`);
    const failed = mark === null ? "FAILED" : `FAILED | ${mark}`;
    const actions = await followNext(seeded, { plan: QUIET, verifier: [failed, "PASSED", "PASSED", "PASSED"], runtime: ["CONFIRMED"] });
    assert.deepEqual(shortened(actions), [...HEAD, "launch coder stage=1", "launch verifier stage=1", "launch coder-fix stage=1", "launch verifier stage=1", "launch coder stage=2", "launch verifier stage=2", "launch verifier", "launch runtime", "publish"]);
  });
}

test("a stage QA's NEEDS FIX with `fix: design` goes to the architect", async (t) => {
  const seeded = seedRun(t, "qa-design");
  const actions = await followNext(seeded, { plan: stagedPlan("QA: attack", "QA: none"), "qa-triage": ["lite"], "qa-lite": [qaRound("NEEDS FIX", "- H1 it drops a row", "fix: design")], verifier: ["PASSED", "PASSED", "PASSED", "PASSED"], runtime: ["CONFIRMED"] });
  assert.deepEqual(shortened(actions), [...HEAD, "launch coder stage=1", "launch verifier stage=1", "launch qa-triage stage=1", "launch qa-lite stage=1", "launch architect", "launch coder stage=1", "launch verifier stage=1", "launch coder stage=2", "launch verifier stage=2", "launch verifier", "launch runtime", "publish"]);
});

test("a stage QA's NEEDS FIX goes coder-fix, verifier, then the next stage, and the QA is not run again", async (t) => {
  const seeded = seedRun(t, "qa-fix");
  const actions = await followNext(seeded, { plan: stagedPlan("QA: attack", "QA: none"), "qa-triage": ["lite"], "qa-lite": [qaRound("NEEDS FIX", "- H1 it drops a row")], verifier: ["PASSED", "PASSED", "PASSED", "PASSED"], runtime: ["CONFIRMED"] });
  assert.deepEqual(shortened(actions), [...HEAD, "launch coder stage=1", "launch verifier stage=1", "launch qa-triage stage=1", "launch qa-lite stage=1", "launch coder-fix stage=1", "launch verifier stage=1", "launch coder stage=2", "launch verifier stage=2", "launch verifier", "launch runtime", "publish"]);
});

test("two fix loops spent in a stage leave it open for the next stage, and two on the whole change publish a draft", async (t) => {
  const seeded = seedRun(t, "limits");
  const verifier = ["FAILED", "FAILED", "FAILED", "PASSED", "FAILED", "FAILED", "FAILED"];
  const actions = await followNext(seeded, { plan: QUIET, verifier });
  const stageOne = ["launch coder stage=1", "launch verifier stage=1", "launch coder-fix stage=1", "launch verifier stage=1", "launch coder-fix stage=1", "launch verifier stage=1"];
  const whole = ["launch verifier", "launch coder-fix", "launch verifier", "launch coder-fix", "launch verifier", "publish --draft"];
  assert.deepEqual(shortened(actions), [...HEAD, ...stageOne, "launch coder stage=2", "launch verifier stage=2", ...whole]);
  assert.equal(actions[9], "launch coder stage=2 note=stage 1 left open: test/a.test.mjs: it drops a row");
});

test("a full QA with no hypothesis goes from the analyst straight to the consolidating check, and on", async (t) => {
  const seeded = seedRun(t, "analyst");
  const actions = await followNext(seeded, { "qa-triage": ["full"], verifier: ["PASSED-STATIC"], runtime: ["CONFIRMED"] });
  assert.deepEqual(actions, [...HEAD, "launch coder", "launch verifier", "launch qa-triage", "launch qa-analyst", "check 05", "launch runtime", "publish"]);
});
