import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { run } from "../src/cli/index.mjs";
import { runDir } from "../src/config/paths.mjs";
import { addProject } from "../src/config/projects.mjs";
import { loadConfig, saveConfig } from "../src/config/store.mjs";
import { ghBin } from "../src/host/gh.mjs";
import { openDb } from "../src/memory/db.mjs";
import { addJob } from "../src/memory/jobs.mjs";
import { linkRoadmapItemJob, saveRoadmapItem } from "../src/memory/roadmap.mjs";
import { readRunState } from "../src/queue/resume.mjs";
import { recordRunFields } from "../src/queue/run-state.mjs";
import { initGitRepo } from "../test-support/git.mjs";
import { FAKE_GH_PR_URL, isolatedHostVars } from "../test-support/host.mjs";
import { makeDir, makeHome } from "../test-support/memory.mjs";

const SLUG = "login-google";
const BRANCH = "worktree-feat+login-google";

const REPORT = "logging in with google failed for every user.";

const AUTOMATED_ROW = "| Automated | `npm test` | PASSED |";

const BODY = [
  "## Report",
  "",
  REPORT,
  "",
  "## Cause",
  "",
  "the callback dropped the state parameter.",
  "",
  "## Changes",
  "",
  "- one file",
  "",
  "## QA",
  "",
  "| Method | Executed | Result |",
  "| --- | --- | --- |",
  AUTOMATED_ROW,
  "",
  "Not tested: the real google consent screen; low risk, the callback is covered by the suite.",
  "",
  "Opened by nightshift · run login-google · job 1",
  "",
].join("\n");

// A fictional mobile-app CLAUDE.md excerpt in the shape of a real one: the repository template of the tests.
const ACME_CLAUDE_MD = readFileSync(new URL("./fixtures/acme-mobile-app-claude-md.md", import.meta.url), "utf8");

// A body that follows the acme-mobile-app template, filled.
const ACME_BODY = [
  "## Summary",
  "- login with google works again",
  "",
  "## Changes",
  "- src/auth.ts: keeps the state parameter",
  "",
  "## Test plan",
  "- [x] iOS físico — login com google",
  "",
  "## OTA-able?",
  "- [x] Sim (só JS/TS, sem mudança nativa) — pode entrar num OTA",
  "",
].join("\n");

// The body an older plugin wrote, before the nightshift template had four sections.
const OLD_BODY = "## Summary\n\nthe run did the thing.\n\n## Changes\n\n- one file\n\n## QA\n\nVerdict: APPROVED\n\nProven:\n- the run did the thing\n";

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
  const evidence = join(runDir("alpha", SLUG, env), "evidence");
  mkdirSync(evidence, { recursive: true });
  writeFileSync(join(evidence, "automated-verification.md"), "## Verification: PASSED\n\nnpm test: 12 passed\n");
  assertFakeGh(env);
  return { ...repo, env, id, evidence };
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

// The violation lines a rejected body printed, between the template lines and the closing `nothing was pushed` line.
async function rejectedProblems(t, { env, id, name, body }) {
  const result = await runCli(env, ["run", "pr", "--body-file", writeBody(t, name, body), "--title", "t"], { jobId: id });
  assert.equal(result.code, 1, result.text);
  assert.match(result.out.at(-1), /nothing was pushed and no pull request was opened/);
  return result.out.slice(2, -1);
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
  const body = writeBody(t, "run-pr-happy-body", BODY.replace(REPORT, `${REPORT}\nFixes #7`));

  const { code, out, err } = await runCli(env, ["run", "pr", "--body-file", body, "--title", "feat(auth): log in with google"], { jobId: id });

  assert.equal(code, 0);
  assert.deepEqual(err, []);
  assert.deepEqual(out, [
    "TEMPLATE: nightshift (fallback)",
    "HEADINGS: ## Report · ## Cause · ## Changes · ## QA",
    `BRANCH: feat/login-google (renamed from ${BRANCH})`,
    `PR: ${FAKE_GH_PR_URL}`,
    `WORKTREE: ${worktree}`,
  ]);
  assert.equal(git(["-C", worktree, "rev-parse", "--abbrev-ref", "HEAD"]).trim(), "feat/login-google");
  assert.deepEqual(remoteBranches(remote), ["feat/login-google", "main"]);
  assert.deepEqual(ghCalls(env), [
    ["pr", "create", "--title", "feat(auth): log in with google", "--body-file", body, "--head", "feat/login-google"],
  ]);
  assert.deepEqual(
    { status: readRunState({ project: "alpha", slug: SLUG, env }).outcome.status, prUrl: readRunState({ project: "alpha", slug: SLUG, env }).outcome.prUrl },
    { status: "done", prUrl: FAKE_GH_PR_URL },
  );
  assert.equal(readRunState({ project: "alpha", slug: SLUG, env }).branch, "feat/login-google", "the run kept the name its branch no longer carries");
  assert.equal(readRunState({ project: "alpha", slug: SLUG, env }).prTemplate.source, "nightshift");
  assert.equal(existsSync(worktree), true);
});

