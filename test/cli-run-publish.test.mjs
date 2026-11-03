import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { run } from "../src/cli/index.mjs";
import { EXTRA_IS_NOT_AN_OVERRIDE } from "../src/cli/run-publish.mjs";
import { runDir } from "../src/config/paths.mjs";
import { openDb } from "../src/memory/db.mjs";
import { addJob } from "../src/memory/jobs.mjs";
import { ghPrUrlOfBranch } from "../src/host/gh.mjs";
import { classifyJobResult } from "../src/queue/classify.mjs";
import { provenEditedPrUrls } from "../src/queue/edit-proof.mjs";
import { listedFiles } from "../src/queue/file-list.mjs";
import { readRunState } from "../src/queue/resume.mjs";
import { consumeRunConclusion, recordJobBlock, recordOutcome, recordPrUrl, recordRunFields, recordRuntimeField, recordTermination, recordWip } from "../src/queue/run-state.mjs";
import { codeChangePublishedEvent, resultEvent, systemInitEvent, toNdjson } from "../test-support/streams.mjs";
import { initGitRepo } from "../test-support/git.mjs";
import { FAKE_GH_PR_URL, isolatedHostVars } from "../test-support/host.mjs";
import { ensureProject, makeDir, makeHome, registerCheckout } from "../test-support/memory.mjs";
import { makeSickHome } from "../test-support/sick-home.mjs";

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

const SKIP_REASON = "only documentation text changed.";

// Records the QA mode the way a completed `run check 05 --stage triage` does.
function recordQaMode({ projectId, slug, mode, reason, env }) {
  return recordRuntimeField({ projectId, slug, name: "qaMode", value: { mode, reason, at: new Date().toISOString() }, env });
}

// The body with the line placed right under its QA heading.
function bodyWithQaLine(line, body = BODY) {
  return body.replace("## QA\n", `## QA\n\n${line}\n`);
}

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

test("a recorded QA skip refuses a body without its exact line, whatever the agent wrote instead", async (t) => {
  const bodies = [
    ["absent", BODY],
    ["another-reason", bodyWithQaLine("QA: skipped — it looked fine to me.")],
    ["fenced", bodyWithQaLine(`\`\`\`\nQA: skipped — ${SKIP_REASON}\n\`\`\``)],
    ["commented", bodyWithQaLine(`<!-- QA: skipped — ${SKIP_REASON} -->`)],
  ];
  for (const [name, body] of bodies) {
    const { env, id, worktree, dir, projectId } = makeRun(t, `publish-skip-${name}`);
    recordQaMode({ projectId, slug: SLUG, mode: "skip", reason: SKIP_REASON, env });
    writeFileSync(join(dir, "pr-body.md"), body);
    const before = commitCount(worktree);

    const { code, out } = await runCli(env, id, publishArgs(dir));

    assert.equal(code, 1, name);
    assert.ok(out.includes(`REJECTED: the QA of this run was skipped, so the body carries this exact line under its test section's heading: QA: skipped — ${SKIP_REASON}`), out.join("\n"));
    assert.equal(commitCount(worktree), before, `${name} still committed`);
    assert.deepEqual(ghCalls(env), []);
  }
});

test("a recorded QA skip publishes a body with its exact line", async (t) => {
  const { env, id, dir, projectId } = makeRun(t, "publish-skip-exact");
  recordQaMode({ projectId, slug: SLUG, mode: "skip", reason: SKIP_REASON, env });
  writeFileSync(join(dir, "pr-body.md"), bodyWithQaLine(`QA: skipped — ${SKIP_REASON}`));

  const { code, out, errText } = await runCli(env, id, publishArgs(dir));

  assert.equal(code, 0, `${out.join("\n")}\n${errText}`);
  assert.ok(out.includes(`PR: ${FAKE_GH_PR_URL}`), out.join("\n"));
});

test("a skip reason that names the slug or a bare reference never makes the owed line unpublishable, and the rest of the body is still read", async (t) => {
  const reason = `covered by test/${SLUG}.test.mjs, see #12.`;
  const { env, id, dir, projectId } = makeRun(t, "publish-skip-words");
  recordQaMode({ projectId, slug: SLUG, mode: "skip", reason, env });
  writeFileSync(join(dir, "pr-body.md"), bodyWithQaLine(`QA: skipped — ${reason}`).replace("## Changes\n", "## Changes\n\nSee #12.\n"));
  const refused = await runCli(env, id, publishArgs(dir));
  assert.equal(refused.code, 1, "a bare reference outside the owed line still counts");
  assert.ok(refused.out.some((line) => line.includes("#12")), refused.out.join("\n"));

  writeFileSync(join(dir, "pr-body.md"), bodyWithQaLine(`QA: skipped — ${reason}`));
  const { code, out, errText } = await runCli(env, id, publishArgs(dir));
  assert.equal(code, 0, `${out.join("\n")}\n${errText}`);
});

test("a `lite`, a `full` or no recorded QA mode owes no skip line", async (t) => {
  for (const mode of ["lite", "full", null]) {
    const { env, id, dir, projectId } = makeRun(t, `publish-no-skip-${mode}`);
    if (mode !== null) recordQaMode({ projectId, slug: SLUG, mode, reason: "a real reason.", env });

    const { code, out, errText } = await runCli(env, id, publishArgs(dir));

    assert.equal(code, 0, `${mode}: ${out.join("\n")}\n${errText}`);
  }
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
  git(["-C", worktree, "add", "src/slug.mjs"]);
  git(["-C", worktree, "-c", "commit.gpgsign=false", "commit", "-q", "-F", join(dir, "commit-message.txt")]);
  const before = commitCount(worktree);

  const { code, out } = await runCli(env, id, publishArgs(dir));

  assert.equal(code, 0, out.join("\n"));
  assert.match(out[1], /^COMMITTED: [0-9a-f]+ \(already committed\)$/);
  assert.equal(commitCount(worktree), before, "the retry committed a second time");
  assert.equal(out.at(-2), `PR: ${FAKE_GH_PR_URL}`);
});

