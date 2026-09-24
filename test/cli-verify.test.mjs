import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { initGitRepo } from "../test-support/git.mjs";
import { makeDir, makeHome } from "../test-support/memory.mjs";

const CLI = fileURLToPath(new URL("../bin/nightqueue.mjs", import.meta.url));
const FAKE_PM = fileURLToPath(new URL("../test-support/fake-pm.mjs", import.meta.url));
const MANAGERS = ["npm", "pnpm", "yarn", "bun"];
const LOCKFILES = { npm: "package-lock.json", pnpm: "pnpm-lock.yaml", yarn: "yarn.lock", bun: "bun.lockb" };
const ORDER = ["typecheck", "lint", "build", "test", "poc", "diff-hygiene"];
const NEVER_INSTALLS = "dependencies not installed — nightqueue verify never installs";
const INSTALL_WORDS = ["install", "ci", "add", "--frozen-lockfile"];
const STATUS_LINE_RE = /^(PASSED|FAILED|SKIPPED) (\S+) (\d+\.\d+)s$/;
const GIT_IDENTITY = {
  GIT_AUTHOR_NAME: "nightqueue",
  GIT_AUTHOR_EMAIL: "nightqueue@example.invalid",
  GIT_COMMITTER_NAME: "nightqueue",
  GIT_COMMITTER_EMAIL: "nightqueue@example.invalid",
};

// Commits everything the fixture wrote, so the working tree the checks see is clean.
function commitAll(cwd) {
  execFileSync("git", ["-C", cwd, "add", "-A"]);
  execFileSync("git", ["-C", cwd, "-c", "commit.gpgsign=false", "commit", "-q", "-m", "fixture"], { env: { ...process.env, ...GIT_IDENTITY } });
}

// Working tree of the fixture, as the string the repository-untouched assertion compares.
function gitStatus(cwd) {
  return execFileSync("git", ["-C", cwd, "status", "--short"], { encoding: "utf8" });
}