test("`run pr` of a job queued from a roadmap item opens the pull request with a body ending in its Roadmap line", async (t) => {
  const { env, id } = makeRun(t, "run-pr-roadmap");
  const item = saveRoadmapItem({ type: "feature", project: "alpha", title: "log in with google" }, env);
  assert.equal(linkRoadmapItemJob(item.id, id, env), true);
  const body = writeBody(t, "run-pr-roadmap-body", BODY);

  const { code } = await runCli(env, ["run", "pr", "--body-file", body, "--title", "feat(auth): log in with google"], { jobId: id });

  assert.equal(code, 0);
  const published = join(runDir("alpha", SLUG, env), "pr-body.roadmap.md");
  assert.deepEqual(ghCalls(env), [
    ["pr", "create", "--title", "feat(auth): log in with google", "--body-file", published, "--head", "feat/login-google"],
  ]);
  assert.equal(readFileSync(published, "utf8"), `${BODY.trimEnd()}\n\nRoadmap: alpha#${item.id}\n`);
  assert.equal(readFileSync(body, "utf8"), BODY, "the agent's body file was edited");
});

test("a repository template in the worktree is the one the body follows: its headings in its order, and no nightshift heading it lacks", async (t) => {
  const { env, id, remote, worktree } = makeRun(t, "run-pr-repo-template");
  writeFileSync(join(worktree, "CLAUDE.md"), ACME_CLAUDE_MD);
  const problems = (name, body) => rejectedProblems(t, { env, id, name, body });

  const nightshiftShaped = await problems("run-pr-repo-nightshift", BODY);
  assert.ok(nightshiftShaped.includes("REJECTED: the body is missing `## Summary` of the repository template (CLAUDE.md § Git & PR workflow)"), nightshiftShaped.join("\n"));
  assert.ok(
    nightshiftShaped.includes("REJECTED: the body carries the nightshift heading `## Report`, which the repository template (CLAUDE.md § Git & PR workflow) does not have"),
    nightshiftShaped.join("\n"),
  );
  assert.equal(nightshiftShaped.some((line) => line.includes("`## Changes`")), false, "`## Changes` is the repository template's own heading");

  const swapped = ACME_BODY.replace("## Changes", "## Swap").replace("## Test plan", "## Changes").replace("## Swap", "## Test plan");
  assert.deepEqual(await problems("run-pr-repo-swapped", swapped), [
    "REJECTED: `## Test plan` comes before `## Changes`; the repository template (CLAUDE.md § Git & PR workflow) orders them ## Summary, ## Changes, ## Test plan, ## OTA-able?",
  ]);
  assert.deepEqual(remoteBranches(remote), ["main"]);

  const { code, out } = await runCli(env, ["run", "pr", "--body-file", writeBody(t, "run-pr-repo-body", ACME_BODY), "--title", "fix(auth): google login"], { jobId: id });
  assert.equal(code, 0, out.join("\n"));
  assert.deepEqual(out.slice(0, 2), ["TEMPLATE: repo (CLAUDE.md § Git & PR workflow)", "HEADINGS: ## Summary · ## Changes · ## Test plan · ## OTA-able?"]);
  assert.equal(ghCalls(env).length, 1);
  assert.equal(readRunState({ project: "alpha", slug: SLUG, env }).outcome.status, "done");
});

