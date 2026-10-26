import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { defaultContext, run } from "../src/cli/index.mjs";
import { homeDir } from "../src/config/paths.mjs";
import { withProviders } from "../src/integrations/registry.mjs";
import { openDb } from "../src/memory/db.mjs";
import { projectAgents, projectDemoRepo, projectIntegrations, setProjectAgents, setProjectDemoRepo, setProjectIntegrations } from "../src/memory/registry.mjs";
import { OPERATOR_SUBCOMMANDS } from "../src/queue/operator-scope.mjs";
import { makeHome, makeProject, projectIdOf, registerCheckout } from "../test-support/memory.mjs";
import { bindTrackerConnection, originProviders, trackerProvider } from "../test-support/origin-provider.mjs";

// A test provider with one boolean setting, so `project integrations` has something to store beside the demo repository.
function settingsProviders() {
  return [originProviders()[0], { ...trackerProvider(), settings: { reply: { type: "boolean", default: true } } }];
}

// A temp directory removed after the test, in its canonical form.
function makeTempDir(t, name) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `${name}-`)));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// A temp home with the project `alpha` and a temp git directory standing for the demo checkout.
function makeDemoHome(t, name) {
  const env = makeHome(t, name);
  const projectPath = makeProject(t, env, "alpha");
  const projectId = projectIdOf(env, "alpha");
  bindTrackerConnection(env, projectId);
  const demo = makeTempDir(t, `${name}-demo`);
  mkdirSync(join(demo, ".git"));
  return { env, projectId, demo, projectPath };
}

// A linked worktree of a checkout: a `.git` file pointing at an admin dir whose `commondir` leads back to the checkout's `.git`.
function makeLinkedWorktree(t, checkout) {
  const admin = join(checkout, ".git", "worktrees", "w");
  mkdirSync(admin, { recursive: true });
  writeFileSync(join(admin, "commondir"), "../..\n");
  const worktree = makeTempDir(t, "demo-repo-worktree");
  writeFileSync(join(worktree, ".git"), `gitdir: ${admin}\n`);
  return worktree;
}

// The raw settings column of a project, parsed, or null.
function storedSettings(env, projectId) {
  const text = openDb(env).prepare("SELECT integrations FROM projects WHERE id = ?").get(projectId).integrations;
  return text === null ? null : JSON.parse(text);
}

// Runs the CLI in this process, collecting what it printed.
async function runCli(env, argv) {
  const out = [];
  const err = [];
  const code = await run(argv, { ...defaultContext(), env, out: (line) => out.push(line), err: (line) => err.push(line) });
  return { code, out, err };
}

test("`project demo-repo` shows `none configured`, sets an existing directory and answers it as JSON", async (t) => {
  const { env, projectId, demo } = makeDemoHome(t, "demo-repo-round-trip");
  const empty = await runCli(env, ["project", "demo-repo", "alpha"]);
  assert.equal(empty.code, 0, empty.err.join("\n"));
  assert.deepEqual(empty.out, ["none configured"]);
  assert.deepEqual(JSON.parse((await runCli(env, ["project", "demo-repo", "alpha", "--json"])).out[0]), { project: "alpha", demoRepo: null });

  const set = await runCli(env, ["project", "demo-repo", "alpha", "--set", demo]);
  assert.equal(set.code, 0, set.err.join("\n"));
  assert.deepEqual(set.out, [demo]);
  assert.deepEqual(storedSettings(env, projectId), { verification: { demoRepo: demo } });
  assert.deepEqual(JSON.parse((await runCli(env, ["project", "demo-repo", "alpha", "--json"])).out[0]), { project: "alpha", demoRepo: demo });
});

test("a missing path, an empty `--set` or an unknown project is refused, and nothing is stored", async (t) => {
  const { env, projectId, demo } = makeDemoHome(t, "demo-repo-refusals");
  const missing = join(demo, "nope");
  const refused = await runCli(env, ["project", "demo-repo", "alpha", "--set", missing]);
  assert.equal(refused.code, 1);
  assert.ok(refused.err.join("\n").includes(`the demo repository \`${missing}\` is not an existing directory`), refused.err.join("\n"));
  const blank = await runCli(env, ["project", "demo-repo", "alpha", "--set", ""]);
  assert.equal(blank.code, 1);
  assert.equal(storedSettings(env, projectId), null);
  assert.equal((await runCli(env, ["project", "demo-repo", "nope"])).code, 1);
});

test("the project's own repository, a worktree of it, a directory around it or one with no `.git` is refused, and nothing is stored", async (t) => {
  const { env, projectId, projectPath } = makeDemoHome(t, "demo-repo-own");
  const own = realpathSync(projectPath);
  const plain = makeTempDir(t, "demo-repo-plain");
  const cases = [
    [own, "is the project's own repository: real pull requests are never opened there"],
    [makeLinkedWorktree(t, own), "is the project's own repository"],
    [join(own, ".."), "is not a git repository"],
    [plain, "is not a git repository"],
  ];
  for (const [path, expected] of cases) {
    const refused = await runCli(env, ["project", "demo-repo", "alpha", "--set", path]);
    assert.equal(refused.code, 1, `${path} was accepted`);
    assert.ok(refused.err.join("\n").includes(expected), refused.err.join("\n"));
    assert.deepEqual((await runCli(env, ["project", "demo-repo", "alpha"])).out, ["none configured"]);
  }
  assert.equal(storedSettings(env, projectId), null);
});