test("a refused path is refused and nothing is committed", async (t) => {
  const { env, id, worktree, dir } = makeRun(t, "publish-refused", { listed: ["src/slug.mjs", ".claude/settings.json"] });
  const before = commitCount(worktree);

  const publish = await runCli(env, id, publishArgs(dir));

  assert.equal(publish.code, 1);
  assert.match(publish.out[0], /^REFUSED: \.claude\/settings\.json \(under `\.claude\/`\)/);
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
  assert.deepEqual(listedFiles(readFileSync(join(checked.dir, "04-files.generated.md"), "utf8")), [join(checked.worktree, "notes.txt")]);
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

// Writes the run's body with one `Remaining failure:` line per failure named.
function writeDraftBody(dir, failures, body = BODY) {
  writeFileSync(join(dir, "pr-body.md"), `${body}\n${failures.map((failure) => `Remaining failure: ${failure}`).join("\n")}\n`);
}

// The calls the fake gh received, parsed.
function parsedGhCalls(env) {
  return ghCalls(env).map((line) => JSON.parse(line));
}

// The call of one `gh pr <sub>`, or undefined when gh never received it.
function prCall(env, sub) {
  return parsedGhCalls(env).find((call) => call[0] === "pr" && call[1] === sub);
}

test("`run publish --draft` opens a draft, records its failures and the report says so", async (t) => {
  const { env, id, dir, projectId } = makeRun(t, "publish-draft");
  writeDraftBody(dir, ["`npm test` fails in slug.test.mjs", "the empty title still throws"]);

  const { code, out, errText } = await runCli(env, id, publishArgs(dir, ["--draft"]));

  assert.equal(code, 0, `${out.join("\n")}\n${errText}`);
  assert.ok(prCall(env, "create").includes("--draft"), "gh was not asked for a draft");
  assert.deepEqual(out.slice(3, 5), [`PR: ${FAKE_GH_PR_URL}`, "DRAFT: draft pull request — 2 failures remain"]);
  const state = readRunState({ projectId, slug: SLUG, env });
  assert.deepEqual([state.outcome.status, state.outcome.prUrl, state.outcome.draft, state.outcome.draftFailures], ["done", FAKE_GH_PR_URL, true, 2]);
  assert.equal(state.phases.find((entry) => entry.phase === "commit").verdict, "Draft PR opened");
  const report = await runCli(env, id, ["run", "report"]);
  assert.ok(report.out.includes("Happy: no — draft pull request — 2 failures remain"), report.text);
  assert.ok(report.out.includes("- draft pull request — 2 failures remain"), report.text);
  assert.ok(report.out.some((line) => line.startsWith(`| 8 Commit/PR | 🚀 Commit/PR | ✅ DRAFT PR OPENED | draft pull request ${FAKE_GH_PR_URL} — 2 failures remain |`)), report.text);
  const log = toNdjson([systemInitEvent(), resultEvent({ text: "draft opened" })]);
  assert.equal(classifyJobResult({ log, exitCode: 0, state, runOutcome: "pr_opened" }).status, "done");
});

const WHICH_ONE_PLACEHOLDER = "REJECTED: the body still carries the placeholder `<which one>`: fill every section with this run's own facts";

for (const [unfilled, bodyRefusals] of [["", []], [" none", []], [" n/a", []], [" -", []], [" <which one>", [WHICH_ONE_PLACEHOLDER]]]) {
  test(`\`--draft\` whose only \`Remaining failure:\` line holds "${unfilled}" commits nothing and pushes nothing`, async (t) => {
    const { env, id, worktree, dir } = makeRun(t, "publish-draft-no-failure");
    writeFileSync(join(dir, "pr-body.md"), `${BODY}\nRemaining failure:${unfilled}\n`);
    const before = commitCount(worktree);

    const { code, out } = await runCli(env, id, publishArgs(dir, ["--draft"]));

    assert.equal(code, 1);
    assert.deepEqual(out, [
      ...bodyRefusals,
      "REJECTED: a draft pull request lists each failure on a Remaining failure: <what> line of its QA/verification section",
      "nothing was committed or pushed: fix the problems above and call `nightqueue run publish` again",
    ]);
    assert.equal(commitCount(worktree), before);
    assert.deepEqual(ghCalls(env), []);
  });
}

for (const [unfilled, bodyRefusals] of [[" (none)", []], [" None.", []], [" ✗✗", []], [" <what>", ["REJECTED: the body still carries the placeholder `<what>`: fill every section with this run's own facts"]]]) {
  test(`\`--draft\` counts no failure for "${unfilled}"`, async (t) => {
    const { env, id, dir } = makeRun(t, "publish-draft-no-failure-spelling");
    writeFileSync(join(dir, "pr-body.md"), `${BODY}\nRemaining failure:${unfilled}\n`);

    const { code, out } = await runCli(env, id, publishArgs(dir, ["--draft"]));

    assert.equal(code, 1);
    assert.deepEqual(out.slice(0, -1), [...bodyRefusals, "REJECTED: a draft pull request lists each failure on a Remaining failure: <what> line of its QA/verification section"]);
    assert.deepEqual(ghCalls(env), []);
  });
}

test("every failure text that looks unfilled but names a failure counts as one", async (t) => {
  const { env, id, dir, projectId } = makeRun(t, "publish-draft-looks-unfilled");
  const named = ["[retry.test.mjs: 3 failing]", "<retry.test.mjs: 3 failing>", "TODO: flaky e2e on CI", "NA - runner offline", "nothing - the suite never starts", "none of the e2e tests start"];
  writeDraftBody(dir, named);

  const { code, out, errText } = await runCli(env, id, publishArgs(dir, ["--draft"]));

  assert.equal(code, 0, `${out.join("\n")}\n${errText}`);
  assert.ok(out.includes(`DRAFT: draft pull request — ${named.length} failures remain`), out.join("\n"));
  assert.equal(readRunState({ projectId, slug: SLUG, env }).outcome.draftFailures, named.length);
});

for (const command of ["publish", "pr"]) {
  test(`\`run ${command}\` without the flag leaves the run's own draft a draft while its body lists a failure`, async (t) => {
    const { env, id, dir, projectId } = makeRun(t, `${command}-keeps-own-draft`);
    writeDraftBody(dir, ["`npm test` fails", "the empty title still throws"]);
    assert.equal((await runCli(env, id, publishArgs(dir, ["--draft"]))).code, 0);
    const existing = { ...env, NIGHTQUEUE_FAKE_GH_PR_EXISTS: "1", NIGHTQUEUE_FAKE_GH_PR_LIST: EXISTING_PR_LIST };
    const argv = command === "publish" ? publishArgs(dir) : ["run", "pr", "--body-file", join(dir, "pr-body.md"), "--title", "feat(text): add slugify"];

    const { code, out, errText } = await runCli(existing, id, argv);

    assert.equal(code, 0, `${out.join("\n")}\n${errText}`);
    assert.equal(prCall(env, "ready"), undefined);
    assert.equal(out.some((line) => line.startsWith("READY:")), false, out.join("\n"));
    assert.ok(out.includes("DRAFT: draft pull request — 2 failures remain (stays a draft: the body still lists a Remaining failure: line)"), out.join("\n"));
    const state = readRunState({ projectId, slug: SLUG, env });
    assert.deepEqual([state.outcome.draft, state.outcome.draftFailures, state.outcome.staysDraft, state.draftPrUrl], [true, 2, undefined, FAKE_GH_PR_URL]);
    const report = await runCli(env, id, ["run", "report"]);
    assert.ok(report.out.includes("Happy: no — draft pull request — 2 failures remain"), report.text);
  });
}

test("a first publish without the flag whose body lists a failure stays a normal pull request", async (t) => {
  const { env, id, dir, projectId } = makeRun(t, "publish-first-plain-listed");
  writeDraftBody(dir, ["`npm test` fails"]);

  const { code, out, errText } = await runCli(env, id, publishArgs(dir));

  assert.equal(code, 0, `${out.join("\n")}\n${errText}`);
  assert.equal(prCall(env, "create").includes("--draft"), false);
  assert.equal(out.some((line) => line.startsWith("DRAFT:")), false, out.join("\n"));
  const state = readRunState({ projectId, slug: SLUG, env });
  assert.deepEqual([state.outcome.draft, state.outcome.draftFailures], [undefined, undefined]);
});

test("a publish without the flag still leaves alone a pull request this run never drafted when its body lists a failure", async (t) => {
  const { env, id, dir, projectId } = makeRun(t, "publish-plain-existing-listed");
  writeDraftBody(dir, ["`npm test` fails"]);
  const existing = { ...env, NIGHTQUEUE_FAKE_GH_PR_EXISTS: "1", NIGHTQUEUE_FAKE_GH_PR_LIST: EXISTING_PR_LIST };

  const { code, out, errText } = await runCli(existing, id, publishArgs(dir));

  assert.equal(code, 0, `${out.join("\n")}\n${errText}`);
  assert.equal(prCall(env, "ready"), undefined);
  assert.equal(out.some((line) => line.startsWith("DRAFT:")), false, out.join("\n"));
  assert.equal(readRunState({ projectId, slug: SLUG, env }).outcome.draft, undefined);
});

test("`--draft` onto a branch whose pull request exists replaces its body and turns it back into a draft", async (t) => {
  const { env, id, dir, projectId } = makeRun(t, "publish-draft-existing");
  writeDraftBody(dir, ["`npm test` fails"]);
  const existing = { ...env, NIGHTQUEUE_FAKE_GH_PR_EXISTS: "1", NIGHTQUEUE_FAKE_GH_PR_LIST: EXISTING_PR_LIST };

  const { code, out, errText } = await runCli(existing, id, publishArgs(dir, ["--draft"]));

  assert.equal(code, 0, `${out.join("\n")}\n${errText}`);
  assert.ok(prCall(env, "edit"), "the existing body was not replaced");
  assert.deepEqual(prCall(env, "ready"), ["pr", "ready", FAKE_GH_PR_URL, "--undo"]);
  assert.ok(out.includes("DRAFT: draft pull request — 1 failure remains"), out.join("\n"));
  assert.equal(readRunState({ projectId, slug: SLUG, env }).outcome.draftFailures, 1);
});

test("a fenced or commented `Remaining failure:` line counts for nothing", async (t) => {
  const { env, id, dir, projectId } = makeRun(t, "publish-draft-fenced-count");
  const commented = BODY.replace("## Cause", "<!--\nRemaining failure: a comment\n-->\n\n## Cause");
  writeFileSync(join(dir, "pr-body.md"), `${commented}\nRemaining failure: a real one\n\n\`\`\`\nRemaining failure: an example\n\`\`\`\n`);

  const { code, out, errText } = await runCli(env, id, publishArgs(dir, ["--draft"]));

  assert.equal(code, 0, `${out.join("\n")}\n${errText}`);
  assert.equal(readRunState({ projectId, slug: SLUG, env }).outcome.draftFailures, 1);
});

test("a pull request gh refuses to turn into a draft is delivered and recorded as no draft, with gh's reason", async (t) => {
  const { env, id, dir, projectId } = makeRun(t, "publish-draft-undo-refused");
  writeDraftBody(dir, ["`npm test` fails"]);
  const refused = { ...env, NIGHTQUEUE_FAKE_GH_PR_EXISTS: "1", NIGHTQUEUE_FAKE_GH_PR_LIST: EXISTING_PR_LIST, NIGHTQUEUE_FAKE_GH_UNDO_REFUSED: "1" };

  const { code, out, errText } = await runCli(refused, id, publishArgs(dir, ["--draft"]));

  assert.equal(code, 0, `${out.join("\n")}\n${errText}`);
  assert.match(errText, /could not turn .* into a draft: Draft pull requests are not supported/);
  assert.equal(out.some((line) => line.startsWith("DRAFT:")), false, out.join("\n"));
  const state = readRunState({ projectId, slug: SLUG, env });
  assert.deepEqual([state.outcome.status, state.outcome.prUrl, state.outcome.draft, state.outcome.draftFailures], ["done", FAKE_GH_PR_URL, undefined, 1]);
  assert.equal(state.phases.find((entry) => entry.phase === "commit").verdict, "PR opened");
  const report = await runCli(env, id, ["run", "report"]);
  assert.ok(report.out.includes("Happy: no — pull request — 1 failure remains (gh refused the draft)"), report.text);
});

test("a draft gh refuses opens a normal pull request, keeps the failures and reads not happy", async (t) => {
  const { env, id, dir, projectId } = makeRun(t, "publish-draft-refused");
  writeDraftBody(dir, ["`npm test` fails"]);

  const { code, out, errText } = await runCli({ ...env, NIGHTQUEUE_FAKE_GH_DRAFT_REFUSED: "1" }, id, publishArgs(dir, ["--draft"]));

  assert.equal(code, 0, `${out.join("\n")}\n${errText}`);
  assert.match(errText, /could not turn .* into a draft: Draft pull requests are not supported/);
  assert.equal(out.some((line) => line.startsWith("DRAFT:")), false, out.join("\n"));
  const creates = parsedGhCalls(env).filter((call) => call[1] === "create");
  assert.deepEqual(creates.map((call) => call.includes("--draft")), [true, false]);
  const state = readRunState({ projectId, slug: SLUG, env });
  assert.deepEqual([state.outcome.status, state.outcome.prUrl, state.outcome.draft, state.outcome.draftFailures], ["done", FAKE_GH_PR_URL, undefined, 1]);
  assert.equal("draftPrUrl" in state, false);
  const report = await runCli(env, id, ["run", "report"]);
  assert.ok(report.out.includes("Happy: no — pull request — 1 failure remains (gh refused the draft)"), report.text);
});

test("a draft whose plain retry fails too fails with gh's reason, the branch pushed and recorded, and the run not recorded as done", async (t) => {
  const { env, id, remote, dir, projectId } = makeRun(t, "publish-draft-both-refused");
  writeDraftBody(dir, ["`npm test` fails"]);

  const { code, errText } = await runCli({ ...env, NIGHTQUEUE_FAKE_GH_DRAFT_REFUSED: "1", NIGHTQUEUE_FAKE_GH_PR_URL: "" }, id, publishArgs(dir, ["--draft"]));

  assert.equal(code, 1);
  assert.match(errText, /is pushed, but gh could not open the pull request: /);
  assert.deepEqual(parsedGhCalls(env).filter((call) => call[1] === "create").map((call) => call.includes("--draft")), [true, false]);
  assert.ok(git(["-C", remote, "for-each-ref", "--format=%(refname:short)", "refs/heads"]).includes(`feat/${SLUG}`));
  const state = readRunState({ projectId, slug: SLUG, env });
  assert.equal(state.branch, `feat/${SLUG}`);
  assert.equal(state.outcome, undefined);
});

test("a publish without the flag turns the run's own draft ready, drops the record and asks gh for no draft", async (t) => {
  const { env, id, dir, projectId } = makeRun(t, "publish-draft-then-plain");
  writeDraftBody(dir, ["`npm test` fails"]);
  assert.equal((await runCli(env, id, publishArgs(dir, ["--draft"]))).code, 0);
  assert.equal(readRunState({ projectId, slug: SLUG, env }).draftPrUrl, FAKE_GH_PR_URL);
  await consumeRunConclusion({ projectId, slug: SLUG, jobId: id, env });
  assert.equal(readRunState({ projectId, slug: SLUG, env }).draftPrUrl, FAKE_GH_PR_URL, "the next attempt lost the run's draft");
  writeFileSync(join(dir, "pr-body.md"), BODY);
  const existing = { ...env, NIGHTQUEUE_FAKE_GH_PR_EXISTS: "1", NIGHTQUEUE_FAKE_GH_PR_LIST: EXISTING_PR_LIST };

  const { code, out, errText } = await runCli(existing, id, publishArgs(dir));

  assert.equal(code, 0, `${out.join("\n")}\n${errText}`);
  assert.equal(parsedGhCalls(env).filter((call) => call[1] === "create").at(-1).includes("--draft"), false);
  assert.deepEqual(prCall(env, "ready"), ["pr", "ready", FAKE_GH_PR_URL]);
  assert.ok(out.includes(`READY: ${FAKE_GH_PR_URL}`), out.join("\n"));
  assert.equal(out.some((line) => line.startsWith("DRAFT:")), false, out.join("\n"));
  const state = readRunState({ projectId, slug: SLUG, env });
  assert.deepEqual([state.outcome.status, state.outcome.draft, state.outcome.draftFailures, state.outcome.staysDraft], ["done", undefined, undefined, undefined]);
  assert.equal("draftPrUrl" in state, false);
});

test("a publish without the flag leaves alone an existing pull request this run never drafted", async (t) => {
  const { env, id, dir } = makeRun(t, "publish-plain-existing");
  const existing = { ...env, NIGHTQUEUE_FAKE_GH_PR_EXISTS: "1", NIGHTQUEUE_FAKE_GH_PR_LIST: EXISTING_PR_LIST };

  const { code, out, errText } = await runCli(existing, id, publishArgs(dir));

  assert.equal(code, 0, `${out.join("\n")}\n${errText}`);
  assert.equal(prCall(env, "ready"), undefined);
  assert.equal(out.some((line) => line.startsWith("READY:")), false, out.join("\n"));
});

test("a run's own draft gh refuses to turn ready stays recorded and is an open item, with no failure left", async (t) => {
  const { env, id, dir, projectId } = makeRun(t, "publish-draft-ready-refused");
  writeDraftBody(dir, ["`npm test` fails"]);
  assert.equal((await runCli(env, id, publishArgs(dir, ["--draft"]))).code, 0);
  writeFileSync(join(dir, "pr-body.md"), BODY);
  const existing = { ...env, NIGHTQUEUE_FAKE_GH_PR_EXISTS: "1", NIGHTQUEUE_FAKE_GH_PR_LIST: EXISTING_PR_LIST, NIGHTQUEUE_FAKE_GH_READY_REFUSED: "1" };

  const { code, out, errText } = await runCli(existing, id, publishArgs(dir));

  assert.equal(code, 0, `${out.join("\n")}\n${errText}`);
  assert.match(errText, /stays a draft: Resource not accessible/);
  assert.equal(out.some((line) => line.startsWith("READY:")), false, out.join("\n"));
  const state = readRunState({ projectId, slug: SLUG, env });
  assert.deepEqual([state.outcome.staysDraft, state.outcome.draft, state.outcome.draftFailures, state.draftPrUrl], [true, undefined, undefined, FAKE_GH_PR_URL]);
  const report = await runCli(env, id, ["run", "report"]);
  assert.ok(report.out.includes(`- pull request ${FAKE_GH_PR_URL} stays a draft`), report.text);
});

test("`Remaining failure:` lines pass the body check of a repository template", async (t) => {
  const { env, id, worktree, dir } = makeRun(t, "publish-draft-repo-template");
  mkdirSync(join(worktree, ".github"), { recursive: true });
  writeFileSync(join(worktree, ".github", "pull_request_template.md"), "## Summary\n\n## Testing\n");
  writeDraftBody(dir, ["`npm test` fails"], "## Summary\n\nslug helper.\n\n## Testing\n\n`npm test` failed.\n");

  const { code, out, errText } = await runCli(env, id, publishArgs(dir, ["--draft"]));

  assert.equal(code, 0, `${out.join("\n")}\n${errText}`);
  assert.ok(out.includes("DRAFT: draft pull request — 1 failure remains"), out.join("\n"));
});

test("a draft after a re-triage's terminal verdict still ends done and the report names the draft first", async (t) => {
  const { env, id, dir, projectId } = makeRun(t, "publish-draft-terminated");
  recordTermination({ projectId, slug: SLUG, phase: "triage", reason: "NOT-REPRODUCIBLE", by: "runtime", env });
  writeDraftBody(dir, ["the symptom persists after the fix loop"]);

  const { code, out, errText } = await runCli(env, id, publishArgs(dir, ["--draft"]));

  assert.equal(code, 0, `${out.join("\n")}\n${errText}`);
  const state = readRunState({ projectId, slug: SLUG, env });
  const log = toNdjson([systemInitEvent(), resultEvent({ text: "draft opened" })]);
  const outcome = classifyJobResult({ log, exitCode: 0, state, runOutcome: "pr_opened" });
  assert.deepEqual([outcome.status, outcome.prUrl], ["done", FAKE_GH_PR_URL]);
  const report = await runCli(env, id, ["run", "report"]);
  assert.ok(report.out.includes("Happy: no — draft pull request — 1 failure remains"), report.text);
});

test("the draft record needs a positive failure count and any later outcome drops it", async (t) => {
  const { env, projectId } = makeRun(t, "publish-draft-record");
  const target = { projectId, slug: SLUG, env };

  for (const failures of [0, -1, Number.NaN, "2", undefined]) {
    assert.equal(recordOutcome({ ...target, status: "done", draft: true, failures }).status, "kept", String(failures));
  }
  assert.equal(readRunState(target).outcome, undefined);
  assert.equal(recordOutcome({ ...target, status: "done", draft: true, failures: 3 }).status, "written");
  recordPrUrl({ ...target, prUrl: FAKE_GH_PR_URL });
  assert.deepEqual([readRunState(target).outcome.draft, readRunState(target).outcome.draftFailures], [true, 3], "recording the URL lost the draft");
  recordOutcome({ ...target, status: "gate", notice: "why" });
  const { outcome } = readRunState(target);
  assert.deepEqual([outcome.status, outcome.draft, outcome.draftFailures], ["gate", undefined, undefined]);
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

// Rewrites the run's implementation artifact with these lines under its file list.
function writeListed(dir, lines) {
  writeFileSync(join(dir, "04-implementation.md"), `# Implementation\n\n## Modified files\n${lines.join("\n")}\n`);
}

// Writes one file of the worktree, creating the directory it lives in.
function writeInWorktree(worktree, path, body = "content\n") {
  mkdirSync(join(worktree, path, ".."), { recursive: true });
  writeFileSync(join(worktree, path), body);
}

// HEAD and what is staged, which a refused call must leave as they were.
function gitPosition(worktree) {
  return [git(["-C", worktree, "rev-parse", "HEAD"]).trim(), git(["-C", worktree, "diff", "--cached", "--name-only"])];
}

test("`run publish` stages exactly the paths the implementation listed, past the prose left in the list, and leaves the rest of the worktree alone", async (t) => {
  const { env, id, worktree, dir } = makeRun(t, "publish-listed", { listed: ["src/slug.mjs", "docs/b.md"] });
  writeInWorktree(worktree, "noise.md");
  writeListed(dir, [join(worktree, "src/slug.mjs"), "", "The list is the whole worktree as `git ls-files --modified` reports it", "(58 paths, `tmp/` excluded).", "", "- `docs/b.md`"]);

  const { code, out, errText } = await runCli(env, id, publishArgs(dir));

  assert.equal(code, 0, `${out.join("\n")}\n${errText}`);
  assert.match(out[1], /^COMMITTED: [0-9a-f]+ \(2 files\)$/);
  assert.deepEqual(git(["-C", worktree, "show", "--name-only", "--format=", "HEAD"]).split("\n").filter(Boolean).sort(), ["docs/b.md", "src/slug.mjs"]);
  assert.match(git(["-C", worktree, "status", "--porcelain"]), /\?\? noise\.md/);
});

test("[R4] `run publish` refuses `.claude/`, a lockfile, `tmp/` and a path outside the worktree, and `--extra` never overrides it", async (t) => {
  const { env, id, worktree, dir } = makeRun(t, "publish-refusals");
  writeInWorktree(worktree, ".claude/settings.json", "{}\n");
  writeInWorktree(worktree, "tmp/scratch.mjs");
  writeInWorktree(worktree, "package-lock.json", "{}\n");
  const position = gitPosition(worktree);

  writeListed(dir, [join(worktree, ".claude/settings.json"), "tmp/scratch.mjs", "/etc/passwd"]);
  const listed = await runCli(env, id, publishArgs(dir));
  assert.equal(listed.code, 1);
  assert.match(listed.out[0], /^REFUSED: \.claude\/settings\.json \(under `\.claude\/`\), tmp\/scratch\.mjs \(under `tmp\/`\), \/etc\/passwd \(outside the worktree /);
  assert.match(listed.out[1], /`--extra` adds files to the list, it never overrides this refusal/);

  writeListed(dir, ["src/slug.mjs"]);
  const lockfile = await runCli(env, id, publishArgs(dir, ["--extra", "package-lock.json"]));
  assert.equal(lockfile.code, 1);
  assert.equal(lockfile.out[0], "REFUSED: package-lock.json (a dependency lockfile)");
  assert.match(lockfile.out[1], /never overrides this refusal: stop here and record it as an open item/);

  const everything = await runCli(env, id, publishArgs(dir, ["--extra", "*"]));
  assert.equal(everything.code, 1);
  assert.match(everything.out[0], /^REFUSED: .*\.claude\/settings\.json \(under `\.claude\/`\)/);

  assert.deepEqual(gitPosition(worktree), position);
});

test("[R4] the refusal of `run publish` folds the case, because `.Claude/settings.json` is the very file `.claude/settings.json` on this filesystem", async (t) => {
  const { env, id, worktree, dir } = makeRun(t, "publish-refusal-case");
  writeInWorktree(worktree, ".claude/settings.json", "{}\n");
  writeInWorktree(worktree, "tmp/scratch.mjs");
  writeInWorktree(worktree, "package-lock.json", "{}\n");
  const position = gitPosition(worktree);

  writeListed(dir, [join(worktree, ".Claude/settings.json"), "TMP/scratch.mjs", "Package-Lock.json"]);
  const listed = await runCli(env, id, publishArgs(dir));
  assert.equal(listed.code, 1);
  assert.equal(listed.out[0], "REFUSED: .Claude/settings.json (under `.claude/`), TMP/scratch.mjs (under `tmp/`), Package-Lock.json (a dependency lockfile)");

  writeListed(dir, ["src/slug.mjs"]);
  const extra = await runCli(env, id, publishArgs(dir, ["--extra", ".Claude/*"]));
  assert.equal(extra.code, 1);
  assert.equal(extra.out[0], "REFUSED: .Claude/* (under `.claude/`)", "`--extra` in another case walked past the refusal");

  assert.deepEqual(gitPosition(worktree), position);
});

test("`run publish` inside a job with a job block commits on an unavailable database, the message untouched", async (t) => {
  const { env, id, worktree, dir, projectId } = makeRun(t, "publish-sick-home");
  const block = { id, projectKey: "AP", createdAt: new Date().toISOString() };
  assert.equal(recordJobBlock({ projectId, slug: SLUG, block, env }).status, "written");
  const sick = makeSickHome(env);
  t.after(() => sick.restore());

  await runCli(env, id, publishArgs(dir));

  assert.equal(git(["-C", worktree, "log", "-1", "--format=%B"]).trimEnd(), MESSAGE.trimEnd());
});

test("`run publish` inside a job with no job block on an unavailable database refuses with the store error and commits nothing", async (t) => {
  const { env, id, worktree, dir } = makeRun(t, "publish-sick-home-no-block");
  const position = gitPosition(worktree);
  const sick = makeSickHome(env);
  t.after(() => sick.restore());

  const { code, errText } = await runCli(env, id, publishArgs(dir));

  assert.equal(code, 1);
  assert.match(errText, /the nightqueue database at .* is unavailable \(SQLITE_NOTADB/);
  assert.deepEqual(gitPosition(worktree), position);
});

test("`run publish` commits the agent's message untouched, a Markdown rule or a bare subject adding no trailer, and never edits its file", async (t) => {
  const messages = [
    ["rule", "feat: x\n\nbody\n---\nmore\n"],
    ["subject", "feat: x"],
  ];
  for (const [name, message] of messages) {
    const { env, id, worktree, dir } = makeRun(t, `publish-untouched-${name}`);
    writeFileSync(join(dir, "commit-message.txt"), message);

    const { code, out, errText } = await runCli(env, id, publishArgs(dir));

    assert.equal(code, 0, `${out.join("\n")}\n${errText}`);
    assert.equal(git(["-C", worktree, "log", "-1", "--format=%B"]).trimEnd(), message.trimEnd(), name);
    assert.equal(git(["-C", worktree, "log", "-1", "--format=%(trailers:key=Refs,valueonly)"]).trim(), "", name);
    assert.equal(readFileSync(join(dir, "commit-message.txt"), "utf8"), message, `the agent's message file was edited: ${name}`);
  }
});

test("a message carrying a `Refs:` line is rejected naming the line, and nothing is staged or committed", async (t) => {
  const cases = [
    ["feat: x\n\nRefs: AP-1\n", "line 3 is a `Refs:` trailer, which is reserved and never written by an agent"],
    ["feat: x\n\nbody\n\n  refs : AP-1  \n", "line 5 is a `Refs:` trailer, which is reserved and never written by an agent"],
  ];
  for (const [index, [message, reason]] of cases.entries()) {
    const { env, id, worktree, dir } = makeRun(t, `publish-refs-${index}`);
    writeFileSync(join(dir, "commit-message.txt"), message);
    const position = gitPosition(worktree);

    const refused = await runCli(env, id, publishArgs(dir));

    assert.equal(refused.code, 1);
    assert.ok(refused.out.includes(`REJECTED: commit message — ${reason}`), refused.out.join("\n"));
    assert.deepEqual(gitPosition(worktree), position);
    assert.deepEqual(ghCalls(env), []);
  }
});

test("`run publish` refuses a missing or empty message, an empty list, an extra nothing matches and a path that never existed", async (t) => {
  const { env, id, worktree, dir } = makeRun(t, "publish-usage");
  const body = join(dir, "pr-body.md");
  const before = commitCount(worktree);

  const noMessage = await runCli(env, id, ["run", "publish", "--body-file", body]);
  assert.equal(noMessage.code, 1);
  assert.match(noMessage.errText, /`--message-file <path>` is required: the commit message is the agent's/);

  const empty = join(dir, "empty-message.txt");
  writeFileSync(empty, "   \n");
  const emptyMessage = await runCli(env, id, ["run", "publish", "--message-file", empty, "--body-file", body]);
  assert.match(emptyMessage.errText, /the commit message at .*empty-message\.txt is empty/);

  const emptyList = join(dir, "empty-list.md");
  writeFileSync(emptyList, "# Implementation\n\n## Modified files\n\n## Notes\n\nnone\n");
  const nothing = await runCli(env, id, publishArgs(dir, ["--files-from", emptyList]));
  assert.match(nothing.errText, /lists no file under `## Modified files`: there is nothing to commit/);

  const unmatched = await runCli(env, id, publishArgs(dir, ["--extra", "docs/*.md"]));
  assert.match(unmatched.errText, /`--extra docs\/\*\.md` matches no file in /);

  writeListed(dir, ["src/missing.mjs"]);
  const missing = await runCli(env, id, publishArgs(dir));
  assert.equal(missing.code, 1);
  assert.deepEqual(missing.out.slice(0, 2), ["REFUSED: src/missing.mjs (not in the worktree, the index or HEAD)", EXTRA_IS_NOT_AN_OVERRIDE]);
  assert.equal(commitCount(worktree), before);
});

test("`run publish` stages from the list `run check 04` derived when the implementation artifact lists no file", async (t) => {
  const { env, id, worktree, dir } = makeRun(t, "publish-derived");
  writeFileSync(join(dir, "04-implementation.md"), "# Implementation\n\n## Done\nno list\n");
  writeFileSync(join(dir, "04-files.generated.md"), `# Implementation (derived from git)\n\n## Modified files\n${join(worktree, "src/slug.mjs")}\n`);

  const { code, out, errText } = await runCli(env, id, publishArgs(dir));

  assert.equal(code, 0, `${out.join("\n")}\n${errText}`);
  assert.match(out[1], /^COMMITTED: [0-9a-f]+ \(1 files\)$/);
  assert.equal(readFileSync(join(dir, "04-implementation.md"), "utf8"), "# Implementation\n\n## Done\nno list\n");
});

// Commits tracked files on the run's branch and pushes them as the remote's main, the base the branch is compared with.
function commitOnBase(worktree, files) {
  for (const [path, body] of Object.entries(files)) writeInWorktree(worktree, path, body);
  git(["-C", worktree, "add", "--", ...Object.keys(files)]);
  git(["-C", worktree, "-c", "commit.gpgsign=false", "commit", "-q", "--no-verify", "-m", "chore: tracked files"]);
  git(["-C", worktree, "push", "-q", "origin", "HEAD:main"]);
}

// True when HEAD's tree still holds the path.
function inHead(worktree, path) {
  return git(["-C", worktree, "ls-tree", "--name-only", "HEAD", "--", path]).trim() !== "";
}

test("a staged deletion the list names is published: the commit removes the file and the outcome lists it", async (t) => {
  const { env, id, worktree, dir, projectId } = makeRun(t, "publish-staged-deletion");
  commitOnBase(worktree, { "old.txt": "old\n" });
  git(["-C", worktree, "rm", "-q", "old.txt"]);
  writeListed(dir, ["src/slug.mjs", "old.txt"]);

  const { code, out, errText } = await runCli(env, id, publishArgs(dir));

  assert.equal(code, 0, `${out.join("\n")}\n${errText}`);
  assert.match(out[1], /^COMMITTED: [0-9a-f]+ \(2 files\)$/);
  assert.deepEqual(headFiles(worktree), ["old.txt", "src/slug.mjs"]);
  assert.equal(inHead(worktree, "old.txt"), false);
  assert.ok(readRunState({ projectId, slug: SLUG, env }).outcome.files.includes("old.txt"));
});

test("an unstaged deletion the list names is staged and published", async (t) => {
  const { env, id, worktree, dir } = makeRun(t, "publish-unstaged-deletion");
  commitOnBase(worktree, { "old.txt": "old\n" });
  rmSync(join(worktree, "old.txt"));
  writeListed(dir, ["src/slug.mjs", "old.txt"]);

  const { code, out, errText } = await runCli(env, id, publishArgs(dir));

  assert.equal(code, 0, `${out.join("\n")}\n${errText}`);
  assert.deepEqual(headFiles(worktree), ["old.txt", "src/slug.mjs"]);
  assert.equal(inHead(worktree, "old.txt"), false);
  assert.equal(git(["-C", worktree, "status", "--short"]).trim(), "");
});

test("a listed directory removed from disk and not staged is published as a deletion", async (t) => {
  const { env, id, worktree, dir } = makeRun(t, "publish-unstaged-dir-deletion");
  commitOnBase(worktree, { "dir/a.txt": "a\n", "dir/b.txt": "b\n" });
  rmSync(join(worktree, "dir"), { recursive: true });
  writeListed(dir, ["src/slug.mjs", "dir"]);

  const { code, out, errText } = await runCli(env, id, publishArgs(dir));

  assert.equal(code, 0, `${out.join("\n")}\n${errText}`);
  assert.equal(inHead(worktree, "dir"), false);
  assert.equal(git(["-C", worktree, "status", "--short"]).trim(), "");
});

test("`--extra` over a directory whose files were all `git rm`'d matches the staged deletions", async (t) => {
  const { env, id, worktree, dir } = makeRun(t, "publish-extra-deletions");
  commitOnBase(worktree, { "dir/a.txt": "a\n", "dir/b.txt": "b\n" });
  git(["-C", worktree, "rm", "-q", "-r", "dir"]);

  const { code, out, errText } = await runCli(env, id, publishArgs(dir, ["--extra", "dir/**"]));

  assert.equal(code, 0, `${out.join("\n")}\n${errText}`);
  assert.deepEqual(headFiles(worktree), ["dir/a.txt", "dir/b.txt", "src/slug.mjs"]);
  assert.equal(inHead(worktree, "dir"), false);
});

test("a listed path that never existed is refused before anything is committed or pushed", async (t) => {
  const made = makeRun(t, "publish-never-existed");
  writeListed(made.dir, ["src/slug.mjs", "src/never.mjs"]);

  await assertRefused(made, "REFUSED: src/never.mjs (not in the worktree, the index or HEAD)");
});

test("a listed path with glob characters is staged literally, never as a pattern", async (t) => {
  const { env, id, worktree, dir } = makeRun(t, "publish-literal-path");
  commitOnBase(worktree, { "a[1].txt": "one\n", "a1.txt": "one\n" });
  writeInWorktree(worktree, "a[1].txt", "two\n");
  writeInWorktree(worktree, "a1.txt", "two\n");
  writeListed(dir, ["src/slug.mjs", "a[1].txt"]);

  const { code, out, errText } = await runCli(env, id, publishArgs(dir));

  assert.equal(code, 0, `${out.join("\n")}\n${errText}`);
  assert.deepEqual(headFiles(worktree), ["a[1].txt", "src/slug.mjs"]);
  assert.equal(git(["-C", worktree, "status", "--porcelain", "--", "a1.txt"]).trim(), "M a1.txt");
});

test("a deletion the wip carries and the list names is folded once into the delivery", async (t) => {
  const { env, id, worktree, dir } = makeRun(t, "publish-wip-deletion");
  commitOnBase(worktree, { "gone.txt": "tracked\n" });
  git(["-C", worktree, "rm", "-q", "gone.txt"]);
  commitOwnWip(worktree);
  writeListed(dir, ["src/slug.mjs", "gone.txt"]);

  const { code, out, errText } = await runCli(env, id, publishArgs(dir));

  assert.equal(code, 0, `${out.join("\n")}\n${errText}`);
  assert.ok(out.some((line) => line.startsWith("FOLDED: 1 wip commits")), out.join("\n"));
  assert.equal(git(["-C", worktree, "rev-list", "--count", "origin/main..HEAD"]).trim(), "1");
  assert.deepEqual(headFiles(worktree), ["gone.txt", "notes.txt", "src/slug.mjs"]);
  assert.equal(inHead(worktree, "gone.txt"), false);
});

test("a retry after a delivery that deleted a file reads as already committed, never as a path that never existed", async (t) => {
  const { env, id, worktree, dir } = makeRun(t, "publish-deletion-retry");
  commitOnBase(worktree, { "old.txt": "old\n" });
  git(["-C", worktree, "rm", "-q", "old.txt"]);
  writeListed(dir, ["src/slug.mjs", "old.txt"]);
  const first = await runCli(env, id, publishArgs(dir));
  assert.equal(first.code, 0, `${first.out.join("\n")}\n${first.errText}`);
  const before = commitCount(worktree);

  const { code, out, errText } = await runCli(env, id, publishArgs(dir));

  assert.equal(code, 0, `${out.join("\n")}\n${errText}`);
  assert.match(out[1], /^COMMITTED: [0-9a-f]+ \(already committed\)$/);
  assert.equal(commitCount(worktree), before);
});
