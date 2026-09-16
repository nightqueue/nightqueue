import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { run } from "../src/cli/index.mjs";
import { addProject } from "../src/config/projects.mjs";
import { loadConfig, saveConfig } from "../src/config/store.mjs";
import { ghBin } from "../src/host/gh.mjs";
import { openDb } from "../src/memory/db.mjs";
import { addJob } from "../src/memory/jobs.mjs";
import { readRunState } from "../src/queue/resume.mjs";
import { recordRunFields } from "../src/queue/run-state.mjs";
import { initGitRepo } from "../test-support/git.mjs";
import { FAKE_GH_PR_URL, isolatedHostVars } from "../test-support/host.mjs";
import { makeDir, makeHome } from "../test-support/memory.mjs";

const SLUG = "login-google";
const BRANCH = "worktree-feat+login-google";

const BODY = [
  "## Summary",
  "",
  "the run did the thing.",
  "",
  "## Changes",
  "",
  "- one file",
  "",
  "## QA",
  "",
  "Verdict: APPROVED — the attacked risks held.",
  "",
  "Proven:",
  "- the run did the thing",
  "",
  "Opened by nightshift · run login-google · job 1",
  "",
].join("\n");

// A git environment that depends on nothing of the machine: no global or system configuration, and an identity of its own.
function gitVars() {
  return {
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_AUTHOR_NAME: "nightshift",
    GIT_AUTHOR_EMAIL: "nightshift@example.invalid",
    GIT_COMMITTER_NAME: "nightshift",
    GIT_COMMITTER_EMAIL: "nightshift@example.invalid",
  };
}

// Runs git in the test's own hermetic environment, never with the configuration of the host.
function git(args) {
  return execFileSync("git", args, { encoding: "utf8", env: { ...process.env, ...gitVars() } });
}

// Proves the `gh` the runtime will spawn is the fake of the test: the file is executable and the resolver answers it, not the real CLI.
function assertFakeGh(env) {
  const bin = env.NIGHTSHIFT_GH_BIN;
  assert.equal(ghBin(env), bin, "the gh resolver does not answer the fake");
  assert.ok(existsSync(bin), `the fake gh is not at ${bin}`);
  assert.ok((statSync(bin).mode & 0o111) !== 0, "the fake gh is not executable, so the real gh would answer instead");
  const probe = spawnSync(bin, ["--proof"], { encoding: "utf8", env: { ...env, NIGHTSHIFT_FAKE_GH_LOG: "" } });
  assert.match(probe.stderr, /fake gh: unknown command/, "the binary that answered is not the fake gh");
}

// A local bare remote, the checkout that pushes to it and the worktree of the run: a real git that never leaves the temp directory.
function publishedRepo(t, name, { branch = BRANCH } = {}) {
  const remote = join(makeDir(t, `${name}-origin`), "origin.git");
  git(["-c", "init.defaultBranch=main", "init", "--bare", "-q", remote]);
  const checkout = initGitRepo(makeDir(t, `${name}-checkout`));
  git(["-C", checkout, "remote", "add", "origin", remote]);
  git(["-C", checkout, "push", "-q", "-u", "origin", "main"]);
  const worktree = join(makeDir(t, `${name}-worktrees`), branch);
  git(["-C", checkout, "worktree", "add", "-q", "-b", branch, worktree, "main"]);
  return { remote, checkout, worktree };
}

// A home whose project is the real checkout, with the fake gh installed and the job bound to the run of the worktree.
function makeRun(t, name, { branch = BRANCH, type = "feature/refactor" } = {}) {
  const repo = publishedRepo(t, name, { branch });
  const env = { ...makeHome(t, name), ...isolatedHostVars(makeDir(t, `${name}-host`)), ...gitVars() };
  saveConfig(addProject(loadConfig(env, { warn: () => {} }), { path: repo.checkout, name: "alpha" }).config, env);
  const id = addJob({ project: "alpha", prompt: "log in with google" }, env).id;
  openDb(env).prepare("UPDATE jobs SET slug = ? WHERE id = ?").run(SLUG, id);
  recordRunFields({ project: "alpha", slug: SLUG, fields: { worktree: repo.worktree, type }, env });
  assertFakeGh(env);
  return { ...repo, env, id };
}

