import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { run } from "../src/cli/index.mjs";
import { runDir } from "../src/config/paths.mjs";
import { openDb } from "../src/memory/db.mjs";
import { addJob } from "../src/memory/jobs.mjs";
import { ghPrUrlOfBranch } from "../src/host/gh.mjs";
import { classifyJobResult } from "../src/queue/classify.mjs";
import { provenEditedPrUrls } from "../src/queue/edit-proof.mjs";
import { readRunState } from "../src/queue/resume.mjs";
import { recordOutcome, recordRunFields } from "../src/queue/run-state.mjs";
import { codeChangePublishedEvent, resultEvent, systemInitEvent, toNdjson } from "../test-support/streams.mjs";
import { initGitRepo } from "../test-support/git.mjs";
import { FAKE_GH_PR_URL, isolatedHostVars } from "../test-support/host.mjs";
import { ensureProject, makeDir, makeHome, registerCheckout } from "../test-support/memory.mjs";

const SLUG = "add-slugify";
const BRANCH = `worktree-${SLUG}`;
const MESSAGE = "feat(text): add slugify\n\nTests: npm test\n";
const BODY = [
  "## Report",
  "",
  "text had no slug helper.",
  "",
  "## Cause",
  "",
  "it was never written.",
  "",
  "## Changes",
  "",
  "- src/slug.mjs",
  "",
  "## QA",
  "",
  "### Automated",
  "- `npm test` — PASSED ✅",
  "",
  "Not tested: nothing else; the helper is pure.",
  "",
].join("\n");

// A git environment that depends on nothing of the machine.
function gitVars() {
  return {
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_AUTHOR_NAME: "nightqueue",
    GIT_AUTHOR_EMAIL: "nightqueue@example.invalid",
    GIT_COMMITTER_NAME: "nightqueue",
    GIT_COMMITTER_EMAIL: "nightqueue@example.invalid",
  };
}

// Runs git in the test's own hermetic environment.
function git(args) {
  return execFileSync("git", args, { encoding: "utf8", env: { ...process.env, ...gitVars() } });
}

// A bare remote, its checkout and the worktree of the run, where the coder left one new file listed in 04-implementation.md.
function makeRun(t, name, { listed = ["src/slug.mjs"] } = {}) {
  const remote = join(makeDir(t, `${name}-origin`), "origin.git");
  git(["-c", "init.defaultBranch=main", "init", "--bare", "-q", remote]);
  const checkout = initGitRepo(makeDir(t, `${name}-checkout`));
  git(["-C", checkout, "remote", "add", "origin", remote]);
  git(["-C", checkout, "push", "-q", "-u", "origin", "main"]);
  const worktree = join(makeDir(t, `${name}-worktrees`), BRANCH);
  git(["-C", checkout, "worktree", "add", "-q", "-b", BRANCH, worktree, "main"]);
  for (const file of listed) {
    mkdirSync(join(worktree, file, ".."), { recursive: true });
    writeFileSync(join(worktree, file), "export const slugify = (text) => text;\n");
  }
  const env = { ...makeHome(t, name), ...isolatedHostVars(makeDir(t, `${name}-host`)), ...gitVars() };
  registerCheckout(env, { path: checkout, name: "alpha" });
  const id = addJob({ projectId: ensureProject(env, "alpha"), prompt: "add slugify" }, env).id;
  openDb(env).prepare("UPDATE jobs SET slug = ? WHERE id = ?").run(SLUG, id);
  const projectId = ensureProject(env, "alpha");
  recordRunFields({ projectId, slug: SLUG, fields: { worktree, type: "feature/refactor" }, env });
  const dir = runDir(projectId, SLUG, env);
  mkdirSync(join(dir, "evidence"), { recursive: true });
  writeFileSync(join(dir, "evidence", "automated-verification.md"), "## Verification: PASSED\n");
  writeFileSync(join(dir, "04-implementation.md"), ["## Modified files", ...listed.map((file) => join(worktree, file)), ""].join("\n"));
  writeFileSync(join(dir, "commit-message.txt"), MESSAGE);
  writeFileSync(join(dir, "pr-body.md"), BODY);
  return { env, id, remote, worktree, dir, projectId };
}