test("`run pr --template` prints and records the template in effect, reads no body and pushes nothing", async (t) => {
  const repo = makeRun(t, "run-pr-template-repo");
  writeFileSync(join(repo.worktree, "CLAUDE.md"), ACME_CLAUDE_MD);
  const asked = await runCli(repo.env, ["run", "pr", "--template"], { jobId: repo.id });
  assert.equal(asked.code, 0);
  assert.deepEqual(asked.out, ["TEMPLATE: repo (CLAUDE.md § Git & PR workflow)", "HEADINGS: ## Summary · ## Changes · ## Test plan · ## OTA-able?"]);
  assert.deepEqual(asked.err, []);
  const { at, ...recorded } = readRunState({ project: "alpha", slug: SLUG, env: repo.env }).prTemplate;
  assert.deepEqual(recorded, { source: "repo", path: "CLAUDE.md", headings: ["## Summary", "## Changes", "## Test plan", "## OTA-able?"] });
  assert.equal(typeof at, "string");
  assert.deepEqual(ghCalls(repo.env), []);
  assert.deepEqual(remoteBranches(repo.remote), ["main"]);
  assert.equal(readRunState({ project: "alpha", slug: SLUG, env: repo.env }).outcome, undefined);

  const fallback = makeRun(t, "run-pr-template-fallback");
  const plain = await runCli(fallback.env, ["run", "pr", "--template"], { jobId: fallback.id });
  assert.deepEqual(plain.out, ["TEMPLATE: nightshift (fallback)", "HEADINGS: ## Report · ## Cause · ## Changes · ## QA"]);
  const state = readRunState({ project: "alpha", slug: SLUG, env: fallback.env }).prTemplate;
  assert.equal(state.source, "nightshift");
  assert.equal("path" in state, false);

  const both = await runCli(fallback.env, ["run", "pr", "--template", "--body-file", writeBody(t, "run-pr-template-both", BODY)], { jobId: fallback.id });
  assert.equal(both.code, 1);
  assert.match(both.errText, /`--template` only prints the template in effect; call it without `--body-file`/);
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
  const problems = (name, body) => rejectedProblems(t, { env, id, name, body });

  const placeholder = writeBody(t, "run-pr-placeholder", BODY.replace(REPORT, "{{summary}}"));
  const withPlaceholder = await runCli(env, ["run", "pr", "--body-file", placeholder, "--title", "t"], { jobId: id });
  assert.equal(withPlaceholder.code, 1);
  assert.equal(withPlaceholder.out[2], "REJECTED: the body still carries the placeholder `{{summary}}`: fill every section with this run's own facts");
  assert.match(withPlaceholder.out[3], /nothing was pushed and no pull request was opened/);

  assert.match((await problems("run-pr-example", BODY.replace("job 1", "job <number>")))[0], /^REJECTED: the body still carries the placeholder `<number>`/);
  assert.deepEqual(await problems("run-pr-no-qa", BODY.replace("## QA", "### QA")), ["MISSING: ## QA"]);

  const swapped = BODY.replace("## Report", "## Swap").replace("## Cause", "## Report").replace("## Swap", "## Cause");
  assert.deepEqual(await problems("run-pr-swapped", swapped), [
    "MISSING: ## Report in its place: the order is ## Report, ## Cause, ## Changes, ## QA",
  ]);
  assert.deepEqual(await problems("run-pr-fifth", `${BODY}\n## Run\n\njob 1\n`), [
    "REJECTED: the body carries a fifth section `## Run`; the four sections are the whole body",
  ]);
  assert.deepEqual(await problems("run-pr-no-not-tested", BODY.replace("Not tested:", "Untested:")), ["MISSING: Not tested: line after the QA table"]);
  assert.deepEqual(await problems("run-pr-header", BODY.replace("| Method | Executed | Result |", "| Method | Result |")), [
    "MISSING: QA table header | Method | Executed | Result |",
  ]);
  assert.deepEqual(await problems("run-pr-no-row", BODY.replace(`${AUTOMATED_ROW}\n`, "")), ["MISSING: a QA table row for a method that ran"]);
  const notApplicable = await problems("run-pr-na", BODY.replace(AUTOMATED_ROW, `${AUTOMATED_ROW}\n| Browser | N/A | N/A |`));
  assert.ok(notApplicable.includes("REJECTED: QA row Browser is marked N/A: a method that did not run has no row"), notApplicable.join("\n"));
  assert.deepEqual(await problems("run-pr-unknown", BODY.replace(AUTOMATED_ROW, `${AUTOMATED_ROW}\n| Unit tests | \`npm test\` | PASSED |`)), [
    "MISSING: a known method in QA row Unit tests (Automated, API, Browser, Android / iOS emulator or device)",
  ]);
  assert.deepEqual(await problems("run-pr-old-shape", OLD_BODY), [
    "MISSING: ## Report",
    "MISSING: ## Cause",
    "REJECTED: the body carries a fifth section `## Summary`; the four sections are the whole body",
    "MISSING: QA table header | Method | Executed | Result |",
    "MISSING: Not tested: line after the QA table",
  ]);
  assert.match((await problems("run-pr-bare", BODY.replace("job 1", "job #1")))[0], /^REJECTED: the body carries a bare `#1` outside a Fixes\/Closes line/);

  assert.deepEqual(remoteBranches(remote), ["main"]);
  assert.equal(git(["-C", worktree, "rev-parse", "--abbrev-ref", "HEAD"]).trim(), BRANCH);
  assert.deepEqual(ghCalls(env), []);
  assert.equal(readRunState({ project: "alpha", slug: SLUG, env }).outcome, undefined);
});

