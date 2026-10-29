import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { run } from "../src/cli/index.mjs";
import { runDir } from "../src/config/paths.mjs";
import { openDb } from "../src/memory/db.mjs";
import { addJob } from "../src/memory/jobs.mjs";
import { readRunState } from "../src/queue/resume.mjs";
import { setProjectAgents } from "../src/memory/registry.mjs";
import { AGENT_MODELS, modelTable } from "../src/queue/routing.mjs";
import { recordRunFields } from "../src/queue/run-state.mjs";
import { ensureProject, makeHome, makeProject, projectPathOf } from "../test-support/memory.mjs";

const SLUG = "add-slugify";
const START = ["run", "start", "--type", "feature/refactor", "--commit-type", "feat"];

// A home with one registered project.
function makeQueue(t, name) {
  const env = makeHome(t, name);
  makeProject(t, env, "alpha");
  return env;
}

// A job whose row already carries the given run slug.
function boundJob(env, slug = SLUG) {
  const id = addJob({ projectId: ensureProject(env, "alpha"), prompt: "add slugify" }, env).id;
  openDb(env).prepare("UPDATE jobs SET slug = ? WHERE id = ?").run(slug, id);
  return id;
}

// Runs the CLI in this process as the job (or as the operator when `jobId` is null), with an optional slug wait.
async function runCli(env, argv, { jobId = null, slugWaitMs = 0 } = {}) {
  const out = [];
  const err = [];
  const code = await run(argv, {
    env: jobId === null ? { ...env } : { ...env, NIGHTQUEUE_JOB_ID: String(jobId) },
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    stdout: { write: () => {} },
    slugWaitMs,
    slugPollMs: 10,
  });
  return { code, out, err, text: out.join("\n"), errText: err.join("\n") };
}

// The JSON answer of a successful `run start`.
function answerOf(result) {
  assert.equal(result.code, 0, `${result.text}\n${result.errText}`);
  assert.equal(result.out.length, 1, "run start prints exactly one JSON line");
  return JSON.parse(result.out[0]);
}

const EVERY_PHASE = ["triage", "explore", "architecture", "implementation", "qa", "verification", "runtime", "commit"];

