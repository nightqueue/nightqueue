import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { defaultContext, run } from "../src/cli/index.mjs";
import { addProject } from "../src/config/projects.mjs";
import { loadConfig, saveConfig } from "../src/config/store.mjs";
import { OPERATOR_AGENT } from "../src/host/operator.mjs";
import { jobSettings } from "../src/host/settings.mjs";
import { pluginDir } from "../src/queue/spawn.mjs";
import { initGitRepo } from "../test-support/git.mjs";
import { makeDir, makeHome } from "../test-support/memory.mjs";

const FAKE_CLAUDE = fileURLToPath(new URL("../test-support/fake-claude-open.mjs", import.meta.url));

// A temp home whose project `alpha` is a real git checkout, with a temp HOME, Claude config dir and the fake interactive claude.
function openHome(t, name) {
  const env = makeHome(t, name);
  delete env.NIGHTSHIFT_MODE;
  const base = realpathSync(makeDir(t, `${name}-host`));
  const checkout = initGitRepo(join(base, "checkout"));
  for (const dir of ["user-home", "claude-config"]) mkdirSync(join(base, dir));
  const bin = join(base, "claude");
  copyFileSync(FAKE_CLAUDE, bin);
  chmodSync(bin, 0o755);
  Object.assign(env, {
    HOME: join(base, "user-home"),
    CLAUDE_CONFIG_DIR: join(base, "claude-config"),
    NIGHTSHIFT_CLAUDE_BIN: bin,
    NIGHTSHIFT_FAKE_CALLS: join(base, "calls.jsonl"),
  });
  saveConfig(addProject(loadConfig(env, { warn: () => {} }), { path: checkout, name: "alpha" }).config, env);
  return { env, base, checkout, callsPath: env.NIGHTSHIFT_FAKE_CALLS };
}

// Runs `nightshift open ...` in this process from a directory, capturing stdout and stderr.
async function runOpen(env, argv, cwd) {
  const out = [];
  const err = [];
  const code = await run(["open", ...argv], { ...defaultContext(), env, cwd, out: (line) => out.push(line), err: (line) => err.push(line) });
  return { code, out, err };
}