test("a QA row whose method left no non-empty `<method>-*` file under the run's evidence is MISSING, and nothing is pushed", async (t) => {
  const { env, id, remote, evidence } = makeRun(t, "run-pr-evidence");
  const problems = (name, body) => rejectedProblems(t, { env, id, name, body });
  const apiRow = "| API | `POST /auth/google/callback` | 200, session cookie set |";

  assert.deepEqual(await problems("run-pr-api", BODY.replace(AUTOMATED_ROW, `${AUTOMATED_ROW}\n${apiRow}`)), ["MISSING: evidence for QA row API"]);

  rmSync(join(evidence, "automated-verification.md"));
  writeFileSync(join(evidence, "automated-empty.log"), "");
  mkdirSync(join(evidence, "automated-dir"));
  assert.deepEqual(await problems("run-pr-no-evidence", BODY), ["MISSING: evidence for QA row Automated"]);

  assert.deepEqual(remoteBranches(remote), ["main"]);
  assert.deepEqual(ghCalls(env), []);
  assert.equal(readRunState({ project: "alpha", slug: SLUG, env }).outcome, undefined);
});

test("a worktree branch with no `<type>` to restore is published as the `<type>/<slug>` of the run, with the title of the body", async (t) => {
  const { env, id, remote } = makeRun(t, "run-pr-fallback", { branch: "worktree-login", type: "bug/error" });
  const body = writeBody(t, "run-pr-fallback-body", `# fix(auth): the google login\n\n${BODY}`);

  const { code, out } = await runCli(env, ["run", "pr", "--body-file", body], { jobId: id });

  assert.equal(code, 0);
  assert.equal(out[2], "BRANCH: fix/login-google (renamed from worktree-login)");
  assert.deepEqual(remoteBranches(remote), ["fix/login-google", "main"]);
  assert.deepEqual(ghCalls(env)[0].slice(0, 3), ["pr", "create", "--title"]);
  assert.equal(ghCalls(env)[0][3], "fix(auth): the google login");
});

test("a published branch the run cannot record is reported on stderr, never fatal: the pull request is open", async (t) => {
  const { env, id } = makeRun(t, "run-pr-unrecorded");
  const body = writeBody(t, "run-pr-unrecorded-body", BODY);
  const dir = runDir("alpha", SLUG, env);
  chmodSync(dir, 0o555);
  const { code, out, errText } = await runCli(env, ["run", "pr", "--body-file", body, "--title", "feat: x"], { jobId: id }).finally(() => chmodSync(dir, 0o755));

  assert.equal(code, 0, errText);
  assert.ok(out.includes(`PR: ${FAKE_GH_PR_URL}`), out.join("\n"));
  assert.match(errText, /nightshift: the published branch was not recorded on the run: /);
  assert.equal(readRunState({ project: "alpha", slug: SLUG, env }).branch, undefined, "setup: the run directory was still writable");
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
