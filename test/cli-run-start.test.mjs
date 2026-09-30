import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { test } from "node:test";
import { run } from "../src/cli/index.mjs";
import { runDir } from "../src/config/paths.mjs";
import { openDb } from "../src/memory/db.mjs";
import { addJob } from "../src/memory/jobs.mjs";
import { readRunState } from "../src/queue/resume.mjs";
import { routingRow, routingTable } from "../src/queue/routing.mjs";
import { recordRunFields } from "../src/queue/run-state.mjs";
import { ensureProject, makeHome, makeProject, projectPathOf } from "../test-support/memory.mjs";

const SLUG = "add-slugify";
const START = ["run", "start", "--tier", "simple", "--type", "feature/refactor", "--commit-type", "feat"];

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

test("`run start` answers the run, the ONE routing row of its tier, the phases and the tasks, and records type and tier", async (t) => {
  const env = makeQueue(t, "run-start-happy");
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
    "tier",
    "type",
    "commitType",
    "routing",
    "phases",
    "tasks",
    "prTemplate",
    "commitConvention",
  ]);
  assert.equal(answer.project, "alpha");
  assert.equal(answer.slug, SLUG);
  assert.equal(answer.runDir, runDir(ensureProject(env, "alpha"), SLUG, env));
  assert.equal(answer.commitType, "feat");
  assert.deepEqual(answer.routing, routingRow("simple"));
  assert.deepEqual(answer.phases, ["implementation", "verification", "commit"]);
  assert.deepEqual(answer.tasks, ["implementation", "verification", "commit"]);
  assert.deepEqual(answer.prTemplate, { source: "nightqueue", label: "nightqueue (fallback)", headings: ["## Report", "## Cause", "## Changes", "## QA"] });
  assert.equal(typeof answer.commitConvention, "string");
  const state = readRunState({ projectId: ensureProject(env, "alpha"), slug: SLUG, env });
  assert.equal(state.type, "feature/refactor");
  assert.equal(state.tier, "simple");
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
  assert.deepEqual(readdirSync(answer.runDir).sort(), ["state.json"]);
});

test("`run start` without a recorded worktree answers null and reads the project's checkout", async (t) => {
  const env = makeQueue(t, "run-start-no-worktree");
  const answer = answerOf(await runCli(env, START, { jobId: boundJob(env) }));
  assert.equal(answer.worktree, null);
  assert.equal(answer.branch, null);
});

test("`run start` refuses a tier, a type or a commit type outside the pipeline's own, naming the accepted values", async (t) => {
  const env = makeQueue(t, "run-start-enums");
  const id = boundJob(env);
  const cases = [
    [["--tier", "huge", "--type", "bug/error", "--commit-type", "fix"], /unknown tier `huge`; accepted: trivial, simple, complex/],
    [["--tier", "simple", "--type", "chore", "--commit-type", "fix"], /unknown type `chore`; accepted: bug\/error, feature\/refactor/],
    [["--tier", "simple", "--type", "bug/error", "--commit-type", "wip"], /unknown commit type `wip`; accepted: feat, fix, refactor, docs, style, build, chore, test/],
    [["--tier", "simple", "--type", "bug/error"], /unknown commit type ``/],
  ];
  for (const [flags, message] of cases) {
    const result = await runCli(env, ["run", "start", ...flags], { jobId: id });
    assert.equal(result.code, 1, flags.join(" "));
    assert.match(result.errText, message);
  }
  assert.equal(readRunState({ projectId: ensureProject(env, "alpha"), slug: SLUG, env }), null, "a refused call recorded something");
});

test("`run start --routing` prints the whole routing table and resolves no run, inside a job or outside", async (t) => {
  const env = makeQueue(t, "run-start-routing");
  const outside = await runCli(env, ["run", "start", "--routing"]);
  assert.equal(outside.code, 0, outside.errText);
  assert.equal(outside.text, routingTable());
  const id = boundJob(env);
  const inside = await runCli(env, ["run", "start", "--routing"], { jobId: id });
  assert.equal(inside.code, 0, inside.errText);
  assert.equal(inside.text, routingTable());
  assert.equal(readRunState({ projectId: ensureProject(env, "alpha"), slug: SLUG, env }), null, "--routing recorded a run state");
  assert.equal(existsSync(runDir(ensureProject(env, "alpha"), SLUG, env)), false, "--routing created a run directory");
});

test("`run start --routing` combined with any other option is refused with the usage", async (t) => {
  const env = makeQueue(t, "run-start-routing-mixed");
  const result = await runCli(env, ["run", "start", "--routing", "--tier", "simple"]);
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

test("a second `run start` never lowers a raised tier nor overrides the recorded type, and answers the run's own", async (t) => {
  const env = makeQueue(t, "run-start-raised-tier");
  const id = boundJob(env);
  const projectId = ensureProject(env, "alpha");
  answerOf(await runCli(env, START, { jobId: id }));
  recordRunFields({ projectId, slug: SLUG, fields: { tier: "complex", type: "bug/error" }, env });

  const answer = answerOf(await runCli(env, START, { jobId: id }));

  const state = readRunState({ projectId, slug: SLUG, env });
  assert.equal(state.tier, "complex");
  assert.equal(state.type, "bug/error");
  assert.equal(answer.tier, "complex");
  assert.equal(answer.type, "bug/error");
  assert.deepEqual(answer.routing, routingRow("complex"));
});

test("a second `run start` may still raise the recorded tier", async (t) => {
  const env = makeQueue(t, "run-start-raise-again");
  const id = boundJob(env);
  answerOf(await runCli(env, START, { jobId: id }));
  const raise = ["run", "start", "--tier", "complex", "--type", "feature/refactor", "--commit-type", "feat"];

  const answer = answerOf(await runCli(env, raise, { jobId: id }));

  assert.equal(answer.tier, "complex");
  assert.equal(readRunState({ projectId: ensureProject(env, "alpha"), slug: SLUG, env }).tier, "complex");
});

test("outside a job `run start` works on the run the operator names, creating its state", async (t) => {
  const env = makeQueue(t, "run-start-operator");
  const answer = answerOf(await runCli(env, [...START, "--project", "alpha", "--slug", SLUG]));
  assert.equal(answer.slug, SLUG);
  assert.equal(readRunState({ projectId: ensureProject(env, "alpha"), slug: SLUG, env }).tier, "simple");

  const named = await runCli(env, [...START, "--project", "alpha", "--slug", SLUG], { jobId: boundJob(env) });
  assert.equal(named.code, 1);
  assert.match(named.errText, /refusing to name a run from inside job/);
});
