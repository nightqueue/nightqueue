import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { jobLogPath, logsDir, runDir } from "../src/config/paths.mjs";
import { run } from "../src/cli/index.mjs";
import { openDb } from "../src/memory/db.mjs";
import { addJob } from "../src/memory/jobs.mjs";
import { recordPhaseDone, recordRunFields } from "../src/queue/run-state.mjs";
import { initGitRepo } from "../test-support/git.mjs";
import { makeDir, makeHome, makeProject } from "../test-support/memory.mjs";
import {
  agentToolUseEvent,
  assistantEvent,
  attemptMarker,
  secondsIntoAttempt,
  taskNotificationEvent,
  toNdjson,
} from "../test-support/streams.mjs";

const SLUG = "fix-the-worker";

// A home with one registered project and the queue table ready.
function makeQueue(t, name) {
  const env = makeHome(t, name);
  makeProject(t, env, "alpha");
  return env;
}

// A claimed job already bound to its run slug, the row `nightshift run` resolves the run from.
function boundJob(env, { slug = SLUG } = {}) {
  const id = addJob({ project: "alpha", prompt: "fix the worker" }, env).id;
  if (slug !== null) openDb(env).prepare("UPDATE jobs SET slug = ? WHERE id = ?").run(slug, id);
  return id;
}

// Runs the CLI in this process with the environment of the test, capturing what it printed.
async function runCli(env, argv, { jobId = null } = {}) {
  const out = [];
  const err = [];
  const callerEnv = jobId === null ? { ...env } : { ...env, NIGHTSHIFT_JOB_ID: String(jobId) };
  const code = await run(argv, {
    env: callerEnv,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    stdout: { write: () => {} },
  });
  return { code, out, err, text: out.join("\n") };
}

// Writes the accumulated stream of a job where the runtime persists it.
function writeJobLog(env, id, events) {
  mkdirSync(logsDir(env), { recursive: true });
  writeFileSync(jobLogPath(id, env), `${attemptMarker()}\n${toNdjson(events)}`);
}

// A subagent lane of the stream: the `tool_use` that launched it and the report that closes it with its duration.
function lane({ id, subagentType, model, durationMs, seconds }) {
  return [
    agentToolUseEvent({ id, subagentType, model, timestamp: secondsIntoAttempt(seconds) }),
    taskNotificationEvent({ toolUseId: id, durationMs }),
  ];
}

// The stream of a run that went through triage and implementation, and ended 15 minutes after it started.
function pipelineLog() {
  return [
    ...lane({ id: "toolu_a", subagentType: "nightshift:triager", model: "haiku", durationMs: 61_000, seconds: 5 }),
    ...lane({ id: "toolu_b", subagentType: "nightshift:coder", model: "opus", durationMs: 420_000, seconds: 120 }),
    assistantEvent("Done.", { timestamp: secondsIntoAttempt(900) }),
  ];
}

// Records the two phases the run completed, through the only writer of state.json.
function recordPhases(env, { slug = SLUG } = {}) {
  recordPhaseDone({ project: "alpha", slug, phase: "triage", artifact: "01-triage.md", verdict: "ok", env });
  recordPhaseDone({ project: "alpha", slug, phase: "implementation", artifact: "04-implementation.md", env });
}

test("`nightshift run` refuses a missing and an unknown subcommand, and says it is not `queue run`", async (t) => {
  const env = makeQueue(t, "cli-run-dispatch");

  const empty = await runCli(env, ["run"]);
  const unknown = await runCli(env, ["run", "logs"]);

  assert.equal(empty.code, 1);
  assert.match(empty.err.join("\n"), /unknown run subcommand ``; use: check, commit, log, pr/);
  assert.equal(unknown.code, 1);
  assert.match(unknown.err.join("\n"), /unknown run subcommand `logs`/);
  assert.match(unknown.err.join("\n"), /acts on the run of the job it is called from/);
  assert.match(unknown.err.join("\n"), /nightshift queue run/);
});

test("`run log` inside a job resolves the run from its own row and prints the phases with the measured model and duration", async (t) => {
  const env = makeQueue(t, "cli-run-log");
  const id = boundJob(env);
  recordPhases(env);
  writeJobLog(env, id, pipelineLog());

  const { code, out } = await runCli(env, ["run", "log"], { jobId: id });

  assert.equal(code, 0);
  assert.deepEqual(out, ["triage\thaiku\tok\t1m01s", "implementation\topus\tok\t7m00s", "total\t15m00s"]);
});

