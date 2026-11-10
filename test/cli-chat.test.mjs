import assert from "node:assert/strict";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { defaultContext, run, skipsLock } from "../src/cli/index.mjs";
import { agentsDir, homeDir, sessionsDir } from "../src/config/paths.mjs";
import { pluginDir } from "../src/host/claude-launch.mjs";
import { chatSettings } from "../src/host/settings.mjs";
import { readSession } from "../src/sessions/registry.mjs";
import { initGitRepo } from "../test-support/git.mjs";
import { makeDir, makeHome, registerCheckout } from "../test-support/memory.mjs";

const FAKE_CLAUDE = fileURLToPath(new URL("../test-support/fake-claude-chat.mjs", import.meta.url));

// A temp home with a registered checkout `alpha`, a temp Claude config dir and the fake interactive claude.
function chatHome(t, name) {
  const env = makeHome(t, name);
  delete env.NIGHTQUEUE_MODE;
  delete env.NIGHTQUEUE_CHAT_WORKTREE;
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

// Runs one CLI command in this process from a directory, capturing stdout and stderr.
async function cli(env, argv, cwd) {
  const out = [];
  const err = [];
  const code = await run(argv, { ...defaultContext(), env, cwd, out: (line) => out.push(line), err: (line) => err.push(line) });
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

// The id a `chat` launch line names.
function launchedId(out) {
  const line = out.find((entry) => entry.startsWith("chat · "));
  return line.split(" · ")[1];
}

test("three chat sessions with different agents start, stop, list as stopped and resume with their own agent and Claude session", async (t) => {
  const home = chatHome(t, "chat-three");
  const created = await cli(home.env, ["agent", "new", "rev"], home.base);
  assert.equal(created.code, 0, created.err.join("\n"));
  const ids = [];
  for (const agent of [[], ["coder"], ["rev"]]) {
    const result = await cli(home.env, ["chat", ...agent], home.checkout);
    assert.equal(result.code, 0, result.err.join("\n"));
    ids.push(launchedId(result.out));
  }
  const calls = launches(home.callsPath);
  assert.equal(calls.length, 3);
  assert.equal(calls[0].argv.includes("--agent"), false, "a chat with no agent is plain claude with the plugin");
  assert.equal(argValue(calls[1].argv, "--agent"), "nightqueue:coder");
  assert.equal(argValue(calls[2].argv, "--agent"), "rev");
  assert.equal(JSON.parse(argValue(calls[2].argv, "--agents")).rev.description.length > 0, true);
  for (const [index, call] of calls.entries()) {
    const record = readSession(ids[index], home.env);
    assert.equal(argValue(call.argv, "--session-id"), record.claudeSessionId);
    assert.equal(call.cwd, home.checkout, "a session in a registered checkout runs at the checkout");
    assert.equal(argValue(call.argv, "--plugin-dir"), pluginDir());
    assert.deepEqual(JSON.parse(argValue(call.argv, "--settings")), chatSettings());
    assert.equal(argValue(call.argv, "--permission-mode"), "default");
    assert.equal(call.mode, null, "a chat is never in operator mode");
    assert.equal(existsSync(join(sessionsDir(home.env), `${record.id}.launcher`)), false, "a closed session keeps no launch claim");
  }

  const listed = await cli(home.env, ["sessions", "list"], home.base);
  assert.equal(listed.code, 0, listed.err.join("\n"));
  assert.equal(listed.out.length, 3);
  assert.ok(listed.out.every((line) => line.includes(" · stopped · ")));

  const resumed = await cli(home.env, ["chat", "--resume", ids[2], "--prompt", "go on"], home.base);
  assert.equal(resumed.code, 0, resumed.err.join("\n"));
  const last = launches(home.callsPath).at(-1);
  const record = readSession(ids[2], home.env);
  assert.deepEqual(last.argv.slice(-3), ["--resume", record.claudeSessionId, "go on"]);
  assert.equal(argValue(last.argv, "--agent"), "rev");
  assert.equal(last.argv.includes("--session-id"), false);
  assert.equal(last.cwd, home.checkout, "a resumed session runs in its recorded directory");
});

test("resume refuses an unknown id, a session still open, a directory gone, a session with no transcript and extra placement flags", async (t) => {
  const home = chatHome(t, "chat-resume-refusals");
  const unknown = await cli(home.env, ["chat", "--resume", "01ARZ3NDEKTSV4RRFFQ69G5FAV"], home.base);
  assert.equal(unknown.code, 1);
  assert.match(unknown.err.join("\n"), /unknown session/);

  home.env.NIGHTQUEUE_FAKE_NO_TRANSCRIPT = "1";
  const quiet = await cli(home.env, ["chat", "coder"], home.checkout);
  const quietId = launchedId(quiet.out);
  const noTranscript = await cli(home.env, ["chat", "--resume", quietId], home.base);
  assert.equal(noTranscript.code, 1);
  assert.match(noTranscript.err.join("\n"), /no Claude transcript/);
  delete home.env.NIGHTQUEUE_FAKE_NO_TRANSCRIPT;

  const fresh = await cli(home.env, ["chat", "--project", "alpha"], home.base);
  const id = launchedId(fresh.out);
  const claim = join(sessionsDir(home.env), `${id}.launcher`);
  writeFileSync(claim, JSON.stringify({ id, pid: process.pid, lstart: null, uptimeS: 0 }));
  const live = await cli(home.env, ["chat", "--resume", id], home.base);
  assert.equal(live.code, 1);
  assert.match(live.err.join("\n"), /still open \(pid \d+\)/);
  const liveRm = await cli(home.env, ["sessions", "rm", id], home.base);
  assert.equal(liveRm.code, 1);
  rmSync(claim);

  const withAgent = await cli(home.env, ["chat", "coder", "--resume", id], home.base);
  assert.equal(withAgent.code, 1);
  assert.match(withAgent.err.join("\n"), /reuses the agent, project and directory/);

  const callsBefore = launches(home.callsPath).length;
  rmSync(home.checkout, { recursive: true, force: true });
  const gone = await cli(home.env, ["chat", "--resume", id], home.base);
  assert.equal(gone.code, 1);
  assert.match(gone.err.join("\n"), /no longer exists/);
  assert.equal(launches(home.callsPath).length, callsBefore, "claude started for a refused resume");
});

test("an unknown agent is refused before any record is written; with no project a chat runs in its directory, never in the home", async (t) => {
  const home = chatHome(t, "chat-refusals");
  const elsewhere = realpathSync(makeDir(t, "chat-elsewhere"));
  const unknown = await cli(home.env, ["chat", "nope"], elsewhere);
  assert.equal(unknown.code, 1);
  assert.match(unknown.err.join("\n"), /unknown agent `nope`/);
  assert.equal(existsSync(sessionsDir(home.env)), false);

  const plain = await cli(home.env, ["chat"], elsewhere);
  assert.equal(plain.code, 0, plain.err.join("\n"));
  assert.equal(launches(home.callsPath)[0].cwd, elsewhere);
  assert.equal(readSession(launchedId(plain.out), home.env).project, null);

  for (const cwd of [home.home, join(home.home, "runs")]) {
    mkdirSync(cwd, { recursive: true });
    const inHome = await cli(home.env, ["chat"], cwd);
    assert.equal(inHome.code, 1);
    assert.match(inHome.err.join("\n"), /a chat does not run in the nightqueue home; pass --project, --worktree .* or run it from another directory/);
  }
  assert.equal(launches(home.callsPath).length, 1, "claude started for a chat refused in the home");
});

test("`--worktree` on a git worktree under the home runs in the directory given and carries the entry to the guard; resume restores both", async (t) => {
  const home = chatHome(t, "chat-worktree");
  const worktree = join(home.home, "worktrees", "p", "s");
  const src = join(worktree, "src");
  mkdirSync(src, { recursive: true });
  writeFileSync(join(worktree, ".git"), `gitdir: ${home.checkout}/.git\n`);

  const result = await cli(home.env, ["chat", "coder", "--worktree", src], home.base);
  assert.equal(result.code, 0, result.err.join("\n"));
  const id = launchedId(result.out);
  assert.ok(result.out[0].endsWith(" · worktree"));
  const [call] = launches(home.callsPath);
  assert.equal(call.cwd, src, "a subdirectory of the entry stays the cwd");
  assert.equal(call.chatWorktree, worktree);
  assert.equal(readSession(id, home.env).worktree, worktree);

  const resumed = await cli(home.env, ["chat", "--resume", id], home.base);
  assert.equal(resumed.code, 0, resumed.err.join("\n"));
  assert.equal(launches(home.callsPath)[1].chatWorktree, worktree);
  assert.equal(launches(home.callsPath)[1].cwd, src);

  const fromInside = await cli(home.env, ["chat"], src);
  assert.equal(fromInside.code, 0, fromInside.err.join("\n"));
  assert.equal(launches(home.callsPath)[2].cwd, src, "a chat started inside a worktree entry runs there");
  assert.equal(launches(home.callsPath)[2].chatWorktree, worktree);
});

test("a worktree whose git directory is gone is refused, by `--worktree` and from inside it", async (t) => {
  const home = chatHome(t, "chat-worktree-dangling");
  const worktree = join(home.home, "worktrees", "p", "dangling");
  mkdirSync(worktree, { recursive: true });
  writeFileSync(join(worktree, ".git"), "gitdir: ../gone/.git\n");
  for (const [argv, cwd] of [[["chat", "--worktree", worktree], home.base], [["chat"], worktree]]) {
    const refused = await cli(home.env, argv, cwd);
    assert.equal(refused.code, 1);
    assert.match(refused.err.join("\n"), /is a git worktree whose git directory .*gone\/\.git no longer exists/);
  }
  assert.equal(launches(home.callsPath).length, 0);
});

test("`--worktree` elsewhere under the home is refused; outside the home it is only the cwd and an inherited worktree key is dropped", async (t) => {
  const home = chatHome(t, "chat-worktree-refusals");
  const runDir = join(home.home, "runs", "x");
  mkdirSync(runDir, { recursive: true });
  const refused = await cli(home.env, ["chat", "--worktree", runDir], home.base);
  assert.equal(refused.code, 1);
  assert.match(refused.err.join("\n"), /--worktree must be a git worktree under .* or a directory outside the nightqueue home/);
  const notGit = join(home.home, "worktrees", "p", "plain");
  mkdirSync(notGit, { recursive: true });
  assert.equal((await cli(home.env, ["chat", "--worktree", notGit], home.base)).code, 1);
  assert.equal((await cli(home.env, ["chat", "--worktree", join(home.base, "missing")], home.base)).code, 1);
  assert.equal(launches(home.callsPath).length, 0);

  const outside = realpathSync(makeDir(t, "chat-outside"));
  const env = { ...home.env, NIGHTQUEUE_CHAT_WORKTREE: join(home.home, "worktrees", "p", "plain") };
  const result = await cli(env, ["chat", "--worktree", outside], home.base);
  assert.equal(result.code, 0, result.err.join("\n"));
  const [call] = launches(home.callsPath);
  assert.equal(call.cwd, outside);
  assert.equal(call.chatWorktree, null, "an inherited NIGHTQUEUE_CHAT_WORKTREE leaked into a session without one");
  assert.equal(readSession(launchedId(result.out), env).worktree, null);
});

test("`chat operator` is `open`: same argv shape, same env, never recorded as a session", async (t) => {
  const home = chatHome(t, "chat-operator");
  const viaOpen = await cli(home.env, ["open", "--prompt", "hi"], home.checkout);
  const viaChat = await cli(home.env, ["chat", "operator", "--prompt", "hi"], home.checkout);
  assert.equal(viaOpen.code, 0, viaOpen.err.join("\n"));
  assert.equal(viaChat.code, 0, viaChat.err.join("\n"));
  const [a, b] = launches(home.callsPath);
  const withoutMcp = (argv) => argv.filter((_, index) => argv[index - 1] !== "--mcp-config" && argv[index] !== "--mcp-config");
  assert.deepEqual(withoutMcp(b.argv), withoutMcp(a.argv));
  assert.equal(b.mode, "operator");
  assert.equal(b.cwd, a.cwd);
  assert.deepEqual(viaChat.out, viaOpen.out);
  assert.equal(existsSync(sessionsDir(home.env)), false);
  const worktree = await cli(home.env, ["chat", "operator", "--worktree", home.base], home.checkout);
  assert.equal(worktree.code, 1);
});

test("`sessions show` and `rm` print the record and remove only it; `agent` lists, shows and refuses a built-in name", async (t) => {
  const home = chatHome(t, "chat-sessions-agent");
  const fresh = await cli(home.env, ["chat", "coder"], home.checkout);
  const id = launchedId(fresh.out);
  const shown = await cli(home.env, ["sessions", "show", id], home.base);
  assert.equal(shown.code, 0, shown.err.join("\n"));
  for (const label of ["state: stopped", "agent: coder (builtin)", `project: alpha (${home.project.id})`, `cwd: ${home.checkout}`, "worktree: none", `resume: nightqueue chat --resume ${id}`]) {
    assert.ok(shown.out.includes(label), `${label} in ${shown.out.join(" | ")}`);
  }
  const json = await cli(home.env, ["sessions", "list", "--json"], home.base);
  assert.equal(JSON.parse(json.out[0])[0].state, "stopped");
  const removed = await cli(home.env, ["sessions", "rm", id], home.base);
  assert.equal(removed.code, 0, removed.err.join("\n"));
  assert.match(removed.out[0], /record only/);
  assert.equal((await cli(home.env, ["sessions", "show", id], home.base)).code, 1);

  assert.equal((await cli(home.env, ["agent", "new", "triager"], home.base)).code, 1);
  const created = await cli(home.env, ["agent", "new", "rev"], home.base);
  assert.equal(created.code, 0, created.err.join("\n"));
  assert.ok(existsSync(join(agentsDir(home.env), "rev.md")));
  const listed = await cli(home.env, ["agent", "list"], home.base);
  assert.ok(listed.out.some((line) => line.startsWith("coder · built-in · ")));
  assert.ok(listed.out.some((line) => line.startsWith("rev · user · ")));
  const show = await cli(home.env, ["agent", "show", "rev"], home.base);
  assert.equal(show.code, 0, show.err.join("\n"));
  assert.match(show.out.join("\n"), /name: rev/);
  assert.equal((await cli(home.env, ["sessions", "nope"], home.base)).code, 1);
  assert.equal((await cli(home.env, ["agent"], home.base)).code, 1);
});

test("chat, sessions and agent take no configuration lock", () => {
  for (const command of ["chat", "sessions", "agent"]) assert.equal(skipsLock(command, [], {}), true, command);
});
