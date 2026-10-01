import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { runDir } from "../../src/config/paths.mjs";
import { run } from "../../src/cli/index.mjs";
import { openDb } from "../../src/memory/db.mjs";
import { addJob } from "../../src/memory/jobs.mjs";
import { linkIssueJob, saveIssue } from "../../src/memory/issues.mjs";
import { recordRunFields } from "../../src/queue/run-state.mjs";
import { initGitRepo } from "../../test-support/git.mjs";
import { ensureProject, makeDir, makeHome, makeProject, projectIdOf } from "../../test-support/memory.mjs";

const SLUG = "fix-the-worker";

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

// An issue job bound to its slug with a real worktree, one file ready to commit.
function issueRun(t, name) {
  const env = { ...makeHome(t, name), ...gitVars() };
  makeProject(t, env, "alpha");
  const id = addJob({ projectId: ensureProject(env, "alpha"), prompt: "fix the worker" }, env).id;
  openDb(env).prepare("UPDATE jobs SET slug = ? WHERE id = ?").run(SLUG, id);
  const repo = initGitRepo(makeDir(t, "worktree"));
  recordRunFields({ projectId: ensureProject(env, "alpha"), slug: SLUG, fields: { worktree: repo }, env });
  const item = saveIssue({ type: "feature", projectId: projectIdOf(env, "alpha"), title: "ship it" }, env);
  assert.equal(linkIssueJob(item.id, id, env), true);
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src/a.mjs"), "content\n");
  const dir = runDir(ensureProject(env, "alpha"), SLUG, env);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "04-implementation.md"), "# Implementation\n\n## Modified files\nsrc/a.mjs\n");
  return { env, id, repo };
}

// Commits the message as the job and returns what git recorded.
async function commitWith(t, name, message) {
  const { env, id, repo } = issueRun(t, name);
  const file = join(makeDir(t, `${name}-msg`), "message.txt");
  writeFileSync(file, message);
  const out = [];
  const code = await run(["run", "commit", "--message-file", file], {
    env: { ...env, NIGHTQUEUE_JOB_ID: String(id) },
    out: (line) => out.push(line),
    err: (line) => out.push(line),
    stdout: { write: () => {} },
  });
  assert.equal(code, 0, out.join("\n"));
  const git = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  return {
    refs: git("log", "-1", "--format=%(trailers:key=Refs,valueonly)").trim(),
    body: git("log", "-1", "--format=%B").trimEnd(),
  };
}

test("a Markdown rule (---) in the message does not move the Refs trailer out of the last block", async (t) => {
  const { refs, body } = await commitWith(
    t,
    "divider",
    "feat: x\n\nbody\n---\nmore\n\nCo-Authored-By: A <a@b.c>\n",
  );
  assert.equal(refs, "AP-1", `git did not see Refs as a trailer:\n${body}`);
  assert.ok(body.endsWith("Refs: AP-1"), `Refs is not at the end of the message:\n${body}`);
});

test("a subject-only message gets the Refs trailer as a trailer", async (t) => {
  const { refs, body } = await commitWith(t, "subject-only", "feat: x");
  assert.equal(refs, "AP-1", body);
});