test("`run log --json` answers the whole table, with the run it resolved and the seconds the runtime measured", async (t) => {
  const env = makeQueue(t, "cli-run-log-json");
  const id = boundJob(env);
  recordPhases(env);
  writeJobLog(env, id, pipelineLog());

  const { code, out } = await runCli(env, ["run", "log", "--json"], { jobId: id });
  const report = JSON.parse(out.join(""));

  assert.equal(code, 0);
  assert.equal(out.length, 1);
  assert.deepEqual(report.run, { jobId: id, project: "alpha", slug: SLUG, runDir: runDir("alpha", SLUG, env) });
  assert.equal(report.durationS, 900);
  assert.deepEqual(
    report.phases.map(({ phase, model, status, durationS }) => ({ phase, model, status, durationS })),
    [
      { phase: "triage", model: "haiku", status: "ok", durationS: 61 },
      { phase: "implementation", model: "opus", status: "ok", durationS: 420 },
    ],
  );
  assert.match(report.phases[0].at, /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
});

test("a phase the runtime measured no lane for still prints, and a run with no phase says so instead of an empty table", async (t) => {
  const env = makeQueue(t, "cli-run-log-unmeasured");
  const id = boundJob(env);
  recordPhaseDone({ project: "alpha", slug: SLUG, phase: "qa", verdict: "REJECTED", env });

  const { code, out } = await runCli(env, ["run", "log"], { jobId: id });
  assert.equal(code, 0);
  assert.deepEqual(out, ["qa\t-\tREJECTED\t-", "total\t-"]);

  const other = boundJob(env, { slug: "another-run" });
  recordRunFields({ project: "alpha", slug: "another-run", fields: { branch: "fix/the-worker" }, env });
  writeJobLog(env, other, []);
  const empty = await runCli(env, ["run", "log"], { jobId: other });
  assert.deepEqual(empty.out, ["no phase recorded yet", "total\t-"]);
});

test("`run log` refuses a run named from inside a job, a row with no slug and a run nothing was recorded into", async (t) => {
  const env = makeQueue(t, "cli-run-log-refusals");
  const id = boundJob(env);
  const slugless = boundJob(env, { slug: null });

  const named = await runCli(env, ["run", "log", "--project", "alpha", "--slug", SLUG], { jobId: id });
  assert.equal(named.code, 1);
  assert.match(named.err.join("\n"), /refusing to name a run from inside job `\d+`/);

  const noSlug = await runCli(env, ["run", "log"], { jobId: slugless });
  assert.equal(noSlug.code, 1);
  assert.match(noSlug.err.join("\n"), /has no run slug on its row yet/);

  const noState = await runCli(env, ["run", "log"], { jobId: id });
  assert.equal(noState.code, 1);
  assert.match(noState.err.join("\n"), /no run recorded at .*state\.json/);
});

test("outside a job `run log` requires the run to be named, with a registered project and a safe slug", async (t) => {
  const env = makeQueue(t, "cli-run-log-outside");
  recordPhases(env);

  const missing = await runCli(env, ["run", "log"]);
  assert.equal(missing.code, 1);
  assert.match(missing.err.join("\n"), /`--project`.*and `--slug`.*are both required/);

  const unsafe = await runCli(env, ["run", "log", "--project", "alpha", "--slug", "../escape"]);
  assert.match(unsafe.err.join("\n"), /invalid slug `\.\.\/escape`/);

  const unknown = await runCli(env, ["run", "log", "--project", "beta", "--slug", SLUG]);
  assert.match(unknown.err.join("\n"), /unknown project `beta`/);

  const named = await runCli(env, ["run", "log", "--project", "alpha", "--slug", SLUG]);
  assert.equal(named.code, 0);
  assert.deepEqual(named.out, ["triage\t-\tok\t-", "implementation\t-\tok\t-", "total\t-"]);
});

// Writes an artifact of the run where the artifact gate looks for it.
function writeArtifact(env, file, body, { slug = SLUG } = {}) {
  const dir = runDir("alpha", slug, env);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, file), body);
  return join(dir, file);
}

