import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { runDir } from "../src/config/paths.mjs";
import { run } from "../src/cli/index.mjs";
import { frozenInstall } from "../src/cli/frozen-install.mjs";
import { stageable } from "../src/cli/run-publish.mjs";
import { openDb } from "../src/memory/db.mjs";
import { addJob } from "../src/memory/jobs.mjs";
import { recordJobBlock, recordRunFields } from "../src/queue/run-state.mjs";
import { initGitRepo } from "../test-support/git.mjs";
import { makeSickHome } from "../test-support/sick-home.mjs";
import { ensureProject, makeDir, makeHome, makeProject } from "../test-support/memory.mjs";

const SLUG = "fix-the-worker";

// A git environment that depends on nothing of the machine: no global or system configuration, and an identity of its own.
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

// A home with one registered project, the queue table ready and a git that reads no configuration of the host.
function makeQueue(t, name) {
  const env = { ...makeHome(t, name), ...gitVars() };
  makeProject(t, env, "alpha");
  return env;
}

// A claimed job bound to its run slug, with a real git worktree recorded as the place the run works in.
function boundRun(t, env) {
  const id = addJob({ projectId: ensureProject(env, "alpha"), prompt: "fix the worker" }, env).id;
  openDb(env).prepare("UPDATE jobs SET slug = ? WHERE id = ?").run(SLUG, id);
  const repo = initGitRepo(makeDir(t, "worktree"));
  recordRunFields({ projectId: ensureProject(env, "alpha"), slug: SLUG, fields: { worktree: repo }, env });
  return { id, repo };
}

// Runs the CLI in this process, as the job the run belongs to.
async function runCli(env, argv, { jobId }) {
  const out = [];
  const err = [];
  const code = await run(argv, {
    env: jobId === null ? env : { ...env, NIGHTQUEUE_JOB_ID: String(jobId) },
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    stdout: { write: () => {} },
  });
  return { code, out, err, text: out.join("\n"), errText: err.join("\n") };
}

// Writes a file of the repository, creating the directory it lives in.
function writeIn(repo, path, body = "content\n") {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), body);
  return join(repo, path);
}

// Writes the implementation artifact of the run, which is the only list `run commit` stages from.
function writeImplementation(env, files) {
  const dir = runDir(ensureProject(env, "alpha"), SLUG, env);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "04-implementation.md"), `# Implementation\n\n## Modified files\n${files.join("\n")}\n`);
}

// Writes the commit message the agent wrote, the one the command is never allowed to invent.
function writeMessage(t, name, body) {
  const path = join(makeDir(t, name), "message.txt");
  writeFileSync(path, body);
  return path;
}

// What the repository really recorded in its last commit: the subject and the files it touched.
function lastCommit(repo) {
  const subject = execFileSync("git", ["-C", repo, "log", "-1", "--format=%s"], { encoding: "utf8" }).trim();
  const files = execFileSync("git", ["-C", repo, "show", "--name-only", "--format=", "HEAD"], { encoding: "utf8" });
  return { subject, files: files.split("\n").filter(Boolean).sort() };
}

test("`run commit` stages exactly what the implementation listed, prints the convention and commits the agent's message", async (t) => {
  const env = makeQueue(t, "run-commit-happy");
  const { id, repo } = boundRun(t, env);
  writeIn(repo, "commitlint.config.js", "module.exports = {};\n");
  writeIn(repo, "src/a.mjs");
  writeIn(repo, "docs/b.md");
  writeIn(repo, "noise.md");
  writeImplementation(env, [join(repo, "src/a.mjs"), `- \`docs/b.md\``]);
  const message = writeMessage(t, "run-commit-message", "feat(cli): commit what the run listed\n\nthe body of the message\n");

  const { code, out } = await runCli(env, ["run", "commit", "--message-file", message], { jobId: id });

  assert.equal(code, 0);
  assert.match(out[0], /^CONVENTION: declared by commitlint\.config\.js; free-form subjects in the last 1 commits \(e\.g\. `init`\)$/);
  assert.match(out[1], /^COMMITTED: [0-9a-f]{7,} \(2 files\)$/);
  assert.deepEqual(lastCommit(repo), { subject: "feat(cli): commit what the run listed", files: ["docs/b.md", "src/a.mjs"] });
  const status = execFileSync("git", ["-C", repo, "status", "--porcelain"], { encoding: "utf8" });
  assert.match(status, /\?\? noise\.md/);
});

