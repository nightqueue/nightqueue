import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { run } from "../src/cli/index.mjs";
import { runDir } from "../src/config/paths.mjs";
import { openDb } from "../src/memory/db.mjs";
import { addJob } from "../src/memory/jobs.mjs";
import { readRunState } from "../src/queue/resume.mjs";
import { setProjectAgents, setProjectDemoRepo } from "../src/memory/registry.mjs";
import { defaultAgentModels, modelTable } from "../src/queue/routing.mjs";
import { recordPhaseDone, recordRunFields } from "../src/queue/run-state.mjs";
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
    "orchestratorModel",
    "phases",
    "prTemplate",
    "commitConvention",
    "commitTemplate",
    "promptFile",
    "needsSlug",
    "demoRepo",
    "baseRef",
    "pluginRoot",
    "stages",
    "drafts",
  ]);
  assert.equal(answer.promptFile, join(answer.runDir, "00-prompt.md"));
  assert.equal(readFileSync(answer.promptFile, "utf8"), "add slugify\n");
  assert.equal(answer.project, "alpha");
  assert.equal(answer.slug, SLUG);
  assert.equal(answer.runDir, runDir(ensureProject(env, "alpha"), SLUG, env));
  assert.equal(answer.commitType, "feat");
  assert.deepEqual(answer.models, { ...defaultAgentModels() });
  assert.equal(answer.orchestratorModel, "default");
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
  assert.deepEqual(answer.models, { ...defaultAgentModels() });
  assert.equal(answer.orchestratorModel, "default");
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
  assert.deepEqual(answer.models, { ...defaultAgentModels() });
  assert.equal(answer.orchestratorModel, "default");
});

test("`run start` answers the project's agent model overrides over the defaults", async (t) => {
  const env = makeQueue(t, "run-start-models");
  const id = boundJob(env);
  setProjectAgents(openDb(env), { id: ensureProject(env, "alpha"), value: { coder: { model: "sonnet" }, orchestrator: { model: "sonnet" } } });

  const answer = answerOf(await runCli(env, START, { jobId: id }));

  assert.equal(answer.models.coder, "sonnet");
  assert.equal(answer.models.architect, "opus");
  assert.equal(answer.orchestratorModel, "sonnet");
  assert.equal(Object.hasOwn(answer.models, "orchestrator"), false);
});