// A real git worktree bound to the run, the only source of the file list `check 04` derives.
function boundWorktree(t, env, { slug = SLUG } = {}) {
  const repo = initGitRepo(makeDir(t, "worktree"));
  recordRunFields({ project: "alpha", slug, fields: { worktree: repo }, env });
  return repo;
}

test("`run check` answers OK on a complete artifact and names every section the artifact does not carry", async (t) => {
  const env = makeQueue(t, "cli-run-check-sections");
  const id = boundJob(env);
  writeArtifact(env, "01-triage.md", "# Triage\n\n## Verdict: PROCEED\n\nEvidence level: 3\n");
  writeArtifact(env, "03-plan.md", "# Plan\n\n## Implementation plan\n\n- do it\n\n## Assumptions\n\nnone\n");

  const triage = await runCli(env, ["run", "check", "01"], { jobId: id });
  assert.equal(triage.code, 0);
  assert.deepEqual(triage.out, ["OK"]);

  const plan = await runCli(env, ["run", "check", "03"], { jobId: id });
  assert.equal(plan.code, 0);
  assert.deepEqual(plan.out, ["MISSING: ## Pre-mortem, ## Identified risks"]);

  const qa = await runCli(env, ["run", "check", "05a"], { jobId: id });
  assert.deepEqual(qa.out, ["MISSING: ## Break hypotheses, ## Test recipe"]);

  const explore = await runCli(env, ["run", "check", "02"], { jobId: id });
  assert.deepEqual(explore.out, ["MISSING: 02-explore.md (not written)"]);

  writeArtifact(env, "06-runtime.md", "# Runtime\n\nDiff applies plan: yes\n");
  const runtimeIncomplete = await runCli(env, ["run", "check", "06.5"], { jobId: id });
  assert.deepEqual(runtimeIncomplete.out, ["MISSING: ## Runtime verdict"]);

  writeArtifact(env, "06-runtime.md", "# Runtime\n\n## Runtime verdict\n\nCONFIRMED\n");
  const runtime = await runCli(env, ["run", "check", "06.5"], { jobId: id });
  assert.deepEqual(runtime.out, ["OK"]);
});

const EVIDENCE_MISSING = "MISSING: Evidence level: <1|2|3|4> as the first line under ## Verdict";

test("`run check 01` requires `Evidence level: <1-4>` as the first line under ## Verdict, and nowhere else", async (t) => {
  const env = makeQueue(t, "cli-run-check-evidence");
  const id = boundJob(env);
  const cases = [
    ["# Triage\n\n## Verdict: PROCEED\n\nThe cause is confirmed.\n", EVIDENCE_MISSING],
    ["# Triage\n\n## Verdict: PROCEED\n\n## Diagnosis\nEvidence level: 3\n", EVIDENCE_MISSING],
    ["# Triage\n\n## Verdict: PROCEED\n\nThe cause.\nEvidence level: 3\n", EVIDENCE_MISSING],
    ["# Triage\n\n## Verdict: PROCEED\n\nEvidence level: 0\n", EVIDENCE_MISSING],
    ["# Triage\n\n## Verdict: PROCEED\n\nEvidence level: 5\n", EVIDENCE_MISSING],
    ["# Triage\n\n## Verdict: NOT-REPRODUCIBLE\nEvidence level: 1\n", "OK"],
    ["# Triage\n\n## Verdict: PROCEED\n\n**Evidence level:** 4\n", "OK"],
    ["# Triage\n\n## Verdict: PROCEED\n\n**Evidence level: 3**\n", "OK"],
    ["# Triage\n\n## Verdict: PROCEED\n\n**Evidence level: 5**\n", EVIDENCE_MISSING],
    ["# Triage\n\n## Diagnosis\n\n- cause\n", "MISSING: ## Verdict"],
  ];
  for (const [body, expected] of cases) {
    writeArtifact(env, "01-triage.md", body);
    const { out } = await runCli(env, ["run", "check", "01"], { jobId: id });
    assert.deepEqual(out, [expected], JSON.stringify(body));
  }
});