// The launches the fake claude recorded, one object per interactive start.
function launches(callsPath) {
  if (!existsSync(callsPath)) return [];
  return readFileSync(callsPath, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

// The value that follows a flag in an argv, or undefined when the flag is absent.
function argValue(argv, flag) {
  const index = argv.indexOf(flag);
  return index === -1 ? undefined : argv[index + 1];
}

test("`nightshift open` in the checkout starts claude with the operator as the main thread, under the jobs' hooks and the operator mode", async (t) => {
  const home = openHome(t, "open-checkout");

  const result = await runOpen(home.env, [], home.checkout);

  assert.equal(result.code, 0, result.err.join("\n"));
  const calls = launches(home.callsPath);
  assert.equal(calls.length, 1);
  const [{ argv, cwd, mode, pluginDirEnv, jobId }] = calls;
  assert.equal(argValue(argv, "--agent"), "nightshift:nightshift-operator");
  assert.equal(argValue(argv, "--setting-sources"), "project,local");
  assert.deepEqual(JSON.parse(argValue(argv, "--settings")), jobSettings(home.env));
  assert.equal(argValue(argv, "--plugin-dir"), pluginDir());
  assert.ok(JSON.parse(argValue(argv, "--mcp-config")).mcpServers.nightshift, "the nightshift MCP server is not configured");
  for (const absent of ["-p", "--print", "--strict-mcp-config", "--resume", "--append-system-prompt", "--permission-mode"]) {
    assert.equal(argv.includes(absent), false, `${absent} was passed`);
  }
  assert.equal(mode, "operator");
  assert.equal(pluginDirEnv, pluginDir());
  assert.equal(jobId, null);
  assert.equal(cwd, home.checkout);
  assert.deepEqual(result.out, [`operator · ${home.checkout} · agent ${OPERATOR_AGENT}`]);
});

test("`nightshift open <project>` from an unrelated directory runs in that project's checkout", async (t) => {
  const home = openHome(t, "open-by-name");
  const elsewhere = realpathSync(makeDir(t, "open-elsewhere"));

  const result = await runOpen(home.env, ["alpha"], elsewhere);

  assert.equal(result.code, 0, result.err.join("\n"));
  assert.equal(launches(home.callsPath)[0].cwd, home.checkout);
});

test("an unregistered directory gets one line pointing at `nightshift setup`, exit 1, and no claude", async (t) => {
  const home = openHome(t, "open-unregistered");
  const elsewhere = realpathSync(makeDir(t, "open-unregistered-cwd"));

  const result = await runOpen(home.env, [], elsewhere);

  assert.equal(result.code, 1);
  assert.equal(result.err.length, 1, result.err.join("\n"));
  assert.match(result.err[0], /no project is registered for .*; run `nightshift setup` there first/);
  assert.equal(existsSync(home.callsPath), false);

  const unknown = await runOpen(home.env, ["beta"], elsewhere);
  assert.equal(unknown.code, 1);
  assert.match(unknown.err.join("\n"), /unknown project `beta`.*nightshift project list/);
  assert.equal(existsSync(home.callsPath), false);
});

test("`--resume <session>` is passed through, and an unsafe session id is refused before claude starts", async (t) => {
  const home = openHome(t, "open-resume");

  const resumed = await runOpen(home.env, ["--resume", "abc-12345"], home.checkout);
  assert.equal(resumed.code, 0, resumed.err.join("\n"));
  assert.equal(argValue(launches(home.callsPath)[0].argv, "--resume"), "abc-12345");

  for (const unsafe of ["a;b", "--help", "../x", "abc"]) {
    rmSync(home.callsPath, { force: true });
    const refused = await runOpen(home.env, [`--resume=${unsafe}`], home.checkout);
    assert.equal(refused.code, 1, unsafe);
    assert.match(refused.err.join("\n"), /is not a session id/);
    assert.equal(existsSync(home.callsPath), false, `claude started for ${unsafe}`);
  }
});

test("a claude without `--agent` gets the operator body through `--append-system-prompt`, frontmatter removed", async (t) => {
  const home = openHome(t, "open-fallback");
  home.env.NIGHTSHIFT_FAKE_NO_AGENT = "1";

  const result = await runOpen(home.env, [], home.checkout);

  assert.equal(result.code, 0, result.err.join("\n"));
  const [{ argv, mode }] = launches(home.callsPath);
  assert.equal(argv.includes("--agent"), false);
  const source = readFileSync(join(pluginDir(), "agents", "operator.md"), "utf8");
  const body = argValue(argv, "--append-system-prompt");
  assert.equal(body, source.replace(/^---\n[\s\S]*?\n---\n/, ""));
  assert.ok(body.includes("# Operator — the front door of nightshift"));
  assert.equal(body.includes("name: nightshift-operator"), false);
  assert.equal(mode, "operator");
  assert.deepEqual(result.out, [`operator · ${home.checkout} · fallback --append-system-prompt`]);
});

test("`nightshift open` prunes a worktree whose directory a closed terminal left behind", async (t) => {
  const home = openHome(t, "open-prune");
  const stale = join(home.checkout, ".claude", "worktrees", "operator-qa-stale");
  execFileSync("git", ["-C", home.checkout, "worktree", "add", "-q", "--detach", stale, "HEAD"]);
  rmSync(stale, { recursive: true, force: true });
  const listed = () => execFileSync("git", ["-C", home.checkout, "worktree", "list", "--porcelain"], { encoding: "utf8" });
  assert.ok(listed().includes(stale), "the stale worktree was not registered");

  const result = await runOpen(home.env, [], home.checkout);

  assert.equal(result.code, 0, result.err.join("\n"));
  assert.equal(listed().includes(stale), false);
});

test("`--resume` from inside a worktree of the checkout keeps that directory; from elsewhere it runs in the checkout", async (t) => {
  const home = openHome(t, "open-resume-cwd");
  const worktree = join(home.checkout, ".claude", "worktrees", "feat+resumed");
  execFileSync("git", ["-C", home.checkout, "worktree", "add", "-q", "--detach", worktree, "HEAD"]);

  const inside = await runOpen(home.env, ["--resume", "sess-inside"], worktree);
  assert.equal(inside.code, 0, inside.err.join("\n"));
  assert.equal(launches(home.callsPath)[0].cwd, worktree);

  const plain = await runOpen(home.env, [], worktree);
  assert.equal(plain.code, 0, plain.err.join("\n"));
  assert.equal(launches(home.callsPath)[1].cwd, home.checkout);

  const elsewhere = realpathSync(makeDir(t, "open-resume-elsewhere"));
  const named = await runOpen(home.env, ["alpha", "--resume", "sess-elsewhere"], elsewhere);
  assert.equal(named.code, 0, named.err.join("\n"));
  assert.equal(launches(home.callsPath)[2].cwd, home.checkout);
});

test("a registered checkout that is gone is refused with a reason, and claude never starts", async (t) => {
  const home = openHome(t, "open-gone");
  rmSync(home.checkout, { recursive: true, force: true });

  const result = await runOpen(home.env, ["alpha"], home.base);

  assert.equal(result.code, 1);
  assert.match(result.err.join("\n"), /the checkout of `alpha` is gone/);
  assert.equal(existsSync(home.callsPath), false);
});
