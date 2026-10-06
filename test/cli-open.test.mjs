import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { defaultContext, run } from "../src/cli/index.mjs";
import { homeDir } from "../src/config/paths.mjs";
import { registerCheckout } from "../test-support/memory.mjs";
import { loadConfig, saveConfig } from "../src/config/store.mjs";
import { OPERATOR_AGENT, OPERATOR_OPENING_PROMPT } from "../src/host/operator.mjs";
import { operatorSettings } from "../src/host/settings.mjs";
import { createQaWorktree } from "../src/queue/qa-worktree.mjs";
import { pluginDir } from "../src/queue/spawn.mjs";
import { initGitRepo } from "../test-support/git.mjs";
import { makeDir, makeHome } from "../test-support/memory.mjs";
import { deadPid } from "../test-support/worktrees.mjs";

const FAKE_CLAUDE = fileURLToPath(new URL("../test-support/fake-claude-open.mjs", import.meta.url));

// A temp home whose project `alpha` is a real git checkout, with a temp HOME, Claude config dir and the fake interactive claude.
function openHome(t, name) {
  const env = makeHome(t, name);
  delete env.NIGHTQUEUE_MODE;
  const base = realpathSync(makeDir(t, `${name}-host`));
  const checkout = initGitRepo(join(base, "checkout"));
  for (const dir of ["user-home", "claude-config"]) mkdirSync(join(base, dir));
  const bin = join(base, "claude");
  copyFileSync(FAKE_CLAUDE, bin);
  chmodSync(bin, 0o755);
  Object.assign(env, {
    HOME: join(base, "user-home"),
    CLAUDE_CONFIG_DIR: join(base, "claude-config"),
    NIGHTQUEUE_CLAUDE_BIN: bin,
    NIGHTQUEUE_FAKE_CALLS: join(base, "calls.jsonl"),
  });
  const project = registerCheckout(env, { path: checkout, name: "alpha" });
  return { env, base, checkout, project, home: realpathSync(homeDir(env)), callsPath: env.NIGHTQUEUE_FAKE_CALLS };
}