// Runs the CLI in this process as the job of the run.
async function runCli(env, id, argv) {
  const out = [];
  const err = [];
  const code = await run(argv, {
    env: { ...env, NIGHTQUEUE_JOB_ID: String(id) },
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    stdout: { write: () => {} },
  });
  return { code, out, err, text: out.join("\n"), errText: err.join("\n") };
}

// The `run publish` arguments of a run, plus any extra flag.
function publishArgs(dir, extra = []) {
  return ["run", "publish", "--message-file", join(dir, "commit-message.txt"), "--body-file", join(dir, "pr-body.md"), ...extra];
}

// How many commits the worktree's branch holds.
function commitCount(worktree) {
  return Number(git(["-C", worktree, "rev-list", "--count", "HEAD"]).trim());
}

// The calls the fake gh received.
function ghCalls(env) {
  const log = env.NIGHTQUEUE_FAKE_GH_LOG;
  return existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : [];
}

test("`run publish` commits the list, renames the branch, pushes it, opens the pull request and records the run as done", async (t) => {
  const { env, id, remote, worktree, projectId } = makeRun(t, "publish-happy");
  const before = commitCount(worktree);

  const { code, out, errText } = await runCli(env, id, publishArgs(runDir(projectId, SLUG, env)));

  assert.equal(code, 0, `${out.join("\n")}\n${errText}`);
  assert.match(out[0], /^CONVENTION: /);
  assert.match(out[1], /^COMMITTED: [0-9a-f]+ \(1 files\)$/);
  assert.deepEqual(out.slice(2), [`BRANCH: feat/${SLUG} (renamed from ${BRANCH})`, `PR: ${FAKE_GH_PR_URL}`, `WORKTREE: ${worktree}`]);
  assert.equal(commitCount(worktree), before + 1);
  assert.equal(git(["-C", worktree, "log", "-1", "--format=%s"]).trim(), "feat(text): add slugify");
  assert.ok(git(["-C", remote, "for-each-ref", "--format=%(refname:short)", "refs/heads"]).includes(`feat/${SLUG}`));
  const state = readRunState({ projectId, slug: SLUG, env });
  assert.deepEqual({ status: state.outcome.status, prUrl: state.outcome.prUrl }, { status: "done", prUrl: FAKE_GH_PR_URL });
  const commit = state.phases.filter((entry) => entry.phase === "commit");
  assert.deepEqual(commit.map((entry) => [entry.verdict, entry.by]), [["PR opened", "runtime"]], "the commit phase was not recorded by the runtime");
  assert.deepEqual(JSON.parse(ghCalls(env)[0]).slice(0, 4), ["pr", "create", "--title", "feat(text): add slugify"], "the title is not the commit subject");
});

test("an invalid body commits nothing and pushes nothing", async (t) => {
  const { env, id, worktree, dir } = makeRun(t, "publish-bad-body");
  writeFileSync(join(dir, "pr-body.md"), BODY.replace("## Cause", "## Causes"));
  const before = commitCount(worktree);

  const { code, out } = await runCli(env, id, publishArgs(dir));

  assert.equal(code, 1);
  assert.ok(out.some((line) => line.startsWith("MISSING: ") || line.startsWith("REJECTED: ")), out.join("\n"));
  assert.equal(out.at(-1), "nothing was committed or pushed: fix the problems above and call `nightqueue run publish` again");
  assert.equal(commitCount(worktree), before, "an invalid body still committed");
  assert.deepEqual(ghCalls(env), []);
});

test("a message with a `Co-Authored-By:` trailer is rejected before anything is committed or pushed", async (t) => {
  const { env, id, worktree, dir } = makeRun(t, "publish-bad-message");
  writeFileSync(join(dir, "commit-message.txt"), `${MESSAGE}\nCo-Authored-By: Someone <someone@example.invalid>\n`);
  const before = commitCount(worktree);

  const { code, out } = await runCli(env, id, publishArgs(dir));

  assert.equal(code, 1);
  assert.deepEqual(out, [
    "REJECTED: commit message — line 5 is a `Co-Authored-By:` trailer, which a pipeline commit never carries",
    "nothing was committed or pushed: fix the problems above and call `nightqueue run publish` again",
  ]);
  assert.equal(commitCount(worktree), before, "a rejected message still committed");
  assert.deepEqual(ghCalls(env), []);
});

