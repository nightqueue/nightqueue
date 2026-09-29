import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { run } from "../../src/cli/index.mjs";
import { runDir } from "../../src/config/paths.mjs";
import { ghBin } from "../../src/host/gh.mjs";
import { openDb } from "../../src/memory/db.mjs";
import { addJob } from "../../src/memory/jobs.mjs";
import { linkRoadmapItemJob, saveRoadmapItem } from "../../src/memory/roadmap.mjs";
import { recordRunFields } from "../../src/queue/run-state.mjs";
import { initGitRepo } from "../../test-support/git.mjs";
import { isolatedHostVars } from "../../test-support/host.mjs";
import { ensureProject, makeDir, makeHome, projectIdOf, registerCheckout } from "../../test-support/memory.mjs";

const SLUG = "login-google";
const BRANCH = "worktree-feat+login-google";

const BODY = [
  "## Report",
  "",
  "logging in with google failed for every user.",
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
  "| Automated | `npm test` | PASSED |",
  "",
  "Not tested: the real google consent screen; low risk, the callback is covered by the suite.",
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

// A roadmap job with a real worktree, a local bare remote and the fake gh installed.
function makeRun(t, name) {
  const remote = join(makeDir(t, `${name}-origin`), "origin.git");
  git(["-c", "init.defaultBranch=main", "init", "--bare", "-q", remote]);
  const checkout = initGitRepo(makeDir(t, `${name}-checkout`));
  git(["-C", checkout, "remote", "add", "origin", remote]);
  git(["-C", checkout, "push", "-q", "-u", "origin", "main"]);
  const worktree = join(makeDir(t, `${name}-worktrees`), BRANCH);
  git(["-C", checkout, "worktree", "add", "-q", "-b", BRANCH, worktree, "main"]);
  const env = { ...makeHome(t, name), ...isolatedHostVars(makeDir(t, `${name}-host`)), ...gitVars() };
  registerCheckout(env, { path: checkout, name: "alpha" });
  const id = addJob({ projectId: ensureProject(env, "alpha"), prompt: "log in with google" }, env).id;
  openDb(env).prepare("UPDATE jobs SET slug = ? WHERE id = ?").run(SLUG, id);
  recordRunFields({ projectId: ensureProject(env, "alpha"), slug: SLUG, fields: { worktree, type: "feature/refactor" }, env });
  const evidence = join(runDir(ensureProject(env, "alpha"), SLUG, env), "evidence");
  mkdirSync(evidence, { recursive: true });
  writeFileSync(join(evidence, "automated-verification.md"), "## Verification: PASSED\n\nnpm test: 12 passed\n");
  assert.equal(ghBin(env), env.NIGHTQUEUE_GH_BIN);
  assert.ok(existsSync(env.NIGHTQUEUE_GH_BIN) && (statSync(env.NIGHTQUEUE_GH_BIN).mode & 0o111) !== 0);
  const item = saveRoadmapItem({ type: "feature", projectId: projectIdOf(env, "alpha"), title: "log in with google" }, env);
  assert.equal(linkRoadmapItemJob(item.id, id, env), true);
  return { env, id };
}

// True when the text ends inside an unclosed HTML comment or fenced block.
function endsOpen(text) {
  if (text.lastIndexOf("<!--") > text.lastIndexOf("-->")) return "comment";
  let fence = null;
  for (const line of text.split("\n")) {
    const opener = /^\s*(`{3,}|~{3,})/.exec(line)?.[1] ?? null;
    if (fence !== null) {
      if (opener !== null && opener[0] === fence[0] && opener.length >= fence.length) fence = null;
    } else if (opener !== null) fence = opener;
  }
  return fence !== null ? "fence" : null;
}

// Publishes the body; the body is either refused, or its published footer must sit outside any open block.
async function attempt(t, name, body) {
  const { env, id } = makeRun(t, name);
  const file = join(makeDir(t, `${name}-body`), "body.md");
  writeFileSync(file, body);
  const out = [];
  const err = [];
  const code = await run(["run", "pr", "--body-file", file, "--title", "feat: x"], {
    env: { ...env, NIGHTQUEUE_JOB_ID: String(id) },
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    stdout: { write: () => {} },
  });
  if (code !== 0) return;
  const published = readFileSync(join(runDir(ensureProject(env, "alpha"), SLUG, env), "pr-body.published.md"), "utf8");
  const footerAt = published.lastIndexOf("Refs AP-1");
  assert.ok(footerAt > 0, published);
  assert.equal(endsOpen(published.slice(0, footerAt)), null, `the footer was published inside an open ${endsOpen(published.slice(0, footerAt))}:\n${published}`);
}

test("a body ending in an unclosed <!-- comment does not swallow the footer", async (t) => {
  await attempt(t, "pr-unclosed-comment", `${BODY}\n<!-- draft notes\n`);
});

test("a body ending in an unclosed fenced block does not swallow the footer", async (t) => {
  await attempt(t, "pr-unclosed-fence", `${BODY}\n\`\`\`text\nleft open\n`);
});