// Runs the CLI in this process, as the job the run belongs to.
async function runCli(env, argv, { jobId }) {
  const out = [];
  const err = [];
  const code = await run(argv, {
    env: { ...env, NIGHTSHIFT_JOB_ID: String(jobId) },
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    stdout: { write: () => {} },
  });
  return { code, out, err, text: out.join("\n"), errText: err.join("\n") };
}

// Writes the pull request body where the command reads it from.
function writeBody(t, name, body) {
  const path = join(makeDir(t, name), "body.md");
  writeFileSync(path, body);
  return path;
}

// The calls the fake gh received, one array of arguments per call.
function ghCalls(env) {
  const log = env.NIGHTSHIFT_FAKE_GH_LOG;
  if (!existsSync(log)) return [];
  return readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

// The branches the bare remote really carries after the push.
function remoteBranches(remote) {
  return git(["-C", remote, "for-each-ref", "--format=%(refname:short)", "refs/heads"]).split("\n").filter(Boolean);
}

test("`run pr` renames the branch the worktree mangled, pushes it, opens the pull request and records the run as done", async (t) => {
  const { env, id, remote, worktree } = makeRun(t, "run-pr-happy");
  const body = writeBody(t, "run-pr-happy-body", BODY.replace("the run did the thing.", "the run did the thing.\nFixes #7"));

  const { code, out, err } = await runCli(env, ["run", "pr", "--body-file", body, "--title", "feat(auth): log in with google"], { jobId: id });

  assert.equal(code, 0);
  assert.deepEqual(err, []);
  assert.deepEqual(out, [
    `BRANCH: feat/login-google (renamed from ${BRANCH})`,
    `PR: ${FAKE_GH_PR_URL}`,
    `WORKTREE: ${worktree}`,
  ]);
  assert.equal(git(["-C", worktree, "rev-parse", "--abbrev-ref", "HEAD"]).trim(), "feat/login-google");
  assert.deepEqual(remoteBranches(remote), ["feat/login-google", "main"]);
  assert.deepEqual(ghCalls(env), [
    ["pr", "create", "--title", "feat(auth): log in with google", "--body-file", body, "--head", "feat/login-google"],
  ]);
  assert.equal(readRunState({ project: "alpha", slug: SLUG, env }).outcome.status, "done");
  assert.equal(existsSync(worktree), true);
});

test("`run pr --remove-worktree` removes the worktree from the checkout that owns it, after the outcome is recorded", async (t) => {
  const { env, id, worktree } = makeRun(t, "run-pr-remove");
  const body = writeBody(t, "run-pr-remove-body", BODY);

  const { code, out } = await runCli(env, ["run", "pr", "--body-file", body, "--title", "feat(auth): log in", "--remove-worktree"], { jobId: id });

  assert.equal(code, 0);
  assert.deepEqual(out.slice(-2), [`WORKTREE: ${worktree}`, `WORKTREE REMOVED: ${worktree}`]);
  assert.equal(existsSync(worktree), false);
  assert.equal(readRunState({ project: "alpha", slug: SLUG, env }).outcome.status, "done");
});

test("`run pr` rejects a placeholder, a missing section and a section out of order, and nothing is pushed", async (t) => {
  const { env, id, remote, worktree } = makeRun(t, "run-pr-rejected");

  const placeholder = writeBody(t, "run-pr-placeholder", BODY.replace("the run did the thing.", "{{summary}}"));
  const withPlaceholder = await runCli(env, ["run", "pr", "--body-file", placeholder, "--title", "t"], { jobId: id });
  assert.equal(withPlaceholder.code, 1);
  assert.equal(withPlaceholder.out[0], "REJECTED: the body still carries the placeholder `{{summary}}`: fill every section with this run's own facts");
  assert.match(withPlaceholder.out[1], /nothing was pushed and no pull request was opened/);

  const example = writeBody(t, "run-pr-example", BODY.replace("job 1", "job <number>"));
  const withExample = await runCli(env, ["run", "pr", "--body-file", example, "--title", "t"], { jobId: id });
  assert.match(withExample.out[0], /^REJECTED: the body still carries the placeholder `<number>`/);

  const noQa = writeBody(t, "run-pr-no-qa", BODY.replace("## QA", "### QA"));
  const missing = await runCli(env, ["run", "pr", "--body-file", noQa, "--title", "t"], { jobId: id });
  assert.equal(missing.code, 1);
  assert.equal(missing.out[0], "REJECTED: the body is missing ## QA");

  const swapped = writeBody(t, "run-pr-swapped", [BODY.split("## Summary")[1], "## Summary", "late"].join("\n"));
  const outOfOrder = await runCli(env, ["run", "pr", "--body-file", swapped, "--title", "t"], { jobId: id });
  assert.match(outOfOrder.out[0], /^REJECTED: `## Changes` comes before `## Summary`; the order is ## Summary, ## Changes, /);

  const fourth = writeBody(t, "run-pr-fourth", `${BODY}\n## Run\n\njob 1\n`);
  const withFourth = await runCli(env, ["run", "pr", "--body-file", fourth, "--title", "t"], { jobId: id });
  assert.equal(withFourth.out[0], "REJECTED: the body carries a fourth section `## Run`; the three sections are the whole body");

  const noProven = writeBody(t, "run-pr-no-proven", BODY.replace("Proven:", "Tested:"));
  const withoutProven = await runCli(env, ["run", "pr", "--body-file", noProven, "--title", "t"], { jobId: id });
  assert.equal(withoutProven.out[0], "REJECTED: `## QA` is missing its `Proven:` line");

  const bare = writeBody(t, "run-pr-bare", BODY.replace("job 1", "job #1"));
  const withBare = await runCli(env, ["run", "pr", "--body-file", bare, "--title", "t"], { jobId: id });
  assert.match(withBare.out[0], /^REJECTED: the body carries a bare `#1` outside a Fixes\/Closes line/);


  assert.deepEqual(remoteBranches(remote), ["main"]);
  assert.equal(git(["-C", worktree, "rev-parse", "--abbrev-ref", "HEAD"]).trim(), BRANCH);
  assert.deepEqual(ghCalls(env), []);
  assert.equal(readRunState({ project: "alpha", slug: SLUG, env }).outcome, undefined);
});

test("a worktree branch with no `<type>` to restore is published as the `<type>/<slug>` of the run, with the title of the body", async (t) => {
  const { env, id, remote } = makeRun(t, "run-pr-fallback", { branch: "worktree-login", type: "bug/error" });
  const body = writeBody(t, "run-pr-fallback-body", `# fix(auth): the google login\n\n${BODY}`);

  const { code, out } = await runCli(env, ["run", "pr", "--body-file", body], { jobId: id });

  assert.equal(code, 0);
  assert.equal(out[0], "BRANCH: fix/login-google (renamed from worktree-login)");
  assert.deepEqual(remoteBranches(remote), ["fix/login-google", "main"]);
  assert.deepEqual(ghCalls(env)[0].slice(0, 3), ["pr", "create", "--title"]);
  assert.equal(ghCalls(env)[0][3], "fix(auth): the google login");
});

test("`run pr` refuses a body it cannot read, a body with no title to take and a run whose gh cannot answer", async (t) => {
  const { env, id, remote } = makeRun(t, "run-pr-refusals");

  const noFlag = await runCli(env, ["run", "pr"], { jobId: id });
  assert.equal(noFlag.code, 1);
  assert.match(noFlag.errText, /`--body-file <path>` is required/);

  const absent = await runCli(env, ["run", "pr", "--body-file", join(makeDir(t, "run-pr-absent"), "nope.md")], { jobId: id });
  assert.match(absent.errText, /could not read `--body-file` .*nope\.md/);

  const body = writeBody(t, "run-pr-no-title", BODY);
  const noTitle = await runCli(env, ["run", "pr", "--body-file", body], { jobId: id });
  assert.equal(noTitle.code, 1);
  assert.match(noTitle.errText, /pass `--title <text>`: the body carries no `# <title>` line/);

  const refusing = { ...env, NIGHTSHIFT_FAKE_GH_PR_URL: "" };
  const failed = await runCli(refusing, ["run", "pr", "--body-file", body, "--title", "feat: x"], { jobId: id });
  assert.equal(failed.code, 1);
  assert.match(failed.errText, /`feat\/login-google` is pushed, but gh could not open the pull request: fake gh: NIGHTSHIFT_FAKE_GH_PR_URL/);
  assert.deepEqual(remoteBranches(remote), ["feat/login-google", "main"]);
  assert.equal(readRunState({ project: "alpha", slug: SLUG, env }).outcome, undefined);
});