test("a retry after the commit already happened reuses it instead of committing again", async (t) => {
  const { env, id, worktree, dir } = makeRun(t, "publish-retry");
  const committed = await runCli(env, id, ["run", "commit", "--message-file", join(dir, "commit-message.txt")]);
  assert.equal(committed.code, 0, committed.text);
  const before = commitCount(worktree);

  const { code, out } = await runCli(env, id, publishArgs(dir));

  assert.equal(code, 0, out.join("\n"));
  assert.match(out[1], /^COMMITTED: [0-9a-f]+ \(already committed\)$/);
  assert.equal(commitCount(worktree), before, "the retry committed a second time");
  assert.equal(out.at(-2), `PR: ${FAKE_GH_PR_URL}`);
});

test("a refused path is refused exactly as `run commit` refuses it, and nothing is committed", async (t) => {
  const { env, id, worktree, dir } = makeRun(t, "publish-refused", { listed: ["src/slug.mjs", ".claude/settings.json"] });
  const before = commitCount(worktree);

  const commit = await runCli(env, id, ["run", "commit", "--message-file", join(dir, "commit-message.txt")]);
  const publish = await runCli(env, id, publishArgs(dir));

  assert.equal(commit.code, 1);
  assert.equal(publish.code, 1);
  assert.deepEqual(publish.out.slice(0, 2), commit.out);
  assert.equal(commitCount(worktree), before);
});

test("a scratch file in the list is rejected before the commit, naming the way out", async (t) => {
  const { env, id, worktree, dir } = makeRun(t, "publish-scratch", { listed: ["src/slug.mjs", "test/slug.poc.test.mjs"] });
  const before = commitCount(worktree);

  const { code, out } = await runCli(env, id, publishArgs(dir));

  assert.equal(code, 1);
  assert.ok(out.some((line) => line.startsWith("REJECTED: scratch file test/slug.poc.test.mjs")), out.join("\n"));
  assert.equal(commitCount(worktree), before);
  assert.deepEqual(ghCalls(env), []);
});

test("`run publish` requires the message and the body files", async (t) => {
  const { env, id, dir } = makeRun(t, "publish-usage");
  const noBody = await runCli(env, id, ["run", "publish", "--message-file", join(dir, "commit-message.txt")]);
  assert.equal(noBody.code, 1);
  assert.match(noBody.errText, /`--body-file <path>` is required/);
  const noMessage = await runCli(env, id, ["run", "publish", "--body-file", join(dir, "pr-body.md")]);
  assert.equal(noMessage.code, 1);
  assert.match(noMessage.errText, /`--message-file <path>` is required/);
});

const EXISTING_PR_LIST = JSON.stringify([{ url: FAKE_GH_PR_URL, headRefName: `feat/${SLUG}` }]);

test("`run publish` onto a branch whose pull request exists edits it, records done with its URL and the classifier ends the run done", async (t) => {
  const { env, id, projectId } = makeRun(t, "publish-existing");
  const existing = { ...env, NIGHTQUEUE_FAKE_GH_PR_EXISTS: "1", NIGHTQUEUE_FAKE_GH_PR_LIST: EXISTING_PR_LIST };

  const { code, out, errText } = await runCli(existing, id, publishArgs(runDir(projectId, SLUG, env)));

  assert.equal(code, 0, `${out.join("\n")}\n${errText}`);
  assert.ok(out.includes(`PR: ${FAKE_GH_PR_URL}`), out.join("\n"));
  const calls = ghCalls(env).map((line) => JSON.parse(line));
  const edit = calls.find((call) => call[0] === "pr" && call[1] === "edit");
  assert.deepEqual(edit.slice(0, 3), ["pr", "edit", FAKE_GH_PR_URL]);
  assert.equal(edit[3], "--body-file");
  recordOutcome({ projectId, slug: SLUG, status: "done", env });
  const state = readRunState({ projectId, slug: SLUG, env });
  assert.deepEqual({ status: state.outcome.status, prUrl: state.outcome.prUrl }, { status: "done", prUrl: FAKE_GH_PR_URL });

  const log = toNdjson([systemInitEvent(), codeChangePublishedEvent({ url: FAKE_GH_PR_URL, repo: "octocat/hello-world", identifier: "7", action: "edited" }), resultEvent({ text: "PR #7 description replaced" })]);
  const outcome = classifyJobResult({ log, exitCode: 0, state, runOutcome: "done" });
  assert.deepEqual({ status: outcome.status, prUrl: outcome.prUrl }, { status: "done", prUrl: FAKE_GH_PR_URL });
});

