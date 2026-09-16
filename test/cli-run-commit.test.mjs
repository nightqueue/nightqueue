import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { runDir } from "../src/config/paths.mjs";
import { run } from "../src/cli/index.mjs";
import { openDb } from "../src/memory/db.mjs";
import { addJob } from "../src/memory/jobs.mjs";
import { recordRunFields } from "../src/queue/run-state.mjs";
import { initGitRepo } from "../test-support/git.mjs";
import { makeDir, makeHome, makeProject } from "../test-support/memory.mjs";

const SLUG = "fix-the-worker";

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

// A home with one registered project, the queue table ready and a git that reads no configuration of the host.
function makeQueue(t, name) {
  const env = { ...makeHome(t, name), ...gitVars() };
  makeProject(t, env, "alpha");
  return env;
}

// A claimed job bound to its run slug, with a real git worktree recorded as the place the run works in.
function boundRun(t, env) {
  const id = addJob({ project: "alpha", prompt: "fix the worker" }, env).id;
  openDb(env).prepare("UPDATE jobs SET slug = ? WHERE id = ?").run(SLUG, id);
  const repo = initGitRepo(makeDir(t, "worktree"));
  recordRunFields({ project: "alpha", slug: SLUG, fields: { worktree: repo }, env });
  return { id, repo };
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

// Writes a file of the repository, creating the directory it lives in.
function writeIn(repo, path, body = "content\n") {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), body);
  return join(repo, path);
}

// Writes the implementation artifact of the run, which is the only list `run commit` stages from.
function writeImplementation(env, files) {
  const dir = runDir("alpha", SLUG, env);
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
