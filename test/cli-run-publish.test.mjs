import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { run } from "../src/cli/index.mjs";
import { runDir } from "../src/config/paths.mjs";
import { openDb } from "../src/memory/db.mjs";
import { addJob } from "../src/memory/jobs.mjs";
import { ghPrUrlOfBranch } from "../src/host/gh.mjs";
import { classifyJobResult } from "../src/queue/classify.mjs";
import { provenEditedPrUrls } from "../src/queue/edit-proof.mjs";
import { listedFiles } from "../src/queue/file-list.mjs";
import { readRunState } from "../src/queue/resume.mjs";
import { recordOutcome, recordRunFields, recordWip } from "../src/queue/run-state.mjs";
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

test("a final name another local branch already carries moves the rename to its next free `-<n>`, leaving that branch alone", async (t) => {
  const { env, id, remote, worktree, projectId } = makeRun(t, "publish-name-taken");
  git(["-C", worktree, "branch", `feat/${SLUG}`, "main"]);
  git(["-C", worktree, "branch", `feat/${SLUG}-2`, "main"]);
  const left = git(["-C", worktree, "rev-parse", `feat/${SLUG}`]);

  const { code, out, errText } = await runCli(env, id, publishArgs(runDir(projectId, SLUG, env)));

  assert.equal(code, 0, `${out.join("\n")}\n${errText}`);
  assert.ok(out.includes(`BRANCH: feat/${SLUG}-3 (renamed from ${BRANCH})`), out.join("\n"));
  assert.equal(git(["-C", worktree, "rev-parse", `feat/${SLUG}`]), left, "the branch that carried the name was touched");
  assert.ok(git(["-C", remote, "for-each-ref", "--format=%(refname:short)", "refs/heads"]).split("\n").includes(`feat/${SLUG}-3`));
  assert.equal(readRunState({ projectId, slug: SLUG, env }).branch, `feat/${SLUG}-3`);
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

// Commits one unlisted file on the run's branch with a wip subject, the shape of a terminated attempt's wip commit.
function commitWipShaped(worktree) {
  writeFileSync(join(worktree, "notes.txt"), "earlier attempt\n");
  git(["-C", worktree, "add", "notes.txt"]);
  git(["-C", worktree, "-c", "commit.gpgsign=false", "commit", "-q", "--no-verify", "-m", `wip(${SLUG}): terminated at qa — why`]);
  return git(["-C", worktree, "rev-parse", "HEAD"]).trim();
}

const WIP_REF = `refs/nightqueue/wip/${SLUG}`;

// Commits files on the run's branch as the runtime's own wip commit, with its ref.
function commitOwnWip(worktree, files = { "notes.txt": "earlier attempt\n" }, slug = SLUG) {
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(join(worktree, path, ".."), { recursive: true });
    writeFileSync(join(worktree, path), body);
  }
  git(["-C", worktree, "add", "-f", "--", ...Object.keys(files)]);
  git(["-C", worktree, "-c", "commit.gpgsign=false", "commit", "-q", "--no-verify", "-m", `wip(${slug}): terminated at qa — why`]);
  const commit = git(["-C", worktree, "rev-parse", "HEAD"]).trim();
  git(["-C", worktree, "update-ref", `refs/nightqueue/wip/${slug}`, commit]);
  return commit;
}

// The paths HEAD changed, sorted.
function headFiles(worktree) {
  return git(["-C", worktree, "show", "--name-only", "--format=", "HEAD"]).split("\n").filter(Boolean).sort();
}

// How many commits the branch adds to `main`.
function aheadOfMain(worktree) {
  return Number(git(["-C", worktree, "rev-list", "--count", "main..HEAD"]).trim());
}

// The subjects every branch of the bare remote holds.
function pushedSubjects(remote) {
  return git(["-C", remote, "log", "--all", "--format=%s"]).split("\n").filter(Boolean);
}

// Asserts a refusal: exit 1, the given line, nothing new committed and nothing pushed.
async function assertRefused({ env, id, remote, worktree, dir }, line) {
  const before = commitCount(worktree);
  const { code, out } = await runCli(env, id, publishArgs(dir));
  assert.equal(code, 1, out.join("\n"));
  assert.ok(out.includes(line), out.join("\n"));
  assert.equal(out.at(-1), "nothing was committed or pushed: fix the problems above and call `nightqueue run publish` again");
  assert.equal(commitCount(worktree), before);
  assert.equal(git(["-C", remote, "for-each-ref", "refs/heads"]).includes(SLUG), false, "the wip branch was pushed");
  assert.deepEqual(ghCalls(env), []);
}

test("the run's own wip commit is folded: one delivery commit with the wip and the new paths, the ref on the old commit, and the wip never pushed", async (t) => {
  const { env, id, remote, worktree, dir, projectId } = makeRun(t, "publish-wip");
  const wip = commitOwnWip(worktree);

  const { code, out, errText } = await runCli(env, id, publishArgs(dir));

  assert.equal(code, 0, `${out.join("\n")}\n${errText}`);
  assert.equal(out[1], "FOLDED: 1 wip commits (1 files)");
  assert.match(out[2], /^COMMITTED: [0-9a-f]+ \(2 files\)$/);
  assert.equal(aheadOfMain(worktree), 1);
  assert.equal(git(["-C", worktree, "log", "-1", "--format=%s"]).trim(), "feat(text): add slugify");
  assert.deepEqual(headFiles(worktree), ["notes.txt", "src/slug.mjs"]);
  assert.equal(git(["-C", worktree, "rev-parse", WIP_REF]).trim(), wip);
  assert.equal(git(["-C", worktree, "branch", "--contains", wip, "--format=%(refname:short)"]).trim(), "");
  assert.equal(pushedSubjects(remote).some((subject) => subject.startsWith("wip(")), false);
  const state = readRunState({ projectId, slug: SLUG, env });
  assert.deepEqual([...state.outcome.files].sort(), headFiles(worktree));
});

test("two stacked own wips fold into one commit", async (t) => {
  const { env, id, worktree, dir } = makeRun(t, "publish-wip-stacked");
  const older = commitOwnWip(worktree, { "one.txt": "one\n" });
  const newer = commitOwnWip(worktree, { "two.txt": "two\n" });
  assert.notEqual(older, newer);

  const { code, out } = await runCli(env, id, publishArgs(dir));

  assert.equal(code, 0, out.join("\n"));
  assert.ok(out.includes("FOLDED: 2 wip commits (2 files)"), out.join("\n"));
  assert.equal(aheadOfMain(worktree), 1);
  assert.deepEqual(headFiles(worktree), ["one.txt", "src/slug.mjs", "two.txt"]);
});

test("a renamed run folds the wip its record names, under the old slug", async (t) => {
  const { env, id, worktree, dir, projectId } = makeRun(t, "publish-wip-renamed");
  const wip = commitOwnWip(worktree, undefined, "old-slug");
  recordWip({ projectId, slug: SLUG, wip: { status: "committed", commit: wip, ref: "refs/nightqueue/wip/old-slug" }, env });

  const { code, out } = await runCli(env, id, publishArgs(dir));

  assert.equal(code, 0, out.join("\n"));
  assert.equal(aheadOfMain(worktree), 1);
  assert.deepEqual(headFiles(worktree), ["notes.txt", "src/slug.mjs"]);
});

test("a path the attempt deleted and a path the wip deleted stay out of the delivery, and an unlisted path edited again ships as the worktree has it", async (t) => {
  const { env, id, worktree, dir } = makeRun(t, "publish-wip-worktree");
  writeFileSync(join(worktree, "gone-in-wip.txt"), "tracked\n");
  git(["-C", worktree, "add", "gone-in-wip.txt"]);
  git(["-C", worktree, "-c", "commit.gpgsign=false", "commit", "-q", "--no-verify", "-m", "chore: a tracked file"]);
  rmSync(join(worktree, "gone-in-wip.txt"));
  git(["-C", worktree, "add", "-u"]);
  commitOwnWip(worktree, { "again.txt": "the wip's copy\n", "dropped.txt": "made by the wip\n" });
  writeFileSync(join(worktree, "again.txt"), "the worktree's copy\n");
  rmSync(join(worktree, "dropped.txt"));

  const { code, out, errText } = await runCli(env, id, publishArgs(dir));

  assert.equal(code, 0, `${out.join("\n")}\n${errText}`);
  assert.deepEqual(headFiles(worktree), ["again.txt", "gone-in-wip.txt", "src/slug.mjs"]);
  assert.equal(git(["-C", worktree, "show", "HEAD:again.txt"]), "the worktree's copy\n");
  assert.equal(git(["-C", worktree, "status", "--short"]).trim(), "");
});

test("a scratch file and a lone lockfile in the wip are left out, reported and still on disk", async (t) => {
  const { env, id, worktree, dir } = makeRun(t, "publish-wip-left-out");
  commitOwnWip(worktree, { "test/x-QA-probe.mjs": "probe\n", "package-lock.json": "{}\n", "notes.txt": "kept\n" });

  const { code, out, errText } = await runCli(env, id, publishArgs(dir));

  assert.equal(code, 0, `${out.join("\n")}\n${errText}`);
  assert.ok(out.includes("FOLDED: 1 wip commits (1 files); left out: package-lock.json (a dependency lockfile), test/x-QA-probe.mjs (a scratch file)"), out.join("\n"));
  assert.deepEqual(headFiles(worktree), ["notes.txt", "src/slug.mjs"]);
  assert.ok(existsSync(join(worktree, "test/x-QA-probe.mjs")));
  assert.ok(existsSync(join(worktree, "package-lock.json")));
});

test("a lockfile listed now counts the manifest the wip already committed as its pair", async (t) => {
  const { env, id, worktree, dir } = makeRun(t, "publish-wip-pair", { listed: ["package-lock.json"] });
  commitOwnWip(worktree, { "package.json": '{"name":"x","private":true}\n' });
  writeFileSync(join(worktree, "package-lock.json"), '{"name":"x","lockfileVersion":3,"requires":true,"packages":{"":{"name":"x"}}}\n');

  const { code, out, errText } = await runCli(env, id, publishArgs(dir));

  assert.equal(code, 0, `${out.join("\n")}\n${errText}`);
  assert.deepEqual(headFiles(worktree), ["package-lock.json", "package.json"]);
});

test("a wip HEAD whose listed paths are clean still folds, instead of reading as already committed and pushing the wip", async (t) => {
  const { env, id, remote, worktree, dir } = makeRun(t, "publish-wip-clean-list");
  commitOwnWip(worktree, { "src/slug.mjs": "export const slugify = (text) => text;\n" });

  const { code, out } = await runCli(env, id, publishArgs(dir));

  assert.equal(code, 0, out.join("\n"));
  assert.ok(out.includes("FOLDED: 1 wip commits (1 files)"), out.join("\n"));
  assert.equal(pushedSubjects(remote).some((subject) => subject.startsWith("wip(")), false);
});

test("a failing commit-msg hook leaves HEAD on the wip with its ref and the files intact, and the next call delivers", async (t) => {
  const { env, id, worktree, dir } = makeRun(t, "publish-wip-hook");
  const wip = commitOwnWip(worktree, { "notes.txt": "kept\n", "test/x-QA-probe.mjs": "probe\n" });
  const hooks = makeDir(t, "publish-wip-hooks");
  writeFileSync(join(hooks, "commit-msg"), "#!/bin/sh\nexit 1\n");
  chmodSync(join(hooks, "commit-msg"), 0o755);
  git(["-C", worktree, "config", "core.hooksPath", hooks]);

  const failed = await runCli(env, id, publishArgs(dir));

  assert.equal(failed.code, 1, failed.text);
  assert.match(failed.errText, /git could not commit .*the branch is back on the wip commit/);
  assert.equal(git(["-C", worktree, "rev-parse", "HEAD"]).trim(), wip);
  assert.equal(git(["-C", worktree, "rev-parse", WIP_REF]).trim(), wip);
  assert.equal(git(["-C", worktree, "diff", "--cached", "--name-only", "--", "test/x-QA-probe.mjs"]).trim(), "", "the left-out path stayed unstaged");
  assert.ok(existsSync(join(worktree, "src/slug.mjs")));
  assert.deepEqual(ghCalls(env), []);

  git(["-C", worktree, "config", "--unset", "core.hooksPath"]);
  const second = await runCli(env, id, publishArgs(dir));

  assert.equal(second.code, 0, second.text);
  assert.equal(aheadOfMain(worktree), 1);
  assert.deepEqual(headFiles(worktree), ["notes.txt", "src/slug.mjs"]);
});

test("a commit interrupted between the reset and the commit is finished by the next call, the staged wip inside", async (t) => {
  const { env, id, worktree, dir } = makeRun(t, "publish-wip-killed");
  const wip = commitOwnWip(worktree, { "src/slug.mjs": "export const slugify = (text) => text;\n", "notes.txt": "kept\n" });
  git(["-C", worktree, "reset", "--soft", "-q", `${wip}^`]);

  const { code, out } = await runCli(env, id, publishArgs(dir));

  assert.equal(code, 0, out.join("\n"));
  assert.equal(out.some((line) => line.includes("already committed")), false, out.join("\n"));
  assert.deepEqual(headFiles(worktree), ["notes.txt", "src/slug.mjs"]);
});

test("a fold a kill cut before its unstaging finishes as a fold: the wip's leftovers stay out of the delivery, unstaged and on disk", async (t) => {
  const { env, id, worktree, dir } = makeRun(t, "publish-wip-killed-leftovers");
  const leftovers = ["test/x-QA-probe.mjs", "package-lock.json", ".claude/settings.json"];
  const wip = commitOwnWip(worktree, { "src/slug.mjs": "export const slugify = (text) => text;\n", "notes.txt": "kept\n", ...Object.fromEntries(leftovers.map((path) => [path, "{}\n"])) });
  git(["-C", worktree, "reset", "--soft", "-q", `${wip}^`]);

  const { code, out, errText } = await runCli(env, id, publishArgs(dir));

  assert.equal(code, 0, `${out.join("\n")}\n${errText}`);
  assert.ok(out.some((line) => line.startsWith("FOLDED: 1 wip commits (2 files); left out: ")), out.join("\n"));
  assert.deepEqual(headFiles(worktree), ["notes.txt", "src/slug.mjs"]);
  assert.equal(git(["-C", worktree, "diff", "--cached", "--name-only"]).trim(), "");
  for (const path of leftovers) assert.ok(existsSync(join(worktree, path)), path);
  assert.equal(git(["-C", worktree, "rev-parse", WIP_REF]).trim(), wip);
});

test("a killed fold whose resumed attempt fails the hook goes back on the wip, and the next call still delivers without the leftovers", async (t) => {
  const { env, id, worktree, dir } = makeRun(t, "publish-wip-killed-twice");
  const wip = commitOwnWip(worktree, { "notes.txt": "kept\n", "test/x-QA-probe.mjs": "probe\n" });
  git(["-C", worktree, "reset", "--soft", "-q", `${wip}^`]);
  const hooks = makeDir(t, "publish-wip-killed-hooks");
  writeFileSync(join(hooks, "commit-msg"), "#!/bin/sh\nexit 1\n");
  chmodSync(join(hooks, "commit-msg"), 0o755);
  git(["-C", worktree, "config", "core.hooksPath", hooks]);

  const failed = await runCli(env, id, publishArgs(dir));

  assert.equal(failed.code, 1, failed.text);
  assert.equal(git(["-C", worktree, "rev-parse", "HEAD"]).trim(), wip);
  git(["-C", worktree, "config", "--unset", "core.hooksPath"]);
  const second = await runCli(env, id, publishArgs(dir));
  assert.equal(second.code, 0, second.text);
  assert.deepEqual(headFiles(worktree), ["notes.txt", "src/slug.mjs"]);
});

test("a staged path the wip does not carry on a wip's parent is no interrupted fold: the plain route commits it", async (t) => {
  const { env, id, worktree, dir } = makeRun(t, "publish-wip-not-killed");
  commitOwnWip(worktree);
  git(["-C", worktree, "reset", "--hard", "-q", "HEAD^"]);
  writeFileSync(join(worktree, "src/slug.mjs"), "export const slugify = (text) => text;\n");
  git(["-C", worktree, "add", "src/slug.mjs"]);

  const { code, out, errText } = await runCli(env, id, publishArgs(dir));

  assert.equal(code, 0, `${out.join("\n")}\n${errText}`);
  assert.equal(out.some((line) => line.startsWith("FOLDED:")), false, out.join("\n"));
  assert.deepEqual(headFiles(worktree), ["src/slug.mjs"]);
});

test("a failed fold leaves the index equal to HEAD, every edit still in the worktree", async (t) => {
  const { env, id, worktree, dir } = makeRun(t, "publish-wip-undo-index");
  const wip = commitOwnWip(worktree);
  writeFileSync(join(worktree, "notes.txt"), "edited after the wip\n");
  const hooks = makeDir(t, "publish-wip-undo-hooks");
  writeFileSync(join(hooks, "commit-msg"), "#!/bin/sh\nexit 1\n");
  chmodSync(join(hooks, "commit-msg"), 0o755);
  git(["-C", worktree, "config", "core.hooksPath", hooks]);

  const failed = await runCli(env, id, publishArgs(dir));

  assert.equal(failed.code, 1, failed.text);
  assert.equal(git(["-C", worktree, "rev-parse", "HEAD"]).trim(), wip);
  assert.equal(git(["-C", worktree, "diff", "--cached", "--name-only"]).trim(), "");
  assert.equal(readFileSync(join(worktree, "notes.txt"), "utf8"), "edited after the wip\n");
  assert.ok(existsSync(join(worktree, "src/slug.mjs")));
});

test("a clean retry with an empty list folds what the wip carries, and `run check 04` names those paths without the left-out ones", async (t) => {
  const published = makeRun(t, "publish-wip-empty-list", { listed: [] });
  commitOwnWip(published.worktree);
  const folded = await runCli(published.env, published.id, publishArgs(published.dir));
  assert.equal(folded.code, 0, `${folded.text}\n${folded.errText}`);
  assert.ok(folded.out.includes("FOLDED: 1 wip commits (1 files)"), folded.text);

  const checked = makeRun(t, "check-wip-empty-list", { listed: [] });
  commitOwnWip(checked.worktree, { "notes.txt": "kept\n", "test/x-QA-probe.mjs": "probe\n", "package-lock.json": "{}\n" });
  const { out } = await runCli(checked.env, checked.id, ["run", "check", "04"]);
  assert.equal(out[0], "GENERATED", out.join("\n"));
  assert.deepEqual(listedFiles(readFileSync(join(checked.dir, "04-implementation.md"), "utf8")), [join(checked.worktree, "notes.txt")]);
});

test("a wip whose every path is left out and an empty list still refuse as nothing to commit, on the wip", async (t) => {
  const { env, id, worktree, dir } = makeRun(t, "publish-wip-all-left-out", { listed: [] });
  const wip = commitOwnWip(worktree, { "test/x-QA-probe.mjs": "probe\n" });

  const { code, errText } = await runCli(env, id, publishArgs(dir));

  assert.equal(code, 1);
  assert.match(errText, /lists no file under `## Modified files`: there is nothing to commit/);
  assert.equal(git(["-C", worktree, "rev-parse", "HEAD"]).trim(), wip);
});

test("a wip commit with no ref, another run's wip on a job without start_branch, a commit above an own wip and a ref-named plain commit are refused", async (t) => {
  const human = makeRun(t, "publish-human-wip");
  const humanWip = commitWipShaped(human.worktree);
  await assertRefused(human, `REJECTED: the branch carries the wip commit ${humanWip.slice(0, 7)} (wip(${SLUG}): terminated at qa — why), which is not this run's own and is never pushed: stop and record it as an open item; the operator squashes it`);

  const other = makeRun(t, "publish-other-wip");
  const otherWip = commitOwnWip(other.worktree, undefined, "other-run");
  await assertRefused(other, `REJECTED: the branch carries the wip commit ${otherWip.slice(0, 7)} (refs/nightqueue/wip/other-run), which is not this run's own and is never pushed: stop and record it as an open item; the operator squashes it`);

  const buried = makeRun(t, "publish-buried-wip");
  const buriedWip = commitOwnWip(buried.worktree);
  git(["-C", buried.worktree, "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "--no-verify", "-m", "by hand"]);
  const above = git(["-C", buried.worktree, "rev-parse", "HEAD"]).trim();
  await assertRefused(buried, `REJECTED: the commit ${above.slice(0, 7)} (by hand) sits above the wip commit ${buriedWip.slice(0, 7)}, which is never pushed: stop and record it as an open item; the operator squashes it`);

  const named = makeRun(t, "publish-named-commit");
  git(["-C", named.worktree, "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "--no-verify", "-m", "chore: plain"]);
  const plain = git(["-C", named.worktree, "rev-parse", "HEAD"]).trim();
  git(["-C", named.worktree, "update-ref", "refs/nightqueue/wip/another", plain]);
  await assertRefused(named, `REJECTED: the branch carries the wip commit ${plain.slice(0, 7)} (refs/nightqueue/wip/another), which is not this run's own and is never pushed: stop and record it as an open item; the operator squashes it`);
});

test("a job with start_branch folds the wip it inherited, and a human `wip(` commit stays refused there", async (t) => {
  const inherited = makeRun(t, "publish-inherited");
  openDb(inherited.env).prepare("UPDATE jobs SET start_branch = ? WHERE id = ?").run(BRANCH, inherited.id);
  commitOwnWip(inherited.worktree, undefined, "other-run");
  const folded = await runCli(inherited.env, inherited.id, publishArgs(inherited.dir));
  assert.equal(folded.code, 0, folded.text);
  assert.equal(aheadOfMain(inherited.worktree), 1);
  assert.deepEqual(headFiles(inherited.worktree), ["notes.txt", "src/slug.mjs"]);

  const human = makeRun(t, "publish-inherited-human");
  openDb(human.env).prepare("UPDATE jobs SET start_branch = ? WHERE id = ?").run(BRANCH, human.id);
  const humanWip = commitWipShaped(human.worktree);
  await assertRefused(human, `REJECTED: the branch carries the wip commit ${humanWip.slice(0, 7)} (wip(${SLUG}): terminated at qa — why), which is not this run's own and is never pushed: stop and record it as an open item; the operator squashes it`);
});

test("`run commit` folds the run's own wip and `run publish` then reuses that commit", async (t) => {
  const { env, id, remote, worktree, dir, projectId } = makeRun(t, "commit-wip-fold");
  commitOwnWip(worktree);

  const committed = await runCli(env, id, ["run", "commit", "--message-file", join(dir, "commit-message.txt")]);

  assert.equal(committed.code, 0, committed.text);
  assert.ok(committed.out.includes("FOLDED: 1 wip commits (1 files)"), committed.text);
  assert.equal(aheadOfMain(worktree), 1);

  const published = await runCli(env, id, publishArgs(dir));

  assert.equal(published.code, 0, published.text);
  assert.match(published.out[1], /^COMMITTED: [0-9a-f]+ \(already committed\)$/);
  assert.equal(pushedSubjects(remote).some((subject) => subject.startsWith("wip(")), false);
  assert.deepEqual([...readRunState({ projectId, slug: SLUG, env }).outcome.files].sort(), ["notes.txt", "src/slug.mjs"]);
});

test("`run commit` refuses a foreign wip and commits nothing", async (t) => {
  const { env, id, worktree, dir } = makeRun(t, "commit-wip-foreign");
  commitWipShaped(worktree);
  const before = commitCount(worktree);

  const { code, out } = await runCli(env, id, ["run", "commit", "--message-file", join(dir, "commit-message.txt")]);

  assert.equal(code, 1);
  assert.match(out[0], /^REJECTED: the branch carries the wip commit /);
  assert.equal(commitCount(worktree), before);
});

test("`run pr` refuses a branch carrying a runtime wip commit, naming `run publish`, and pushes nothing", async (t) => {
  const { env, id, remote, worktree, dir } = makeRun(t, "pr-wip");
  const wip = commitOwnWip(worktree);

  const { code, out } = await runCli(env, id, ["run", "pr", "--body-file", join(dir, "pr-body.md")]);

  assert.equal(code, 1, out.join("\n"));
  assert.ok(out.includes(`REJECTED: the branch carries the runtime's wip commit ${wip.slice(0, 7)}, which is never pushed: call \`nightqueue run publish\`, which folds it into the delivery commit`), out.join("\n"));
  assert.equal(git(["-C", remote, "for-each-ref", "refs/heads"]).includes(SLUG), false, "the wip branch was pushed");
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
