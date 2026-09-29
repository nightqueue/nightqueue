import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { defaultContext, run } from "../src/cli/index.mjs";
import { initGitRepo } from "../test-support/git.mjs";
import { makeHostEnv } from "../test-support/host.mjs";
import { makeDir, registerCheckout } from "../test-support/memory.mjs";

// Git configuration that reads nothing of the machine's own ignore rules, so only the repository decides what is ignored.
const ISOLATED_GIT_VARS = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: "core.excludesFile",
  GIT_CONFIG_VALUE_0: "/dev/null",
};

// Subprocess runner that answers for `gh` instead of asking the real one, keeping the diagnosis hermetic.
function withFakeGh(file, args, options) {
  if (file !== "gh") return spawnSync(file, args, options);
  return { status: 0, stdout: "Logged in", stderr: "" };
}

// Runs the diagnosis in process with the given flags and returns the row of the project's exclude.
async function excludeRow(env, flags = []) {
  const out = [];
  const ctx = { ...defaultContext(), env, out: (line) => out.push(line), err: () => {}, spawnSyncImpl: withFakeGh };
  await run(["doctor", "--json", ...flags], ctx);
  return JSON.parse(out[0]).checks.find((check) => check.name === "exclude alpha");
}

// A host home with one registered real repository that does not ignore the Claude Code paths.
function makeRegisteredRepo(t, name) {
  const host = makeHostEnv(t, name);
  const env = { ...host.env, ...ISOLATED_GIT_VARS };
  const repo = initGitRepo(makeDir(t, `${name}-repo`));
  registerCheckout(env, { path: repo, name: "alpha" });
  return { env, repo, exclude: join(repo, ".git", "info", "exclude") };
}

test("doctor warns on a checkout whose exclude lacks the Claude Code paths, writes nothing without --fix, and --fix adds them", async (t) => {
  const { env, exclude } = makeRegisteredRepo(t, "doctor-exclude");
  const before = readFileSync(exclude, "utf8");

  const warned = await excludeRow(env);
  assert.deepEqual(
    { status: warned.status, hint: warned.hint },
    { status: "warn", hint: "run: nightqueue doctor --fix" },
  );
  assert.match(warned.detail, /\/\.claude\/worktrees\/, \/\.claude\/settings\.local\.json not ignored/);
  assert.equal(readFileSync(exclude, "utf8"), before, "a plain doctor wrote the exclude");

  const fixed = await excludeRow(env, ["--fix"]);
  assert.equal(fixed.status, "ok");
  assert.match(fixed.detail, /^added \/\.claude\/worktrees\/, \/\.claude\/settings\.local\.json to /);
  assert.equal(readFileSync(exclude, "utf8"), `${before}/.claude/worktrees/\n/.claude/settings.local.json\n`);

  const after = await excludeRow(env);
  assert.equal(after.status, "ok");
  assert.equal(readFileSync(exclude, "utf8").includes("\n.claude/\n"), false, "doctor ignored the whole .claude/");
});

test("doctor --fix on an exclude it cannot write warns with the command that appends the lines", { skip: process.getuid?.() === 0 }, async (t) => {
  const { env, repo, exclude } = makeRegisteredRepo(t, "doctor-exclude-readonly");
  const info = join(repo, ".git", "info");
  chmodSync(exclude, 0o444);
  chmodSync(info, 0o555);
  t.after(() => {
    chmodSync(info, 0o755);
    chmodSync(exclude, 0o644);
  });

  const row = await excludeRow(env, ["--fix"]);

  assert.equal(row.status, "warn");
  assert.match(row.detail, /cannot be written/);
  assert.match(row.hint, /^printf '%s\\n' '\/\.claude\/worktrees\/' '\/\.claude\/settings\.local\.json' >> '.*exclude'$/);
});