test("a git directory holding the project's checkout is refused as the demo repository", async (t) => {
  const env = makeHome(t, "demo-repo-around");
  const outer = makeTempDir(t, "demo-repo-outer");
  mkdirSync(join(outer, ".git"));
  const inner = join(outer, "inner");
  mkdirSync(join(inner, ".git"), { recursive: true });
  registerCheckout(env, { path: inner, name: "beta" });

  const refused = await runCli(env, ["project", "demo-repo", "beta", "--set", outer]);

  assert.equal(refused.code, 1, "the directory around the checkout was accepted");
  assert.ok(refused.err.join("\n").includes("is the project's own repository"), refused.err.join("\n"));
  assert.deepEqual((await runCli(env, ["project", "demo-repo", "beta"])).out, ["none configured"]);
});

test("the CLI refuses a demo repository change from inside a job, while showing still answers", async (t) => {
  const { env, projectId, demo } = makeDemoHome(t, "demo-repo-in-job");
  const inJob = { ...env, NIGHTQUEUE_JOB_ID: "9", NIGHTQUEUE_JOB_HOME: homeDir(env) };
  const refused = await runCli(inJob, ["project", "demo-repo", "alpha", "--set", demo]);
  assert.equal(refused.code, 1);
  assert.ok(refused.err.join("\n").includes("from inside J-9"), refused.err.join("\n"));
  assert.equal(storedSettings(env, projectId), null);
  assert.equal((await runCli(inJob, ["project", "demo-repo", "alpha"])).code, 0);
});

test("`project models` and `project integrations` writes keep the demo repository, and integrations never show it", async (t) => {
  const { env, projectId, demo } = makeDemoHome(t, "demo-repo-beside-settings");
  await withProviders(settingsProviders(), async () => {
    await runCli(env, ["project", "demo-repo", "alpha", "--set", demo]);
    await runCli(env, ["project", "models", "alpha", "--set", "coder=sonnet"]);
    assert.deepEqual((await runCli(env, ["project", "demo-repo", "alpha"])).out, [demo], "a models write dropped the demo repository");
    await runCli(env, ["project", "integrations", "alpha", "set", "tracker.reply=false"]);
    assert.deepEqual(storedSettings(env, projectId), { tracker: { reply: false }, agents: { coder: { model: "sonnet" } }, verification: { demoRepo: demo } });
    const shown = await runCli(env, ["project", "integrations", "alpha", "show", "--json"]);
    assert.equal(JSON.stringify(JSON.parse(shown.out[0])).includes("verification"), false, shown.out[0]);
    await runCli(env, ["project", "models", "alpha", "--unset", "coder"]);
    await runCli(env, ["project", "integrations", "alpha", "unset", "tracker.reply"]);
    assert.deepEqual(storedSettings(env, projectId), { verification: { demoRepo: demo } });
  });
});

test("the registry keeps the demo repository apart: every other write keeps it, and a bad value is refused", (t) => {
  const { env, projectId } = makeDemoHome(t, "demo-repo-registry");
  const db = openDb(env);
  assert.equal(projectDemoRepo(db, projectId), null);
  assert.equal(setProjectDemoRepo(db, { id: projectId, value: "/demo/checkout" }), "/demo/checkout");
  setProjectAgents(db, { id: projectId, value: { coder: { model: "sonnet" } } });
  setProjectIntegrations(db, { id: projectId, value: { tracker: { reply: false }, verification: { demoRepo: "/elsewhere" } } });
  assert.equal(projectDemoRepo(db, projectId), "/demo/checkout", "an integrations write changed the demo repository");
  assert.deepEqual(projectIntegrations(db, projectId), { tracker: { reply: false } });
  assert.deepEqual(projectAgents(db, projectId), { coder: { model: "sonnet" } });
  setProjectAgents(db, { id: projectId, value: null });
  setProjectIntegrations(db, { id: projectId, value: null });
  assert.deepEqual(storedSettings(env, projectId), { verification: { demoRepo: "/demo/checkout" } });
  for (const value of ["", "  ", 42, null]) {
    assert.throws(() => setProjectDemoRepo(db, { id: projectId, value }), /the demo repository must be a non-empty path/);
  }
  assert.throws(() => setProjectDemoRepo(db, { id: "nope", value: "/x" }), /unknown project id `nope`/);
});

test("the operator agent may not set the demo repository", () => {
  assert.ok(OPERATOR_SUBCOMMANDS.project.refused.includes("demo-repo"));
  assert.equal(OPERATOR_SUBCOMMANDS.project.allowed.includes("demo-repo"), false);
});