// Writes a Claude session transcript whose second line records the directory the session was born in.
function writeTranscript(env, sessionId, cwd) {
  const dir = join(env.CLAUDE_CONFIG_DIR, "projects", "-some-project");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${sessionId}.jsonl`), `${JSON.stringify({ type: "summary" })}\nnot json\n${JSON.stringify({ type: "user", cwd })}\n`);
}

// Runs `nightqueue open ...` in this process from a directory, capturing stdout and stderr.
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

test("`nightqueue open` in the checkout starts claude in the home with the operator as the main thread, the project only preselected", async (t) => {
  const home = openHome(t, "open-checkout");

  const result = await runOpen(home.env, [], home.checkout);

  assert.equal(result.code, 0, result.err.join("\n"));
  const calls = launches(home.callsPath);
  assert.equal(calls.length, 1);
  const [{ argv, cwd, mode, pluginDirEnv, jobId, project, operatorPid }] = calls;
  assert.equal(argValue(argv, "--agent"), "nightqueue:nightqueue-operator");
  assert.equal(argValue(argv, "--setting-sources"), "project,local");
  assert.deepEqual(JSON.parse(argValue(argv, "--settings")), operatorSettings(home.env));
  assert.deepEqual(JSON.parse(argValue(argv, "--settings")).permissions, { allow: ["mcp__nightqueue__*"] }, "the nightqueue tools are not pre-approved");
  assert.equal(argv.at(-1), OPERATOR_OPENING_PROMPT, "a fresh session does not open with the greeting prompt");
  assert.equal(argValue(argv, "--plugin-dir"), pluginDir());
  assert.ok(JSON.parse(argValue(argv, "--mcp-config")).mcpServers.nightqueue, "the nightqueue MCP server is not configured");
  for (const absent of ["-p", "--print", "--strict-mcp-config", "--resume", "--append-system-prompt", "--permission-mode"]) {
    assert.equal(argv.includes(absent), false, `${absent} was passed`);
  }
  assert.equal(mode, "operator");
  assert.equal(pluginDirEnv, pluginDir());
  assert.equal(jobId, null);
  assert.equal(cwd, home.home);
  assert.equal(project, home.project.id);
  assert.equal(operatorPid, String(process.pid));
  assert.deepEqual(result.out, [`operator · ${homeDir(home.env)} · project alpha · agent ${OPERATOR_AGENT}`]);
});

test("`nightqueue open <project>` from an unrelated directory runs in the home with that project preselected, by name or id", async (t) => {
  const home = openHome(t, "open-by-name");
  const elsewhere = realpathSync(makeDir(t, "open-elsewhere"));

  const result = await runOpen(home.env, ["alpha"], elsewhere);
  const byId = await runOpen(home.env, [home.project.id], elsewhere);

  assert.equal(result.code, 0, result.err.join("\n"));
  assert.equal(byId.code, 0, byId.err.join("\n"));
  for (const call of launches(home.callsPath)) {
    assert.equal(call.cwd, home.home);
    assert.equal(call.project, home.project.id);
  }
});

test("an unregistered directory opens in the home with no project, a stale inherited one dropped; an unknown name is refused", async (t) => {
  const home = openHome(t, "open-unregistered");
  const elsewhere = realpathSync(makeDir(t, "open-unregistered-cwd"));
  home.env.NIGHTQUEUE_PROJECT = home.project.id;

  const result = await runOpen(home.env, [], elsewhere);

  assert.equal(result.code, 0, result.err.join("\n"));
  const [call] = launches(home.callsPath);
  assert.equal(call.cwd, home.home);
  assert.equal(call.project, null, "a NIGHTQUEUE_PROJECT inherited from the caller leaked into the session");
  assert.deepEqual(result.out, [`operator · ${homeDir(home.env)} · project none · agent ${OPERATOR_AGENT}`]);
  rmSync(home.callsPath, { force: true });

  const unknown = await runOpen(home.env, ["beta"], elsewhere);
  assert.equal(unknown.code, 1);
  assert.match(unknown.err.join("\n"), /unknown project `beta`.*nightqueue project list/);
  assert.equal(existsSync(home.callsPath), false);
});

test("`--resume <session>` is passed through, and an unsafe session id is refused before claude starts", async (t) => {
  const home = openHome(t, "open-resume");

  const resumed = await runOpen(home.env, ["--resume", "abc-12345"], home.checkout);
  assert.equal(resumed.code, 0, resumed.err.join("\n"));
  assert.equal(argValue(launches(home.callsPath)[0].argv, "--resume"), "abc-12345");
  assert.equal(launches(home.callsPath)[0].argv.includes(OPERATOR_OPENING_PROMPT), false, "a resumed session must not be greeted again");

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
  home.env.NIGHTQUEUE_FAKE_NO_AGENT = "1";

  const result = await runOpen(home.env, [], home.checkout);

  assert.equal(result.code, 0, result.err.join("\n"));
  const [{ argv, mode }] = launches(home.callsPath);
  assert.equal(argv.includes("--agent"), false);
  const source = readFileSync(join(pluginDir(), "agents", "operator.md"), "utf8");
  const body = argValue(argv, "--append-system-prompt");
  assert.equal(body, source.replace(/^---\n[\s\S]*?\n---\n/, ""));
  assert.ok(body.includes("# Operator — the front door of nightqueue"));
  assert.equal(body.includes("name: nightqueue-operator"), false);
  assert.equal(mode, "operator");
  assert.deepEqual(result.out, [`operator · ${homeDir(home.env)} · project alpha · fallback --append-system-prompt`]);
});

test("a missing nightqueue home is refused with a pointer at `nightqueue setup`, and claude never starts", async (t) => {
  const home = openHome(t, "open-no-home");
  const env = { ...home.env, NIGHTQUEUE_HOME: join(home.base, "missing-home") };

  const result = await runOpen(env, [], home.base);

  assert.equal(result.code, 1);
  assert.match(result.err.join("\n"), /no nightqueue home at .*missing-home; run `nightqueue setup`/);
  assert.equal(existsSync(home.callsPath), false);
});

test("`nightqueue open` from outside every checkout prunes a registered checkout's worktree whose directory a closed terminal left behind", async (t) => {
  const home = openHome(t, "open-prune");
  const stale = join(home.checkout, ".claude", "worktrees", "operator-qa-stale");
  execFileSync("git", ["-C", home.checkout, "worktree", "add", "-q", "--detach", stale, "HEAD"]);
  rmSync(stale, { recursive: true, force: true });
  const listed = () => execFileSync("git", ["-C", home.checkout, "worktree", "list", "--porcelain"], { encoding: "utf8" });
  assert.ok(listed().includes(stale), "the stale worktree was not registered");

  const result = await runOpen(home.env, [], home.base);

  assert.equal(result.code, 0, result.err.join("\n"));
  assert.equal(listed().includes(stale), false);
});

test("`nightqueue open` drops a qa worktree whose session is gone, says so once, and keeps one a live session holds", async (t) => {
  const home = openHome(t, "open-qa-sweep");
  const project = { id: home.project.id, name: "alpha", path: home.checkout };
  const orphan = createQaWorktree({ project, env: { ...home.env, NIGHTQUEUE_OPERATOR_PID: String(deadPid()) } });
  const held = createQaWorktree({ project, env: { ...home.env, NIGHTQUEUE_OPERATOR_PID: String(process.pid) } });

  const result = await runOpen(home.env, [], home.base);

  assert.equal(result.code, 0, result.err.join("\n"));
  assert.deepEqual(result.out, ["operator · dropped 1 stale qa worktree(s)", `operator · ${homeDir(home.env)} · project none · agent ${OPERATOR_AGENT}`]);
  assert.equal(existsSync(orphan), false);
  assert.ok(existsSync(held));

  const again = await runOpen(home.env, [], home.base);
  assert.deepEqual(again.out, [`operator · ${homeDir(home.env)} · project none · agent ${OPERATOR_AGENT}`], "a sweep with nothing to drop printed a line");
});

test("`--resume` runs in the transcript's recorded directory, else the current one inside the checkout, else the home", async (t) => {
  const home = openHome(t, "open-resume-cwd");
  const worktree = join(home.checkout, ".claude", "worktrees", "feat+resumed");
  execFileSync("git", ["-C", home.checkout, "worktree", "add", "-q", "--detach", worktree, "HEAD"]);
  const elsewhere = realpathSync(makeDir(t, "open-resume-elsewhere"));
  writeTranscript(home.env, "sess-recorded", home.checkout);
  writeTranscript(home.env, "sess-moved", join(home.base, "gone-dir"));

  const recorded = await runOpen(home.env, ["--resume", "sess-recorded"], elsewhere);
  assert.equal(recorded.code, 0, recorded.err.join("\n"));
  assert.equal(launches(home.callsPath)[0].cwd, home.checkout);

  const inside = await runOpen(home.env, ["--resume", "sess-inside"], worktree);
  assert.equal(inside.code, 0, inside.err.join("\n"));
  assert.equal(launches(home.callsPath)[1].cwd, worktree);

  const plain = await runOpen(home.env, [], worktree);
  assert.equal(plain.code, 0, plain.err.join("\n"));
  assert.equal(launches(home.callsPath)[2].cwd, home.home);
  assert.equal(launches(home.callsPath)[2].project, home.project.id);

  const moved = await runOpen(home.env, ["alpha", "--resume", "sess-moved"], elsewhere);
  assert.equal(moved.code, 0, moved.err.join("\n"));
  assert.equal(launches(home.callsPath)[3].cwd, home.home);
});

test("a registered project whose checkout is gone still opens, preselected by its id", async (t) => {
  const home = openHome(t, "open-gone");
  rmSync(home.checkout, { recursive: true, force: true });

  const result = await runOpen(home.env, ["alpha"], home.base);

  assert.equal(result.code, 0, result.err.join("\n"));
  const [call] = launches(home.callsPath);
  assert.equal(call.cwd, home.home);
  assert.equal(call.project, home.project.id);
});

test("`--prompt <text>` replaces the opening prompt verbatim, and follows `--resume <session>` when resuming", async (t) => {
  const home = openHome(t, "open-prompt");

  const fresh = await runOpen(home.env, ["--prompt", "Analyse KEY-3: fix it"], home.checkout);
  assert.equal(fresh.code, 0, fresh.err.join("\n"));
  const [first] = launches(home.callsPath);
  assert.equal(first.argv.at(-1), "Analyse KEY-3: fix it");
  assert.equal(first.argv.includes(OPERATOR_OPENING_PROMPT), false);

  const resumed = await runOpen(home.env, ["--resume", "abc-12345", "--prompt=hi"], home.checkout);
  assert.equal(resumed.code, 0, resumed.err.join("\n"));
  assert.deepEqual(launches(home.callsPath)[1].argv.slice(-3), ["--resume", "abc-12345", "hi"]);
});

test("a `--prompt` that starts with `-` or is empty is refused, and claude never starts", async (t) => {
  const home = openHome(t, "open-prompt-refused");

  for (const argv of [["--prompt=-x"], ["--prompt=--dangerously-skip-permissions"], ["--prompt", "   "]]) {
    const refused = await runOpen(home.env, argv, home.checkout);
    assert.equal(refused.code, 1, argv.join(" "));
    assert.match(refused.err.join("\n"), /--prompt/);
    assert.equal(existsSync(home.callsPath), false, `claude started for ${argv.join(" ")}`);
  }
  const ambiguous = await runOpen(home.env, ["--prompt", "-x"], home.checkout);
  assert.equal(ambiguous.code, 1);
  assert.equal(existsSync(home.callsPath), false);
});