test("`run check 05a` outside a job answers for an operator run named by project and slug", async (t) => {
  const env = makeQueue(t, "cli-run-check-operator-05a");
  const slug = "hunt-the-notice";
  recordRunFields({ project: "alpha", slug, fields: { origin: "operator" }, env });
  writeArtifact(env, "05a-qa-analyst.md", "# QA\n\n## Break hypotheses\n\n- H1\n\n## Test recipe\n\nnode --test\n", { slug });
  const qa = await runCli(env, ["run", "check", "05a", "--project", "alpha", "--slug", slug]);
  assert.equal(qa.code, 0);
  assert.deepEqual(qa.out, ["OK"]);
});

test("`run check 04` generates the file list from the worktree when the coder left none", async (t) => {
  const env = makeQueue(t, "cli-run-check-generate");
  const id = boundJob(env);
  const repo = boundWorktree(t, env);
  writeFileSync(join(repo, "tracked.mjs"), "export const a = 1;\n");
  execFileSync("git", ["-C", repo, "add", "tracked.mjs"]);
  writeFileSync(join(repo, "untracked.md"), "notes\n");

  const { code, out } = await runCli(env, ["run", "check", "04"], { jobId: id });

  assert.equal(code, 0);
  assert.deepEqual(out, ["GENERATED"]);
  const artifact = readFileSync(join(runDir("alpha", SLUG, env), "04-implementation.md"), "utf8");
  assert.match(artifact, /## Modified files\n/);
  assert.deepEqual(artifact.split("## Modified files\n")[1].trim().split("\n"), [join(repo, "tracked.mjs"), join(repo, "untracked.md")]);

  const again = await runCli(env, ["run", "check", "04"], { jobId: id });
  assert.deepEqual(again.out, ["OK"]);
});

test("`run check 04` on a clean worktree reports the empty list and writes no artifact", async (t) => {
  const env = makeQueue(t, "cli-run-check-clean");
  const id = boundJob(env);
  boundWorktree(t, env);
  const artifact = join(runDir("alpha", SLUG, env), "04-implementation.md");

  const { code, out } = await runCli(env, ["run", "check", "04"], { jobId: id });

  assert.equal(code, 0);
  assert.deepEqual(out, ["MISSING: ## Modified files (no changed files)"]);
  assert.equal(existsSync(artifact), false);

  writeArtifact(env, "04-implementation.md", "# Implementation\n\n## Modified files\n\n");
  const empty = await runCli(env, ["run", "check", "04"], { jobId: id });
  assert.deepEqual(empty.out, ["MISSING: ## Modified files (no changed files)"]);
  assert.equal(readFileSync(artifact, "utf8"), "# Implementation\n\n## Modified files\n\n");
});

test("`run check` refuses a phase it does not know and a missing argument, and everything else it answers exits 0", async (t) => {
  const env = makeQueue(t, "cli-run-check-usage");
  const id = boundJob(env);

  const unknown = await runCli(env, ["run", "check", "07"], { jobId: id });
  assert.equal(unknown.code, 1);
  assert.match(unknown.err.join("\n"), /unknown phase `07`; the artifact gate covers: 01, 02, 03, 04, 05a, 05, 06, 06\.5$/m);

  const missing = await runCli(env, ["run", "check"], { jobId: id });
  assert.equal(missing.code, 1);
  assert.match(missing.err.join("\n"), /missing argument; usage: nightshift run check <NN>/);

  const absent = await runCli(env, ["run", "check", "06"], { jobId: id });
  assert.equal(absent.code, 0);
  assert.deepEqual(absent.out, ["MISSING: ## Verification"]);
});

test("the top-level help lists `run` under its own heading, saying it acts on the run of the job it is called from", async (t) => {
  const env = makeQueue(t, "cli-run-help");

  const { code, text } = await runCli(env, ["--help"]);

  assert.equal(code, 0);
  assert.match(text, /inside a job — each acts on the run of the job it is called from, never on the queue:/);
  assert.match(text, /\n {2}run check <NN> +check the artifact of a phase of THIS run/);
  assert.match(text, /\n {2}run log \[--json\] +one line per phase of THIS run/);
  assert.match(text, /\n {2}run commit --message-file <path> +stage what 04-implementation\.md listed/);
  assert.match(text, /\n {2}run pr --body-file <path> +check the body, push THIS run's branch/);
  assert.match(text, /\n {2}queue run \[--job \| --watch\]/);
});