test("`run start` answers the run, its agent models, and every phase but no tasks, and records the type and no tier", async (t) => {
  const env = { ...makeQueue(t, "run-start-happy"), GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
  const id = boundJob(env);

  const answer = answerOf(await runCli(env, START, { jobId: id }));

  assert.deepEqual(Object.keys(answer), [
    "project",
    "slug",
    "slugDeclared",
    "slugBound",
    "runDir",
    "worktree",
    "branch",
    "type",
    "commitType",
    "models",
    "phases",
    "prTemplate",
    "commitConvention",
    "commitTemplate",
    "promptFile",
  ]);
  assert.equal(answer.promptFile, join(answer.runDir, "00-prompt.md"));
  assert.equal(readFileSync(answer.promptFile, "utf8"), "add slugify\n");
  assert.equal(answer.project, "alpha");
  assert.equal(answer.slug, SLUG);
  assert.equal(answer.runDir, runDir(ensureProject(env, "alpha"), SLUG, env));
  assert.equal(answer.commitType, "feat");
  assert.deepEqual(answer.models, { ...AGENT_MODELS });
  assert.deepEqual(answer.phases, EVERY_PHASE);
  assert.equal("tasks" in answer, false, "run start still answers tasks");
  assert.deepEqual(answer.prTemplate, { source: "nightqueue", label: "nightqueue (fallback)", headings: ["## Report", "## Cause", "## Changes", "## QA"] });
  assert.equal(typeof answer.commitConvention, "string");
  assert.deepEqual(answer.commitTemplate, { source: "nightqueue", path: null, label: "nightqueue (fallback)" });
  const state = readRunState({ projectId: ensureProject(env, "alpha"), slug: SLUG, env });
  assert.equal(state.type, "feature/refactor");
  assert.equal("tier" in state, false, "run start recorded a tier");
  assert.equal(state.prTemplate.source, "nightqueue");
});

test("`run start` reports the worktree the runtime recorded and never creates one", async (t) => {
  const env = makeQueue(t, "run-start-worktree");
  const id = boundJob(env);
  const worktree = `${projectPathOf(env, "alpha")}-wt`;
  recordRunFields({ projectId: ensureProject(env, "alpha"), slug: SLUG, fields: { worktree, branch: `worktree-${SLUG}` }, env });

  const answer = answerOf(await runCli(env, START, { jobId: id }));

  assert.equal(answer.worktree, worktree);
  assert.equal(answer.branch, `worktree-${SLUG}`);
  assert.equal(existsSync(worktree), false, "run start created a worktree");
  assert.deepEqual(readdirSync(answer.runDir).sort(), ["00-prompt.md", "state.json"]);
});

test("`run start` without a recorded worktree answers null and reads the project's checkout", async (t) => {
  const env = makeQueue(t, "run-start-no-worktree");
  const answer = answerOf(await runCli(env, START, { jobId: boundJob(env) }));
  assert.equal(answer.worktree, null);
  assert.equal(answer.branch, null);
});

test("`run start` refuses a type or a commit type outside the pipeline's own, naming the accepted values, and refuses any `--tier`", async (t) => {
  const env = makeQueue(t, "run-start-enums");
  const id = boundJob(env);
  const tierRemoved = /`--tier` was removed: every run executes the one pipeline; run `nightqueue run start` without it/;
  const cases = [
    [["--type", "chore", "--commit-type", "fix"], /unknown type `chore`; accepted: bug\/error, feature\/refactor/],
    [["--type", "bug/error", "--commit-type", "wip"], /unknown commit type `wip`; accepted: feat, fix, refactor, docs, style, build, chore, test/],
    [["--tier", "simple", "--type", "bug/error"], tierRemoved],
    [["--tier", "complex"], tierRemoved],
  ];
  for (const [flags, message] of cases) {
    const result = await runCli(env, ["run", "start", ...flags], { jobId: id });
    assert.equal(result.code, 1, flags.join(" "));
    assert.match(result.errText, message);
  }
  assert.equal(readRunState({ projectId: ensureProject(env, "alpha"), slug: SLUG, env }), null, "a refused call recorded something");
});

test("a bare `run start` answers every phase with no type nor commit type, and records neither", async (t) => {
  const env = makeQueue(t, "run-start-bare");
  const id = boundJob(env);

  const answer = answerOf(await runCli(env, ["run", "start"], { jobId: id }));

  assert.equal(answer.type, null);
  assert.equal(answer.commitType, null);
  assert.deepEqual(answer.models, { ...AGENT_MODELS });
  assert.deepEqual(answer.phases, EVERY_PHASE);
  assert.equal("tasks" in answer, false, "run start still answers tasks");
  const state = readRunState({ projectId: ensureProject(env, "alpha"), slug: SLUG, env });
  assert.equal("tier" in state, false, "run start recorded a tier");
  assert.equal("type" in state, false, "run start recorded a type it was never given");
  assert.equal("commitType" in state, false, "run start recorded a commit type");
});

test("a bare `run start` answers the type and the commit type `run check 01` already recorded", async (t) => {
  const env = makeQueue(t, "run-start-recorded");
  const id = boundJob(env);
  recordRunFields({ projectId: ensureProject(env, "alpha"), slug: SLUG, fields: { type: "bug/error", commitType: "fix" }, env });

  const answer = answerOf(await runCli(env, ["run", "start"], { jobId: id }));

  assert.equal(answer.type, "bug/error");
  assert.equal(answer.commitType, "fix");
  assert.deepEqual(answer.models, { ...AGENT_MODELS });
});

test("`run start` answers the project's agent model overrides over the defaults", async (t) => {
  const env = makeQueue(t, "run-start-models");
  const id = boundJob(env);
  setProjectAgents(openDb(env), { id: ensureProject(env, "alpha"), value: { coder: { model: "sonnet" } } });

  const answer = answerOf(await runCli(env, START, { jobId: id }));

  assert.equal(answer.models.coder, "sonnet");
  assert.equal(answer.models.architect, "opus");
});

test("`run start --routing` prints the agent model table and resolves no run, inside a job or outside", async (t) => {
  const env = makeQueue(t, "run-start-routing");
  const outside = await runCli(env, ["run", "start", "--routing"]);
  assert.equal(outside.code, 0, outside.errText);
  assert.equal(outside.text, modelTable());
  assert.match(outside.text, /^\| Agent \| Model \|/);
  const id = boundJob(env);
  const inside = await runCli(env, ["run", "start", "--routing"], { jobId: id });
  assert.equal(inside.code, 0, inside.errText);
  assert.equal(inside.text, modelTable());
  assert.equal(readRunState({ projectId: ensureProject(env, "alpha"), slug: SLUG, env }), null, "--routing recorded a run state");
  assert.equal(existsSync(runDir(ensureProject(env, "alpha"), SLUG, env)), false, "--routing created a run directory");
});

test("`run start --routing` combined with any other option is refused with the usage", async (t) => {
  const env = makeQueue(t, "run-start-routing-mixed");
  const result = await runCli(env, ["run", "start", "--routing", "--type", "bug/error"]);
  assert.equal(result.code, 1);
  assert.match(result.errText, /`--routing` takes no other option or argument; usage: nightqueue run start/);
});

test("`run start --expect-slug` waits for the runner to bind the declared slug, then answers the bound run", async (t) => {
  const env = makeQueue(t, "run-start-expect");
  const id = boundJob(env, "provisional-slug");
  const bind = setTimeout(() => openDb(env).prepare("UPDATE jobs SET slug = ? WHERE id = ?").run(SLUG, id), 100);
  t.after(() => clearTimeout(bind));

  const answer = answerOf(await runCli(env, [...START, "--expect-slug", SLUG], { jobId: id, slugWaitMs: 5000 }));

  assert.equal(answer.slug, SLUG);
  assert.equal(answer.slugDeclared, SLUG);
  assert.equal(answer.slugBound, true);
  assert.ok(answer.runDir.endsWith(`/${SLUG}`), answer.runDir);
});

test("`run start --expect-slug` answers the row's slug when the bind never comes, and says it was not bound", async (t) => {
  const env = makeQueue(t, "run-start-expect-late");
  const id = boundJob(env, "provisional-slug");

  const answer = answerOf(await runCli(env, [...START, "--expect-slug", SLUG], { jobId: id, slugWaitMs: 30 }));

  assert.equal(answer.slug, "provisional-slug");
  assert.equal(answer.slugDeclared, SLUG);
  assert.equal(answer.slugBound, false);
});

test("`run start` is idempotent: a resume asking again gets the same answer", async (t) => {
  const env = makeQueue(t, "run-start-idempotent");
  const id = boundJob(env);
  const first = answerOf(await runCli(env, START, { jobId: id }));
  const second = answerOf(await runCli(env, START, { jobId: id }));
  assert.deepEqual(second, first);
});

test("a second `run start` never overrides the recorded type, and answers the run's own", async (t) => {
  const env = makeQueue(t, "run-start-recorded-type");
  const id = boundJob(env);
  const projectId = ensureProject(env, "alpha");
  answerOf(await runCli(env, START, { jobId: id }));
  recordRunFields({ projectId, slug: SLUG, fields: { type: "bug/error" }, env });

  const answer = answerOf(await runCli(env, START, { jobId: id }));

  const state = readRunState({ projectId, slug: SLUG, env });
  assert.equal(state.type, "bug/error");
  assert.equal(answer.type, "bug/error");
  assert.equal("tier" in answer, false, "run start answered a tier");
  assert.deepEqual(answer.phases, EVERY_PHASE);
});

test("`run start --tier` on a run that already started is refused and changes nothing", async (t) => {
  const env = makeQueue(t, "run-start-tier-refused");
  const id = boundJob(env);
  const projectId = ensureProject(env, "alpha");
  answerOf(await runCli(env, START, { jobId: id }));
  const before = readRunState({ projectId, slug: SLUG, env });

  const result = await runCli(env, ["run", "start", "--tier", "simple", "--type", "feature/refactor"], { jobId: id });

  assert.equal(result.code, 1);
  assert.match(result.errText, /`--tier` was removed/);
  assert.deepEqual(readRunState({ projectId, slug: SLUG, env }), before);
});

test("outside a job `run start` works on the run the operator names, creating its state", async (t) => {
  const env = makeQueue(t, "run-start-operator");
  const answer = answerOf(await runCli(env, [...START, "--project", "alpha", "--slug", SLUG]));
  assert.equal(answer.slug, SLUG);
  assert.equal(answer.promptFile, null);
  assert.equal(readRunState({ projectId: ensureProject(env, "alpha"), slug: SLUG, env }).type, "feature/refactor");

  const named = await runCli(env, [...START, "--project", "alpha", "--slug", SLUG], { jobId: boundJob(env) });
  assert.equal(named.code, 1);
  assert.match(named.errText, /refusing to name a run from inside job/);
});