test("`run start --routing` prints the agent model table and resolves no run, inside a job or outside", async (t) => {
  const env = makeQueue(t, "run-start-routing");
  const outside = await runCli(env, ["run", "start", "--routing"]);
  assert.equal(outside.code, 0, outside.errText);
  assert.equal(outside.text, modelTable());
  assert.match(outside.text, /^\| Agent \| Model \|/);
  assert.match(outside.text, /\| orchestrator \| default \|$/);
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

test("`needsSlug` is true only while the job's slug is the provisional one the runtime derived", async (t) => {
  const env = makeQueue(t, "run-start-needs-slug");
  assert.equal(answerOf(await runCli(env, START, { jobId: boundJob(env, "add-slugify") })).needsSlug, true);
  assert.equal(answerOf(await runCli(env, START, { jobId: boundJob(env, "a-named-run") })).needsSlug, false);
  assert.equal(answerOf(await runCli(env, [...START, "--project", "alpha", "--slug", SLUG])).needsSlug, false, "outside a job the slug is the operator's");
});

test("`demoRepo` answers the project's checkout, or `none configured`", async (t) => {
  const env = makeQueue(t, "run-start-demo-repo");
  assert.equal(answerOf(await runCli(env, START, { jobId: boundJob(env) })).demoRepo, "none configured");
  setProjectDemoRepo(openDb(env), { id: ensureProject(env, "alpha"), value: "/demo/checkout" });
  assert.equal(answerOf(await runCli(env, START, { jobId: boundJob(env) })).demoRepo, "/demo/checkout");
});

test("`baseRef` answers the default branch, the checkout's own branch without one, and `HEAD` with a stderr line on a detached checkout", async (t) => {
  const env = { ...makeQueue(t, "run-start-base-ref"), GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
  const repo = projectPathOf(env, "alpha");
  const git = (...args) => execFileSync("git", ["-C", repo, ...args], { env: { ...env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  rmSync(join(repo, ".git"), { recursive: true, force: true });
  git("init", "-q", "-b", "trunk");
  git("commit", "-q", "--allow-empty", "-m", "first");
  git("checkout", "-q", "--detach");

  const without = await runCli(env, START, { jobId: boundJob(env) });
  assert.equal(answerOf(without).baseRef, "HEAD");
  assert.match(without.errText, /answering `HEAD` as the base branch: no base branch/);

  git("checkout", "-q", "trunk");
  const own = await runCli(env, START, { jobId: boundJob(env) });
  assert.equal(answerOf(own).baseRef, "trunk");
  assert.match(own.errText, /answering `trunk` as the base branch: no base branch/);

  git("branch", "-m", "main");
  assert.equal(answerOf(await runCli(env, START, { jobId: boundJob(env) })).baseRef, "main");
});

test("`pluginRoot` is the plugin of this runtime, the directory the agents and the skills ship in", async (t) => {
  const env = makeQueue(t, "run-start-plugin-root");
  const { pluginRoot } = answerOf(await runCli(env, START, { jobId: boundJob(env) }));
  assert.ok(existsSync(join(pluginRoot, "agents", "triager.md")), pluginRoot);
  assert.ok(existsSync(join(pluginRoot, "skills", "reflect", "references", "rubric.md")), pluginRoot);
});

test("`stages` is empty with no Brief or no field, and lists the Brief's numbered stages in order, on one line or several", async (t) => {
  const env = makeQueue(t, "run-start-stages");
  const id = boundJob(env);
  const dir = runDir(ensureProject(env, "alpha"), SLUG, env);
  const stagesWith = async (brief) => {
    writeFileSync(join(dir, "00-brief.md"), brief);
    return answerOf(await runCli(env, START, { jobId: id })).stages;
  };

  assert.deepEqual(answerOf(await runCli(env, START, { jobId: id })).stages, []);
  assert.deepEqual(await stagesWith("## Brief\n**Type:** bug/error\n"), []);
  assert.deepEqual(await stagesWith("## Brief\n**Stages:** 1) runtime; 2) shim\n**Slug:** a\n"), ["1) runtime; 2) shim"]);
  assert.deepEqual(await stagesWith("## Brief\n**Stages:** \n1. first\n2. second\n\n## Request critique\n"), ["1. first", "2. second"]);
  assert.deepEqual(await stagesWith("## Brief\n**Stages:**\n1. only\n"), ["1. only"]);
});

test("`run start` deletes a previous attempt's delivery drafts and keeps every other file of the run", async (t) => {
  const env = makeQueue(t, "run-start-stale-drafts");
  const id = boundJob(env);
  const dir = runDir(ensureProject(env, "alpha"), SLUG, env);
  mkdirSync(dir, { recursive: true });
  for (const file of ["commit-message.txt", "pr-body.md", "pr-body.published.md", "03-plan.md"]) writeFileSync(join(dir, file), "kept?\n");

  answerOf(await runCli(env, START, { jobId: id }));

  assert.equal(existsSync(join(dir, "commit-message.txt")), false);
  assert.equal(existsSync(join(dir, "pr-body.md")), false);
  assert.equal(existsSync(join(dir, "pr-body.published.md")), true);
  assert.equal(existsSync(join(dir, "03-plan.md")), true);
  assert.deepEqual(answerOf(await runCli(env, START, { jobId: id })).drafts, []);
});

for (const phase of ["verification", "runtime"]) {
  test(`\`run start\` keeps the drafts of a run that recorded \`${phase}\` and names them in \`drafts\``, async (t) => {
    const env = makeQueue(t, `run-start-kept-drafts-${phase}`);
    const id = boundJob(env);
    const projectId = ensureProject(env, "alpha");
    const dir = runDir(projectId, SLUG, env);
    assert.equal(recordPhaseDone({ projectId, slug: SLUG, phase, env }).status, "written");
    writeFileSync(join(dir, "commit-message.txt"), "feat: x\n");

    assert.deepEqual(answerOf(await runCli(env, START, { jobId: id })).drafts, ["commit-message.txt"]);
    assert.equal(readFileSync(join(dir, "commit-message.txt"), "utf8"), "feat: x\n");

    writeFileSync(join(dir, "pr-body.md"), "## Report\n");
    assert.deepEqual(answerOf(await runCli(env, START, { jobId: id })).drafts, ["commit-message.txt", "pr-body.md"]);
  });
}

test("`run start` still deletes the drafts of a run whose earlier phases only are recorded", async (t) => {
  const env = makeQueue(t, "run-start-early-phase-drafts");
  const id = boundJob(env);
  const projectId = ensureProject(env, "alpha");
  const dir = runDir(projectId, SLUG, env);
  assert.equal(recordPhaseDone({ projectId, slug: SLUG, phase: "implementation", env }).status, "written");
  writeFileSync(join(dir, "pr-body.md"), "## Report\n");

  assert.deepEqual(answerOf(await runCli(env, START, { jobId: id })).drafts, []);
  assert.equal(existsSync(join(dir, "pr-body.md")), false);
});
