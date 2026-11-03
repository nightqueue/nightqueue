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
import { phasePrompts } from "../../test-support/skill-size.mjs";
import { agentToolUseEvent, assistantEvent, noticeText, PR_URL, recordedDone, resultEvent, slugEvent, SLUG, systemInitEvent, taskNotificationEvent, toNdjson, toolResultEvent } from "../../test-support/streams.mjs";

const PLACEHOLDER_RE = /<[^<>]+>/g;
const MAX_STEPS = 40;

const TRIAGE = "# Triage\n\n## Brief\n**Affected area:** src/a.mjs\n**Context:** the listing\n**Objective:** list the jobs\n**Expected outcome:** the jobs are listed\n**Commit type:** feat\n\n## Verdict: PROCEED\n\nEvidence level: 3\n\n## Validated brief\nFix it.\n\n## Out of scope\n- None.\n\n## Request gaps\n- None.\n";
const EXPLORE = "# Explore\n\n## File map\n- /a.mjs — a\n\n## Access map\n- **No entry point:** text · grep\n\n## Third-party libraries\n- None\n";
const PLAN_TAIL = "\n## Assumptions\n- [P1] it reads one table (`src/a.mjs:12`) — invalidated if: a view joins it.\n\n## Pre-mortem\n- [PM1] rows leak — mitigation: a test.\n\n## Identified risks\n- [R1] the default changes — how to test it: node --test.\n";
const FLAT_PLAN = `# Plan\n\n## Implementation plan\n- Add the filter.\n${PLAN_TAIL}`;
const STAGED_PLAN = `# Plan\n\n## Implementation plan\n### Stage 1 — one\n- a\n\n### Stage 2 — two\n- b\n${PLAN_TAIL}`;
const IMPLEMENTATION = "## Modified files\n/a.mjs\n\n## Done\nDone.\n";

// A QA triage round deciding one mode.
function qaTriageRound(mode) {
  return `source: qa-triage\n\n## Diff classification\n- copy/docs: README.md\n\n## New risk\nnone\n\n## QA mode\n${mode} — only documentation text changed.\n`;
}

// A QA round of one verdict.
function qaRound(verdict, breaks = "None") {
  return `\n## Proven breaks\n${breaks}\n\n## Validated risks\n- R1 UPHELD by test/a.test.mjs\n\n## Invalidated assumptions\nNone\n\n## Generated PoCs\nNone\n\n## Verdict\n${verdict}\n`;
}

// An analyst round with no hypothesis, so there is no prover to launch.
function analystRound() {
  return `\n## Proven breaks\nNone\n\n## Break hypotheses\nNone\n\n## Test recipe\nnode --test\n\n## Validated risks\n- R1\n\n## Invalidated assumptions\nNone\n\n## Generated PoCs\nNone\n\n## Verdict\nAPPROVED\n`;
}

// A verification round of one verdict.
function verificationRound(verdict) {
  const failed = verdict.startsWith("FAILED");
  return `\n## Checks run\n- test: ${failed ? "FAILED" : "PASSED"}\n\n${failed ? "## Failures\n- test/a.test.mjs: it drops a row\n\n" : ""}## Verification: ${verdict}\n`;
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

// The canned work of each lane and the check that follows it; the scenario picks the verdicts, in order, per lane.
function laneWork(seeded, scenario) {
  const take = (lane) => (scenario[lane] ?? []).shift();
  return {
    triager: { write: () => writeFileSync(join(seeded.dir, "01-triage.md"), TRIAGE), check: ["01"] },
    explore: { write: () => writeFileSync(join(seeded.dir, "02-explore.md"), EXPLORE), check: ["02"] },
    architect: { write: () => writeFileSync(join(seeded.dir, "03-plan.md"), scenario.plan ?? FLAT_PLAN), check: ["03"] },
    coder: { write: () => writeFileSync(join(seeded.dir, "04-implementation.md"), IMPLEMENTATION), check: ["04"] },
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

// One block filled the way the orchestrator does, every placeholder a value.
function filledBlock(lines) {
  return lines.map((line) => (line.startsWith("RETURN-") || line.startsWith("## Did") ? line : line.replace(PLACEHOLDER_RE, "value"))).join("\n");
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
      agentToolUseEvent({ id: `lane${index}`, subagentType: agent, model: "sonnet", description: target, prompt: filledBlock(blocks[target]) }),
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
  assert.deepEqual(actions, ["launch triager", "launch explore", "launch architect", "launch coder", "launch qa-triage", "launch qa-lite", "launch verifier", "launch runtime", "publish"]);
  assert.equal(existsSync(join(seeded.dir, "00-brief.md")), true);
  const job = await deliverThroughRunner(t, actions);
  assert.equal(job.status, "done", JSON.stringify(job));
});

test("a NEEDS FIX run goes coder-fix, verifier, FAILED, a second coder-fix, FAILED, and `publish --draft` at the limit", async (t) => {
  const seeded = seedRun(t, "fix");
  const actions = await followNext(seeded, { "qa-triage": ["lite"], "qa-lite": [qaRound("NEEDS FIX", "- H1 it drops a row")], verifier: ["FAILED", "FAILED"] });
  assert.deepEqual(shortened(actions), ["launch triager", "launch explore", "launch architect", "launch coder", "launch qa-triage", "launch qa-lite", "launch coder-fix", "launch verifier", "launch coder-fix", "launch verifier", "publish --draft"]);
  assert.equal(actions.at(-1), "publish --draft remaining=test/a.test.mjs: it drops a row");
  assert.match(actions[6], /note=iteration 1: H1 it drops a row$/);
  assert.match(actions[8], /note=iteration 2: test\/a\.test\.mjs: it drops a row$/);
});

test("a staged plan alternates each coder lane with its verifier, then the QA and the final verification", async (t) => {
  const seeded = seedRun(t, "staged");
  const actions = await followNext(seeded, { plan: STAGED_PLAN, "qa-triage": ["skip"], verifier: ["PASSED (stage 1)", "PASSED (stage 2)", "PASSED"], runtime: ["UNAVAILABLE"] });
  assert.deepEqual(actions, ["launch triager", "launch explore", "launch architect", "launch coder stage=1", "launch verifier stage=1", "launch coder stage=2", "launch verifier stage=2", "launch qa-triage", "launch verifier", "launch runtime", "publish"]);
});

test("a full QA with no hypothesis goes from the analyst straight to the consolidating check, and on", async (t) => {
  const seeded = seedRun(t, "analyst");
  const actions = await followNext(seeded, { "qa-triage": ["full"], verifier: ["PASSED-STATIC"], runtime: ["CONFIRMED"] });
  assert.deepEqual(actions, ["launch triager", "launch explore", "launch architect", "launch coder", "launch qa-triage", "launch qa-analyst", "check 05", "launch verifier", "launch runtime", "publish"]);
});