test("`run commit` ignores the prose an agent leaves inside `## Modified files` and stages only the paths", async (t) => {
  const env = makeQueue(t, "run-commit-prose");
  const { id, repo } = boundRun(t, env);
  writeIn(repo, "src/a.mjs");
  writeIn(repo, "docs/b.md");
  writeImplementation(env, [
    join(repo, "src/a.mjs"),
    "",
    "The list is the whole worktree as `git ls-files --modified` reports it",
    "(58 paths, `tmp/` excluded): the 49 of Units 1-16 plus the four QA PoCs.",
    "",
    `- \`docs/b.md\``,
  ]);
  const message = writeMessage(t, "run-commit-prose-message", "refactor(cli): stage past the prose\n");

  const { code, out } = await runCli(env, ["run", "commit", "--message-file", message], { jobId: id });

  assert.equal(code, 0, out.join("\n"));
  assert.match(out[1], /^COMMITTED: [0-9a-f]{7,} \(2 files\)$/);
  assert.deepEqual(lastCommit(repo).files, ["docs/b.md", "src/a.mjs"]);
});

test("[R4] `run commit` refuses `.claude/`, a lockfile, `tmp/` and a path outside the worktree, and `--extra` never overrides it", async (t) => {
  const env = makeQueue(t, "run-commit-refusals");
  const { id, repo } = boundRun(t, env);
  writeIn(repo, "src/a.mjs");
  writeIn(repo, ".claude/settings.json", "{}\n");
  writeIn(repo, "tmp/scratch.mjs");
  writeIn(repo, "package-lock.json", "{}\n");
  const message = writeMessage(t, "run-commit-refused-message", "chore: nothing\n");
  const head = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();

  writeImplementation(env, [join(repo, ".claude/settings.json"), "tmp/scratch.mjs", "/etc/passwd"]);
  const listed = await runCli(env, ["run", "commit", "--message-file", message], { jobId: id });
  assert.equal(listed.code, 1);
  assert.match(listed.out[0], /^REFUSED: \.claude\/settings\.json \(under `\.claude\/`\), tmp\/scratch\.mjs \(under `tmp\/`\), \/etc\/passwd \(outside the worktree /);
  assert.match(listed.out[1], /`--extra` adds files to the list, it never overrides this refusal/);

  writeImplementation(env, ["src/a.mjs"]);
  const lockfile = await runCli(env, ["run", "commit", "--message-file", message, "--extra", "package-lock.json"], { jobId: id });
  assert.equal(lockfile.code, 1);
  assert.equal(lockfile.out[0], "REFUSED: package-lock.json (a dependency lockfile)");
  assert.match(lockfile.out[1], /never overrides this refusal: stop here and record it as an open item/);

  const everything = await runCli(env, ["run", "commit", "--message-file", message, "--extra", "*"], { jobId: id });
  assert.equal(everything.code, 1);
  assert.match(everything.out[0], /^REFUSED: .*\.claude\/settings\.json \(under `\.claude\/`\)/);

  assert.equal(execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(), head);
  assert.equal(execFileSync("git", ["-C", repo, "diff", "--cached", "--name-only"], { encoding: "utf8" }), "");
});

test("[R4] the refusal folds the case, because `.Claude/settings.json` is the very file `.claude/settings.json` on this filesystem", async (t) => {
  const env = makeQueue(t, "run-commit-case");
  const { id, repo } = boundRun(t, env);
  writeIn(repo, ".claude/settings.json", "{}\n");
  writeIn(repo, "tmp/scratch.mjs");
  writeIn(repo, "package-lock.json", "{}\n");
  const message = writeMessage(t, "run-commit-case-message", "chore: nothing\n");
  const head = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();

  writeImplementation(env, [join(repo, ".Claude/settings.json"), "TMP/scratch.mjs", "Package-Lock.json"]);
  const listed = await runCli(env, ["run", "commit", "--message-file", message], { jobId: id });
  assert.equal(listed.code, 1);
  assert.equal(
    listed.out[0],
    "REFUSED: .Claude/settings.json (under `.claude/`), TMP/scratch.mjs (under `tmp/`), Package-Lock.json (a dependency lockfile)",
  );

  writeImplementation(env, ["src/a.mjs"]);
  const extra = await runCli(env, ["run", "commit", "--message-file", message, "--extra", ".Claude/*"], { jobId: id });
  assert.equal(extra.code, 1);
  assert.equal(extra.out[0], "REFUSED: .Claude/* (under `.claude/`)", "`--extra` in another case walked past the refusal");

  assert.equal(execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(), head);
  assert.equal(execFileSync("git", ["-C", repo, "diff", "--cached", "--name-only"], { encoding: "utf8" }), "");
});

// The full message of the last commit and the trailers git itself parses out of it.
function lastMessage(repo) {
  const body = execFileSync("git", ["-C", repo, "log", "-1", "--format=%B"], { encoding: "utf8" }).trimEnd();
  const trailers = execFileSync("git", ["-C", repo, "log", "-1", "--format=%(trailers)"], { encoding: "utf8" }).trim();
  return { body, trailers: trailers.split("\n").filter(Boolean) };
}

// A run whose one listed file is ready to commit, with the message the agent wrote.
function readyCommit(t, env, repo, name, message) {
  writeIn(repo, "src/a.mjs");
  writeImplementation(env, ["src/a.mjs"]);
  return writeMessage(t, name, message);
}

const CO_AUTHORED = "feat: ship it\n\nRefs are resolved at the edge.\n\nCo-Authored-By: Someone <someone@example.invalid>\n";

test("`run commit` inside a job with a job block commits on an unavailable database, the message untouched", async (t) => {
  const env = makeQueue(t, "run-commit-sick-home");
  const { id, repo } = boundRun(t, env);
  const block = { id, projectKey: "AP", createdAt: new Date().toISOString() };
  assert.equal(recordJobBlock({ projectId: ensureProject(env, "alpha"), slug: SLUG, block, env }).status, "written");
  const message = readyCommit(t, env, repo, "run-commit-sick-home-message", "feat: ship it\n");
  const sick = makeSickHome(env);
  t.after(() => sick.restore());

  const { code, text, errText } = await runCli(env, ["run", "commit", "--message-file", message], { jobId: id });

  assert.equal(code, 0, `${text}\n${errText}`);
  assert.deepEqual(lastMessage(repo), { body: "feat: ship it", trailers: [] });
});

test("`run commit` inside a job with no job block on an unavailable database refuses with the store error and commits nothing", async (t) => {
  const env = makeQueue(t, "run-commit-sick-home-no-block");
  const { id, repo } = boundRun(t, env);
  const head = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const message = readyCommit(t, env, repo, "run-commit-sick-home-no-block-message", "feat: ship it\n");
  const sick = makeSickHome(env);
  t.after(() => sick.restore());

  const { code, errText } = await runCli(env, ["run", "commit", "--message-file", message], { jobId: id });

  assert.equal(code, 1);
  assert.match(errText, /the nightqueue database at .* is unavailable \(SQLITE_NOTADB/);
  assert.equal(execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(), head);
});

test("`run commit` inside a job, or outside the queue, commits the message untouched and never edits the agent's file", async (t) => {
  const env = makeQueue(t, "run-commit-free");
  const { id, repo } = boundRun(t, env);
  const inside = readyCommit(t, env, repo, "run-commit-free-message", CO_AUTHORED);
  assert.equal((await runCli(env, ["run", "commit", "--message-file", inside], { jobId: id })).code, 0);
  assert.deepEqual(lastMessage(repo), { body: CO_AUTHORED.trimEnd(), trailers: ["Co-Authored-By: Someone <someone@example.invalid>"] });
  assert.equal(readFileSync(inside, "utf8"), CO_AUTHORED, "the agent's message file was edited");

  writeIn(repo, "src/a.mjs", "changed\n");
  const outside = writeMessage(t, "run-commit-outside-message", "fix: outside\n");
  const operator = await runCli(env, ["run", "commit", "--message-file", outside, "--project", "alpha", "--slug", SLUG], { jobId: null });
  assert.equal(operator.code, 0, `${operator.text}\n${operator.errText}`);
  assert.equal(lastMessage(repo).body, "fix: outside");
});

test("a message carrying a `Refs:` line is REFUSED naming the line, and nothing is staged or committed", async (t) => {
  const env = makeQueue(t, "run-commit-refs");
  const { id, repo } = boundRun(t, env);
  const head = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const cases = [
    ["feat: x\n\nRefs: AP-1\n", "line 3 of the message is a `Refs:` trailer, which is reserved and never written by an agent: Refs: AP-1"],
    ["feat: x\n\nbody\n\n  refs : AP-1  \n", "line 5 of the message is a `Refs:` trailer, which is reserved and never written by an agent: refs : AP-1"],
  ];
  for (const [index, [body, reason]] of cases.entries()) {
    const message = readyCommit(t, env, repo, `run-commit-refs-${index}`, body);
    const refused = await runCli(env, ["run", "commit", "--message-file", message], { jobId: id });
    assert.equal(refused.code, 1);
    assert.deepEqual(refused.out, [`REFUSED: ${reason}`]);
  }

  assert.equal(execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(), head);
  assert.equal(execFileSync("git", ["-C", repo, "diff", "--cached", "--name-only"], { encoding: "utf8" }), "");
});

test("`run commit` refuses a missing or empty message, an empty list, an extra nothing matches and a file git cannot stage", async (t) => {
  const env = makeQueue(t, "run-commit-usage");
  const { id, repo } = boundRun(t, env);
  writeImplementation(env, ["src/a.mjs"]);
  const message = writeMessage(t, "run-commit-usage-message", "chore: nothing\n");

  const noMessage = await runCli(env, ["run", "commit"], { jobId: id });
  assert.equal(noMessage.code, 1);
  assert.match(noMessage.errText, /`--message-file <path>` is required: the commit message is the agent's/);

  const empty = writeMessage(t, "run-commit-empty-message", "   \n");
  const emptyMessage = await runCli(env, ["run", "commit", "--message-file", empty], { jobId: id });
  assert.match(emptyMessage.errText, /the commit message at .*message\.txt is empty/);

  const emptyList = join(makeDir(t, "run-commit-empty-list"), "04-implementation.md");
  writeFileSync(emptyList, "# Implementation\n\n## Modified files\n\n## Notes\n\nnone\n");
  const nothing = await runCli(env, ["run", "commit", "--message-file", message, "--files-from", emptyList], { jobId: id });
  assert.match(nothing.errText, /lists no file under `## Modified files`: there is nothing to commit/);

  const unmatched = await runCli(env, ["run", "commit", "--message-file", message, "--extra", "docs/*.md"], { jobId: id });
  assert.match(unmatched.errText, /`--extra docs\/\*\.md` matches no file in /);

  const missing = await runCli(env, ["run", "commit", "--message-file", message], { jobId: id });
  assert.equal(missing.code, 1);
  assert.match(missing.errText, /git could not stage the list in .*: .*src\/a\.mjs/);
  assert.equal(execFileSync("git", ["-C", repo, "log", "--format=%s"], { encoding: "utf8" }).trim(), "init");
});

// A repository whose base branch carries a manifest and its lockfile, with the worktree then changing the files named in `changes`.
function repoWithLockedBase(t, name, changes) {
  const env = makeQueue(t, name);
  const repo = initGitRepo(makeDir(t, name));
  writeIn(repo, "package.json", '{"name":"x"}\n');
  writeIn(repo, "package-lock.json", "{}\n");
  writeIn(repo, "yarn.lock", "# yarn\n");
  execFileSync("git", ["-C", repo, "add", "."], { env: { ...process.env, ...env } });
  execFileSync("git", ["-C", repo, "-c", "commit.gpgsign=false", "commit", "-q", "-m", "base"], { env: { ...process.env, ...env } });
  for (const [path, body] of Object.entries(changes)) writeIn(repo, path, body);
  return { env, repo };
}

// An installer that records what it was asked and answers a fixed result, so no unit test installs from the network.
function fakeInstaller(result) {
  const calls = [];
  return { calls, install: (request) => (calls.push(request.manager), result) };
}

test("a publish set with a changed manifest, a changed lockfile and a green frozen install includes the lockfile", (t) => {
  const { env, repo } = repoWithLockedBase(t, "lock-green", { "package.json": '{"name":"x","devDependencies":{"y":"1"}}\n', "package-lock.json": '{"y":1}\n' });
  const { install, calls } = fakeInstaller({ ok: true, command: "npm ci --ignore-scripts", tail: "" });

  const result = stageable({ cwd: repo, listed: ["package.json", "package-lock.json"], extras: [], env, install });

  assert.deepEqual(result.refused, []);
  assert.deepEqual(result.paths, ["package.json", "package-lock.json"]);
  assert.deepEqual(calls, ["npm"]);
});

test("a changed manifest with an unchanged lockfile is refused with the manager's own install command, and no install runs", (t) => {
  const { env, repo } = repoWithLockedBase(t, "lock-same", { "package.json": '{"name":"x","devDependencies":{"y":"1"}}\n' });
  const { install, calls } = fakeInstaller({ ok: true, command: "npm ci", tail: "" });

  const npm = stageable({ cwd: repo, listed: ["package.json", "package-lock.json"], extras: [], env, install });
  assert.equal(npm.refused[0].reason, "manifest changed but the lockfile did not: run npm install");
  const yarn = stageable({ cwd: repo, listed: ["package.json", "yarn.lock"], extras: [], env, install });
  assert.equal(yarn.refused[0].reason, "manifest changed but the lockfile did not: run yarn install");
  assert.deepEqual(calls, []);
});

test("a changed lockfile without a changed manifest is refused as a dependency lockfile", (t) => {
  const { env, repo } = repoWithLockedBase(t, "lock-alone", { "package-lock.json": '{"y":1}\n' });
  const { install, calls } = fakeInstaller({ ok: true, command: "npm ci", tail: "" });

  const alone = stageable({ cwd: repo, listed: ["package-lock.json"], extras: [], env, install });
  assert.deepEqual(alone.refused.map((entry) => entry.reason), ["a dependency lockfile"]);
  const unchangedManifest = stageable({ cwd: repo, listed: ["package.json", "package-lock.json"], extras: [], env, install });
  assert.deepEqual(unchangedManifest.refused.map((entry) => entry.reason), ["a dependency lockfile"]);
  assert.deepEqual(calls, []);
});

test("a manifest and a lockfile whose frozen install fails are refused with the tail of the output", (t) => {
  const { env, repo } = repoWithLockedBase(t, "lock-red", { "package.json": '{"name":"x","dependencies":{"y":"1"}}\n', "package-lock.json": '{"y":1}\n' });
  const { install } = fakeInstaller({ ok: false, command: "npm ci --ignore-scripts", tail: "npm error missing: y@1 from lock file" });

  const result = stageable({ cwd: repo, listed: ["package.json", "package-lock.json"], extras: [], env, install });

  assert.deepEqual(result.paths, []);
  assert.equal(result.refused[0].reason, "`npm ci --ignore-scripts` failed: npm error missing: y@1 from lock file");
});

test("the frozen install of a yarn pair runs yarn, under the run's Bash default timeout, and reports pass, fail and the tail", (t) => {
  const env = makeHome(t, "frozen-install");
  const seen = [];
  const spawnWith = (result) => (file, args, options) => (seen.push({ file, args, cwd: options.cwd, timeout: options.timeout }), result);

  const green = frozenInstall({ manager: "yarn", cwd: "/w", env, spawnSyncImpl: spawnWith({ status: 0, stdout: "ok", stderr: "" }) });
  const red = frozenInstall({ manager: "pnpm", cwd: "/w", env, spawnSyncImpl: spawnWith({ status: 1, stdout: "", stderr: "a\nb\nERR_PNPM_OUTDATED_LOCKFILE\n" }) });
  const missing = frozenInstall({ manager: "bun", cwd: "/w", env, spawnSyncImpl: spawnWith({ status: null, error: { message: "spawn bun ENOENT" } }) });

  assert.equal(green.ok, true);
  assert.deepEqual(seen[0], { file: "yarn", args: ["install", "--frozen-lockfile", "--ignore-scripts"], cwd: "/w", timeout: 900000 });
  assert.deepEqual([red.ok, red.tail], [false, "a | b | ERR_PNPM_OUTDATED_LOCKFILE"]);
  assert.deepEqual([missing.ok, missing.tail], [false, "spawn bun ENOENT"]);
});
