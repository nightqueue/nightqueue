import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SPAWN_TIMEOUT_MS = 15000;
const DECLARED_DEPENDENCIES = Object.keys(JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")).dependencies ?? {});

// Walks up from a starting directory to the nearest node_modules that really carries the declared dependencies, the same lookup a git worktree relies on to reach its repository's install.
function findDependencyTree(startDir) {
  let dir = startDir;
  while (true) {
    const candidate = join(dir, "node_modules");
    if (existsSync(candidate) && hasDeclaredDependencies(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// Checks that a node_modules tree actually contains every dependency declared in package.json.
function hasDeclaredDependencies(nodeModulesDir) {
  return DECLARED_DEPENDENCIES.every((name) => existsSync(join(nodeModulesDir, name)));
}

// Copies bin/ and src/ into a throwaway directory and links a real, verified node_modules tree, so the real entry point runs without touching the checkout.
function makeSandbox(t) {
  const dir = mkdtempSync(join(tmpdir(), "nightqueue-import-failure-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  cpSync(join(REPO_ROOT, "bin"), join(dir, "bin"), { recursive: true });
  cpSync(join(REPO_ROOT, "src"), join(dir, "src"), { recursive: true });
  const nodeModules = findDependencyTree(REPO_ROOT);
  assert.ok(
    nodeModules,
    `no node_modules tree with the declared dependencies (${DECLARED_DEPENDENCIES.join(", ")}) was found at or above ${REPO_ROOT}; run npm ci at the repository root`,
  );
  symlinkSync(nodeModules, join(dir, "node_modules"));
  return dir;
}

// Runs the sandboxed entry point with the given argv, capturing exit code, stdout and stderr.
function runEntry(dir, args, { input } = {}) {
  return spawnSync("node", [join(dir, "bin", "nightqueue.mjs"), ...args], { encoding: "utf8", timeout: SPAWN_TIMEOUT_MS, input });
}

test("H1a/H1b/H1c: a missing package.json makes the CLI, the hook and the MCP entry points fail identically, non-zero and with the reinstall message in stderr", (t) => {
  const dir = makeSandbox(t);
  rmSync(join(dir, "package.json"), { force: true });

  const cli = runEntry(dir, ["--help"]);
  const hook = runEntry(dir, ["hook", "session-start"], { input: "{}" });
  const mcp = runEntry(dir, ["mcp"]);

  for (const [name, result] of [
    ["cli", cli],
    ["hook", hook],
    ["mcp", mcp],
  ]) {
    assert.equal(result.status, 1, `${name}: expected exit code 1, got ${result.status} (stderr: ${result.stderr})`);
    assert.equal(result.stdout, "", `${name}: stdout must stay empty, the failure must never look like success`);
    assert.match(result.stderr, /this installation of nightqueue is incomplete, reinstall it/, `${name}: stderr must carry the actionable message`);
    assert.match(result.stderr, /npm i -g @nightqueue\/nq/, `${name}: stderr must name the exact remedy`);
  }

  assert.equal(hook.stderr, cli.stderr, "the hook invocation crashes with the exact same message as the CLI: the throw happens at import, before argv is ever read");
  assert.equal(mcp.stderr, cli.stderr, "the MCP invocation crashes with the exact same message as the CLI: the throw happens at import, before argv is ever read");
});

test("H1a: an empty declared name also produces the actionable message instead of a silent crash", (t) => {
  const dir = makeSandbox(t);
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "" }));

  const result = runEntry(dir, ["--help"]);

  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /declares no name; this installation of nightqueue is incomplete, reinstall it/);
});

test("control: an intact package.json lets the CLI print its usage and exit 0", (t) => {
  const dir = makeSandbox(t);
  cpSync(join(REPO_ROOT, "package.json"), join(dir, "package.json"));

  const result = runEntry(dir, ["--help"]);

  assert.equal(result.status, 0);
  assert.match(result.stdout, /usage: nightqueue <command>/);
  assert.equal(result.stderr, "");
});

test("out of scope for H1, documented for the record: a syntactically invalid package.json never reaches declaredPackageName, Node's own resolver crashes first", (t) => {
  const dir = makeSandbox(t);
  writeFileSync(join(dir, "package.json"), "not json");

  const result = runEntry(dir, ["--help"]);

  assert.notEqual(result.status, 0, "Node must still refuse to run rather than silently succeed");
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /ERR_INVALID_PACKAGE_CONFIG/, "this is Node's own resolver error, pre-existing and unrelated to declaredPackageName");
  assert.doesNotMatch(result.stderr, /reinstall/, "the custom message never runs here: resolution fails before any module of the graph executes");
});