// A fixture repository: a real git repo carrying one package.json, the lockfile of its package manager and nothing else uncommitted.
function makeFixture(t, name, { manager = "npm", scripts = {}, files = {}, workspaces = null } = {}) {
  const cwd = makeDir(t, `verify-${name}`);
  initGitRepo(cwd);
  const manifest = workspaces ? { name, version: "1.0.0", private: true, workspaces, scripts } : { name, version: "1.0.0", scripts };
  writeFileSync(join(cwd, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(join(cwd, LOCKFILES[manager]), "");
  for (const [path, content] of Object.entries(files)) {
    const target = join(cwd, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  commitAll(cwd);
  return cwd;
}

// Installs the fake package manager under the four names, on a directory of its own, plus the log the test reads back.
function installFakePm(t) {
  const dir = makeDir(t, "verify-pm");
  const shim = ["#!/usr/bin/env node", `import(${JSON.stringify(FAKE_PM)});`, ""].join("\n");
  for (const name of MANAGERS) writeFileSync(join(dir, name), shim, { mode: 0o755 });
  return { dir, log: join(dir, "calls.jsonl") };
}

// The calls the fake package manager recorded, one per invocation.
function readCalls(log) {
  if (!existsSync(log)) return [];
  return readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

// Runs `nightqueue verify` in the fixture as a real subprocess, with the fake package manager first on PATH.
function runVerify(t, cwd, { outcomes = {}, args = [], extraEnv = {} } = {}) {
  const pm = installFakePm(t);
  const env = { ...makeHome(t, "verify-caller"), ...extraEnv };
  env.PATH = `${pm.dir}:${env.PATH ?? ""}`;
  env.NIGHTQUEUE_FAKE_PM_LOG = pm.log;
  env.NIGHTQUEUE_FAKE_PM_SCRIPTS = JSON.stringify(outcomes);
  const result = spawnSync(process.execPath, [CLI, "verify", ...args], { cwd, env, encoding: "utf8" });
  assert.equal(result.error, undefined, `the CLI failed to spawn: ${result.error}`);
  return { code: result.status, stdout: result.stdout, stderr: result.stderr, env, calls: readCalls(pm.log) };
}

// The check names of the block, in the order they were printed.
function blockOrder(stdout) {
  return stdout.split("\n").filter((line) => STATUS_LINE_RE.test(line)).map((line) => STATUS_LINE_RE.exec(line)[2]);
}

// The status of every check of the block, keyed by check name.
function statuses(stdout) {
  const entries = stdout.split("\n").filter((line) => STATUS_LINE_RE.test(line)).map((line) => STATUS_LINE_RE.exec(line));
  return new Map(entries.map((match) => [match[2], match[1]]));
}

// The snippet lines printed under one check of the block.
function snippetOf(stdout, name) {
  const lines = stdout.split("\n");
  const start = lines.findIndex((line) => STATUS_LINE_RE.exec(line)?.[2] === name);
  if (start === -1) return [];
  const snippet = [];
  for (const line of lines.slice(start + 1)) {
    if (STATUS_LINE_RE.test(line)) break;
    if (line.startsWith("  ")) snippet.push(line.slice(2));
  }
  return snippet;
}

test("the block carries one line per check in the fixed order, and one FAILED check makes the exit code non-zero", (t) => {
  const cwd = makeFixture(t, "order", { scripts: { typecheck: "tsc", lint: "eslint", build: "rollup", test: "node --test" } });
  const outcomes = { typecheck: { exit: 0 }, lint: { exit: 1, stderr: "src/a.ts:3:1 no-unused-vars" }, build: { exit: 0 }, test: { exit: 0 } };

  const result = runVerify(t, cwd, { outcomes });

  assert.deepEqual(blockOrder(result.stdout), ORDER);
  assert.deepEqual(Object.fromEntries(statuses(result.stdout)), {
    typecheck: "PASSED",
    lint: "FAILED",
    build: "PASSED",
    test: "PASSED",
    poc: "SKIPPED",
    "diff-hygiene": "PASSED",
  });
  assert.deepEqual(snippetOf(result.stdout, "lint"), ["src/a.ts:3:1 no-unused-vars"]);
  assert.equal(result.code, 1, result.stderr);
});

test("the package manager comes from the lockfile alone, for each of the four", (t) => {
  for (const manager of MANAGERS) {
    const cwd = makeFixture(t, `pm-${manager}`, { manager, scripts: { test: "node --test" } });

    const result = runVerify(t, cwd, { outcomes: { test: { exit: 0 } } });

    assert.equal(result.code, 0, result.stderr);
    assert.equal(statuses(result.stdout).get("test"), "PASSED");
    assert.deepEqual(
      result.calls.map((call) => [call.manager, ...call.args]),
      [[manager, "run", "test"]],
      `${LOCKFILES[manager]} must make verify call ${manager}`,
    );
  }
});

test("a directory that declares no check at all reports every check SKIPPED, says so on stderr and exits 0", (t) => {
  const cwd = makeDir(t, "verify-empty");

  const result = runVerify(t, cwd);

  assert.deepEqual(blockOrder(result.stdout), ORDER);
  assert.deepEqual([...new Set(statuses(result.stdout).values())], ["SKIPPED"]);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(result.calls, []);
  assert.match(result.stderr, /no check was detected in .*"nothing was verified", not a clean pass/s);
});

test("a workspace root with no scripts of its own runs the checks its members declare, each in its own package", (t) => {
  const member = (name, scripts) => `${JSON.stringify({ name, version: "1.0.0", scripts }, null, 2)}\n`;
  const cwd = makeFixture(t, "workspaces", {
    workspaces: ["packages/*"],
    files: {
      "packages/app/package.json": member("app", { test: "node --test", lint: "eslint" }),
      "packages/core/package.json": member("core", { test: "node --test" }),
      "packages/docs/package.json": member("docs", {}),
    },
  });

  const result = runVerify(t, cwd, { outcomes: { test: { exit: 0 }, lint: { exit: 0 } } });

  const byName = statuses(result.stdout);
  assert.equal(byName.get("test"), "PASSED");
  assert.equal(byName.get("lint"), "PASSED");
  assert.equal(byName.get("build"), "SKIPPED", "a check no member declares stays absent, never invented");
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(
    result.calls.map((call) => [call.args.join(" "), basename(call.cwd)]).sort(),
    [
      ["run lint", "app"],
      ["run test", "app"],
      ["run test", "core"],
    ],
    "each member's script runs in the member's own directory, and a member that declares none is never called",
  );
});

test("a failing workspace member names itself and stops the check, and an unmatched workspace pattern is reported", (t) => {
  const failing = makeFixture(t, "workspace-failure", {
    workspaces: { packages: ["packages/*"] },
    files: { "packages/app/package.json": `${JSON.stringify({ name: "app", scripts: { test: "node --test" } }, null, 2)}\n` },
  });
  const empty = makeFixture(t, "workspace-empty", { workspaces: ["packages/*"] });

  const broken = runVerify(t, failing, { outcomes: { test: { exit: 1, stdout: "app/src/a.test.js failed" } } });
  const unmatched = runVerify(t, empty);

  assert.equal(statuses(broken.stdout).get("test"), "FAILED");
  assert.deepEqual(snippetOf(broken.stdout, "test"), ["in packages/app", "app/src/a.test.js failed"]);
  assert.equal(broken.code, 1);
  assert.match(unmatched.stderr, /declares the workspaces packages\/\* but no member carries a package\.json/);
  assert.equal(unmatched.code, 0, unmatched.stderr);
});

test("a pnpm workspace is read from pnpm-workspace.yaml, whose members the root manifest never names", (t) => {
  const cwd = makeFixture(t, "pnpm-workspaces", {
    manager: "pnpm",
    files: {
      "pnpm-workspace.yaml": 'packages:\n  - "apps/*"\n  - \'tools/**\'\n',
      "apps/web/package.json": `${JSON.stringify({ name: "web", scripts: { test: "vitest" } }, null, 2)}\n`,
      "tools/nested/cli/package.json": `${JSON.stringify({ name: "cli", scripts: { test: "vitest" } }, null, 2)}\n`,
    },
  });

  const result = runVerify(t, cwd, { outcomes: { test: { exit: 0 } } });

  assert.equal(statuses(result.stdout).get("test"), "PASSED");
  assert.deepEqual(
    result.calls.map((call) => [call.manager, basename(call.cwd)]).sort(),
    [
      ["pnpm", "cli"],
      ["pnpm", "web"],
    ],
  );
});

test("a repository with no test script skips every detected check, fails nothing and exits 0", (t) => {
  const cwd = makeFixture(t, "no-scripts", { scripts: {} });

  const result = runVerify(t, cwd);

  const byName = statuses(result.stdout);
  for (const name of ["typecheck", "lint", "build", "test", "poc"]) assert.equal(byName.get(name), "SKIPPED", name);
  assert.equal(byName.get("diff-hygiene"), "PASSED");
  assert.equal([...byName.values()].includes("FAILED"), false);
  assert.equal(result.code, 0, result.stderr);
});

test("a declared check whose dependencies are missing is FAILED with the never-installs reason, and nothing is installed", (t) => {
  const cwd = makeFixture(t, "missing-deps", { scripts: { typecheck: "tsc", test: "node --test" } });
  const outcomes = { typecheck: { exit: 1, stderr: "Error: Cannot find module 'typescript'" }, test: { exit: 0 } };

  const result = runVerify(t, cwd, { outcomes });

  assert.equal(statuses(result.stdout).get("typecheck"), "FAILED");
  assert.equal(snippetOf(result.stdout, "typecheck")[0], NEVER_INSTALLS);
  assert.equal(result.code, 1);
  const installs = result.calls.filter((call) => call.args.some((arg) => INSTALL_WORDS.includes(arg)));
  assert.deepEqual(installs, [], "nightqueue verify must never ask the package manager to install anything");
});

test("the never-installs reason comes from the process's own resolution failure, never from a phrase inside a check's output", (t) => {
  const cwd = makeFixture(t, "deps-attribution", { scripts: { lint: "eslint", test: "node --test" } });
  const outcomes = {
    lint: { exit: 127, stderr: "sh: eslint: command not found" },
    test: { exit: 1, stdout: 'FAIL: expected "command not found" in the error output' },
  };

  const result = runVerify(t, cwd, { outcomes });

  assert.equal(snippetOf(result.stdout, "lint")[0], NEVER_INSTALLS, "the shell's own message is a resolution failure");
  assert.equal(snippetOf(result.stdout, "test")[0], 'FAIL: expected "command not found" in the error output');
  assert.equal(snippetOf(result.stdout, "test").includes(NEVER_INSTALLS), false, "a quoted phrase must not steal the real reason");
  assert.equal(result.code, 1);
});

test("`--files` outside the touched scope is reported as ignored, and inside it is not", (t) => {
  const cwd = makeFixture(t, "files-scope", { scripts: { lint: "eslint" } });
  const outcomes = { lint: { exit: 0 } };

  const full = runVerify(t, cwd, { outcomes, args: ["--scope", "full", "--files", "a.js"] });
  const poc = runVerify(t, cwd, { outcomes, args: ["--scope", "+poc", "--files", "a.js"] });
  const touched = runVerify(t, cwd, { outcomes, args: ["--scope", "touched", "--files", "a.js"] });

  assert.match(full.stderr, /`--files` is ignored under `--scope full`/);
  assert.match(poc.stderr, /`--files` is ignored under `--scope \+poc`/);
  assert.equal(/--files/.test(touched.stderr), false, touched.stderr);
  assert.deepEqual(touched.calls.map((call) => call.args), [["run", "lint", "--", "a.js"]]);
  assert.deepEqual(full.calls.map((call) => call.args), [["run", "lint"]]);
});

test("every check runs against a throwaway home and host config, both gone once the command exits", (t) => {
  const cwd = makeFixture(t, "throwaway-home", { scripts: { test: "node --test" } });
  const callerClaudeDir = makeDir(t, "verify-caller-claude");

  const result = runVerify(t, cwd, { outcomes: { test: { exit: 0 } }, extraEnv: { CLAUDE_CONFIG_DIR: callerClaudeDir } });

  const [call] = result.calls;
  assert.ok(call, "the check was never spawned");
  assert.ok(call.home && call.home !== result.env.NIGHTQUEUE_HOME, "the check saw the caller's own NIGHTQUEUE_HOME");
  assert.ok(call.claudeConfigDir && call.claudeConfigDir !== callerClaudeDir, "the check saw the caller's own CLAUDE_CONFIG_DIR");
  assert.equal(existsSync(call.home), false, "the throwaway NIGHTQUEUE_HOME outlived the command");
  assert.equal(existsSync(call.claudeConfigDir), false, "the throwaway CLAUDE_CONFIG_DIR outlived the command");
});

test("the snippet of a failure is capped at twenty lines", (t) => {
  const cwd = makeFixture(t, "snippet-cap", { scripts: { test: "node --test" } });
  const noise = Array.from({ length: 50 }, (_, index) => `failure line ${index + 1}`).join("\n");

  const result = runVerify(t, cwd, { outcomes: { test: { exit: 1, stderr: noise } } });

  assert.equal(statuses(result.stdout).get("test"), "FAILED");
  assert.equal(snippetOf(result.stdout, "test").length, 20);
  assert.equal(result.code, 1);
});

test("diff hygiene fails on a path under .claude/ and names it, without the command touching the repository under test", (t) => {
  const cwd = makeFixture(t, "diff-hygiene", { scripts: { test: "node --test" } });
  mkdirSync(join(cwd, ".claude"), { recursive: true });
  writeFileSync(join(cwd, ".claude", "settings.json"), "{}\n");
  const before = gitStatus(cwd);

  const result = runVerify(t, cwd, { outcomes: { test: { exit: 0 } } });

  assert.equal(statuses(result.stdout).get("diff-hygiene"), "FAILED");
  assert.ok(snippetOf(result.stdout, "diff-hygiene").includes(".claude/settings.json"), result.stdout);
  assert.equal(result.code, 1);
  assert.equal(gitStatus(cwd), before, "nightqueue verify must never modify the repository under test");
});

test("diff hygiene reports the scale of the change, and says so when nothing tracked changed", (t) => {
  const cwd = makeFixture(t, "diff-stat", { scripts: {}, files: { "src/a.js": "const a = 1;\n" } });

  const clean = runVerify(t, cwd);
  writeFileSync(join(cwd, "src", "a.js"), "const a = 1;\nconst b = 2;\n");
  const changed = runVerify(t, cwd);

  assert.deepEqual(snippetOf(clean.stdout, "diff-hygiene"), ["no tracked file changed"]);
  assert.equal(clean.code, 0, clean.stderr);
  assert.deepEqual(snippetOf(changed.stdout, "diff-hygiene"), ["1 file changed, 1 insertion(+)"]);
  assert.equal(statuses(changed.stdout).get("diff-hygiene"), "PASSED");
  assert.equal(changed.code, 0, changed.stderr);
});

test("a diff-hygiene failure carries the scale of the change above the intruding paths", (t) => {
  const cwd = makeFixture(t, "diff-stat-intruder", { scripts: {}, files: { "src/a.js": "const a = 1;\n" } });
  writeFileSync(join(cwd, "src", "a.js"), "const a = 1;\nconst b = 2;\n");
  mkdirSync(join(cwd, "tmp"), { recursive: true });
  writeFileSync(join(cwd, "tmp", "scratch.txt"), "scratch\n");

  const result = runVerify(t, cwd);

  const snippet = snippetOf(result.stdout, "diff-hygiene");
  assert.match(snippet[0], /1 file changed, 1 insertion/);
  assert.deepEqual(snippet.slice(1), ["paths the brief did not ask for", "tmp/scratch.txt"]);
  assert.equal(result.code, 1);
});

test("the PoC check only runs when the caller asks for it, through the script the project declares", (t) => {
  const cwd = makeFixture(t, "poc-scope", { scripts: { test: "node --test", "test:poc": "node --test poc" } });
  const outcomes = { test: { exit: 0 }, "test:poc": { exit: 0 } };

  const full = runVerify(t, cwd, { outcomes });
  const withPoc = runVerify(t, cwd, { outcomes, args: ["--scope", "+poc"] });

  assert.equal(statuses(full.stdout).get("poc"), "SKIPPED");
  assert.equal(full.calls.some((call) => call.args.includes("test:poc")), false);
  assert.equal(statuses(withPoc.stdout).get("poc"), "PASSED");
  assert.deepEqual(withPoc.calls.at(-1).args, ["run", "test:poc"]);
  assert.equal(withPoc.code, 0, withPoc.stderr);
});

test("a scope the command does not define is refused instead of silently treated as the default", (t) => {
  const cwd = makeFixture(t, "bad-scope", { scripts: { test: "node --test" } });

  const result = runVerify(t, cwd, { outcomes: { test: { exit: 0 } }, args: ["--scope", "everything"] });

  assert.equal(result.code, 1);
  assert.match(result.stderr, /unknown scope `everything`/);
  assert.deepEqual(result.calls, []);
});