test("`run publish` never edits a pull request whose head branch is not the run's own", async (t) => {
  const { env, id, projectId } = makeRun(t, "publish-foreign-head");
  const foreign = JSON.stringify([{ url: FAKE_GH_PR_URL, headRefName: "feat/other" }]);
  const existing = { ...env, NIGHTQUEUE_FAKE_GH_PR_EXISTS: "1", NIGHTQUEUE_FAKE_GH_PR_LIST: foreign };

  const { code, errText } = await runCli(existing, id, publishArgs(runDir(projectId, SLUG, env)));

  assert.equal(code, 1);
  assert.match(errText, /no pull request with that head branch was found/);
  assert.equal(ghCalls(env).some((line) => JSON.parse(line)[1] === "edit"), false);
  assert.equal(readRunState({ projectId, slug: SLUG, env }).outcome, undefined);
});

test("the classifier ignores an edited event that no recorded pull request vouches for", () => {
  const log = toNdjson([systemInitEvent(), codeChangePublishedEvent({ action: "edited" }), resultEvent({ text: "PR description replaced" })]);
  const unrecorded = classifyJobResult({ log, exitCode: 0, state: { outcome: { status: "done" } }, runOutcome: "done" });
  assert.equal(unrecorded.status, "failed");
  assert.equal(unrecorded.prUrl, null);
  const otherRecorded = { outcome: { status: "done", prUrl: "https://github.com/acme/api/pull/43" } };
  const foreign = classifyJobResult({ log, exitCode: 0, state: otherRecorded, runOutcome: "done" });
  assert.equal(foreign.prUrl, "https://github.com/acme/api/pull/43", "the edited event of another PR never replaces the recorded one");
});

const J230_LOG = toNdjson([systemInitEvent(), codeChangePublishedEvent({ url: FAKE_GH_PR_URL, repo: "octocat/hello-world", identifier: "103", action: "edited" }), resultEvent({ text: "PR #103" })]);
const J230_STATE = { branch: `feat/${SLUG}`, type: "feat", slug: SLUG, outcome: { status: "done" } };

async function classifyWithHead(headRefName, { ok = true, throws = false } = {}) {
  const detailImpl = async () => {
    if (throws) throw new Error("gh is not installed");
    return { ok, headRefName };
  };
  const provenEdits = await provenEditedPrUrls(J230_LOG, { state: J230_STATE, detailImpl });
  return classifyJobResult({ log: J230_LOG, exitCode: 0, state: J230_STATE, runOutcome: "done", provenEdits });
}

test("an edited event with no recorded URL ends done when gh proves the PR heads the job's own branch", async () => {
  const outcome = await classifyWithHead(`feat/${SLUG}`);
  assert.deepEqual({ status: outcome.status, prUrl: outcome.prUrl }, { status: "done", prUrl: FAKE_GH_PR_URL });
});

test("an edited event does not count when gh names another head branch, fails or is missing", async () => {
  for (const outcome of [await classifyWithHead("feat/other"), await classifyWithHead(`feat/${SLUG}`, { ok: false }), await classifyWithHead(`feat/${SLUG}`, { throws: true })]) {
    assert.equal(outcome.status, "failed");
    assert.equal(outcome.prUrl, null);
  }
});

test("the existing-PR lookup prefers the open pull request over an older merged one of the same branch", () => {
  const list = JSON.stringify([
    { url: "https://github.com/octocat/hello-world/pull/1", headRefName: "feat/x", state: "MERGED" },
    { url: "https://github.com/octocat/hello-world/pull/2", headRefName: "feat/x", state: "OPEN" },
  ]);
  const spawnSyncImpl = () => ({ status: 0, stdout: list, stderr: "" });
  assert.equal(ghPrUrlOfBranch({ head: "feat/x", spawnSyncImpl }).url, "https://github.com/octocat/hello-world/pull/2");
});
