import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { test } from "node:test";
import { run } from "../src/cli/index.mjs";
import { jobWorktreePath, runDir } from "../src/config/paths.mjs";
import { readRunState } from "../src/queue/resume.mjs";
import { recordPhaseDone } from "../src/queue/run-state.mjs";
import { initGitRepo } from "../test-support/git.mjs";
import { makeDir, makeHome, makeProject, projectIdOf, registerCheckout } from "../test-support/memory.mjs";

const SLUG = "add-slugify";
const START = ["run", "start", "--project", "alpha", "--slug", SLUG];

// A home whose project `alpha` is a real repository with one commit on `main`.
function realRepoQueue(t, name) {
  const env = { ...makeHome(t, name), GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
  const repo = initGitRepo(makeDir(t, `${name}-repo`));
  registerCheckout(env, { path: repo, name: "alpha" });
  return { env, repo, projectId: projectIdOf(env, "alpha") };
}

// Runs the CLI in this process as the operator, outside any job.
async function runCli(env, argv) {
  const out = [];
  const err = [];
  const code = await run(argv, { env: { ...env }, out: (line) => out.push(line), err: (line) => err.push(line), stdout: { write: () => {} } });
  return { code, out, errText: err.join("\n") };
}

// The JSON answer of a successful `run start`.
function answerOf(result) {
  assert.equal(result.code, 0, result.errText);
  return JSON.parse(result.out[0]);
}

// The branch a worktree has checked out.
function currentBranch(path) {
  return execFileSync("git", ["-C", path, "branch", "--show-current"], { encoding: "utf8" }).trim();
}

test("outside a job `run start` places the worktree on `worktree-<slug>`, records it and answers it", async (t) => {
  const { env, projectId } = realRepoQueue(t, "run-start-place");
  const answer = answerOf(await runCli(env, START));

  const expected = jobWorktreePath(projectId, SLUG, env);
  assert.equal(answer.slug, SLUG);
  assert.equal(answer.worktree, expected);
  assert.equal(answer.branch, `worktree-${SLUG}`);
  assert.equal(currentBranch(expected), `worktree-${SLUG}`);
  assert.equal(answer.baseRef, "main");
  const state = readRunState({ projectId, slug: SLUG, env });
  assert.equal(state.worktree, expected);
  assert.equal(state.branch, `worktree-${SLUG}`);
});

test("a second `run start` on the same name takes the next slot, leaving the first run as it was", async (t) => {
  const { env, projectId } = realRepoQueue(t, "run-start-next-slot");
  const first = answerOf(await runCli(env, START));
  const before = readRunState({ projectId, slug: SLUG, env });

  const second = answerOf(await runCli(env, START));

  assert.equal(second.slug, `${SLUG}-2`);
  assert.equal(second.runDir, runDir(projectId, `${SLUG}-2`, env));
  assert.notEqual(second.runDir, first.runDir);
  assert.equal(second.worktree, jobWorktreePath(projectId, `${SLUG}-2`, env));
  assert.equal(second.branch, `worktree-${SLUG}-2`);
  assert.deepEqual(readRunState({ projectId, slug: SLUG, env }), before);
  assert.equal(currentBranch(first.worktree), `worktree-${SLUG}`);
});

test("a slug whose branch already exists is skipped even with no run directory", async (t) => {
  const { env, repo } = realRepoQueue(t, "run-start-branch-taken");
  execFileSync("git", ["-C", repo, "branch", `worktree-${SLUG}`]);

  const answer = answerOf(await runCli(env, START));

  assert.equal(answer.slug, `${SLUG}-2`);
  assert.equal(answer.branch, `worktree-${SLUG}-2`);
});

test("an empty run directory of the slug is a held claim, so the start takes the next slot", async (t) => {
  const { env, projectId } = realRepoQueue(t, "run-start-empty-claim");
  mkdirSync(runDir(projectId, SLUG, env), { recursive: true });

  const answer = answerOf(await runCli(env, START));

  assert.equal(answer.slug, `${SLUG}-2`);
  assert.equal(answer.branch, `worktree-${SLUG}-2`);
  assert.equal(existsSync(jobWorktreePath(projectId, SLUG, env)), false);
});

test("a checkout with no commit keeps the run in place and says so on stderr", async (t) => {
  const env = makeHome(t, "run-start-no-commit");
  makeProject(t, env, "alpha");

  const result = await runCli(env, START);

  const answer = answerOf(result);
  assert.equal(answer.slug, SLUG);
  assert.equal(answer.worktree, null);
  assert.match(result.errText, /has no commit to branch from/);
});

test("a placement git refuses fails the start and removes the run directory it claimed", async (t) => {
  const { env, repo, projectId } = realRepoQueue(t, "run-start-place-fails");
  const parent = dirname(jobWorktreePath(projectId, SLUG, env));
  mkdirSync(dirname(parent), { recursive: true });
  writeFileSync(parent, "not a directory");

  const result = await runCli(env, START);

  assert.equal(result.code, 1);
  assert.match(result.errText, /could not be placed/);
  assert.equal(existsSync(runDir(projectId, SLUG, env)), false);
  assert.equal(execFileSync("git", ["-C", repo, "branch", "--list", `worktree-${SLUG}`], { encoding: "utf8" }).trim(), "");
});

test("a repeated `run start` of a run with a recorded phase resumes it under its own slug", async (t) => {
  const { env, projectId } = realRepoQueue(t, "run-start-resume");
  const first = answerOf(await runCli(env, START));
  assert.equal(recordPhaseDone({ projectId, slug: SLUG, phase: "triage", env }).status, "written");

  const second = answerOf(await runCli(env, START));

  assert.equal(second.slug, SLUG);
  assert.equal(second.runDir, first.runDir);
  assert.equal(second.worktree, first.worktree);
});

test("a checkout with no origin answers the branch it is on as the base", async (t) => {
  const env = { ...makeHome(t, "run-start-trunk"), GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
  const repo = initGitRepo(makeDir(t, "run-start-trunk-repo"));
  execFileSync("git", ["-C", repo, "branch", "-m", "trunk"]);
  registerCheckout(env, { path: repo, name: "alpha" });

  const answer = answerOf(await runCli(env, START));

  assert.equal(answer.branch, `worktree-${SLUG}`);
  assert.equal(answer.baseRef, "trunk");
});

test("a registered checkout that no longer exists refuses the start, naming its path", async (t) => {
  const { env, repo } = realRepoQueue(t, "run-start-missing");
  rmSync(repo, { recursive: true, force: true });

  const result = await runCli(env, START);

  assert.equal(result.code, 1);
  assert.ok(result.errText.includes(repo), result.errText);
  assert.doesNotMatch(result.errText, /has no commit to branch from/);
});
