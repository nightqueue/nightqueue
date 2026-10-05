import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runtimePackageDir, studioTerminalsDir } from "../../src/config/paths.mjs";
import { OPERATOR_OPENING_PROMPT } from "../../src/host/operator.mjs";
import { packageRoot, spawnRoot } from "../../src/host/paths.mjs";
import { recordRunFields } from "../../src/queue/run-state.mjs";
import { loadPty } from "../../src/studio/pty.mjs";
import { INSTRUCTION_MAX, SPAWN_SELF_ENV, TerminalRefusal, createTerminalManager, parsePsLine, parseResize } from "../../src/studio/terminal.mjs";
import { initGitRepo } from "../../test-support/git.mjs";
import { FIXED_PROJECT_ID, makeDir, makeHome, makeProject, registerCheckout } from "../../test-support/memory.mjs";
import { fakePtyFactory } from "../../test-support/studio.mjs";

const PORT = 4321;
const ENTRY_FIXTURE = "/fake/runtime/bin/nightqueue.mjs";
const LSTART = "Mon Oct 5 14:00:00 2026";
const TIMING = { killGraceMs: 60, exitedTtlMs: 1000 };
const SESSION = "0123456789abcdef-session";
const FAKE_CLAUDE = fileURLToPath(new URL("../../test-support/fake-claude-open.mjs", import.meta.url));
const TERMINAL_SOURCE = fileURLToPath(new URL("../../src/studio/terminal.mjs", import.meta.url));

// The CLI entry a terminal of that home runs (a temp home has no runtime, so this tree's bin).
function entryOf(env) {
  return join(spawnRoot(env), "bin", "nightqueue.mjs");
}

// A terminal manager over a fake pty and fake process table, closed when the test ends.
function makeManager(t, env, { fake = fakePtyFactory(), deps = {}, port = PORT } = {}) {
  const errors = [];
  const manager = createTerminalManager({
    env,
    port,
    timing: TIMING,
    deps: {
      loadPty: fake.loadPty,
      killImpl: fake.killImpl,
      psImpl: () => ({ lstart: LSTART, command: `${process.execPath} ${entryOf(env)} open alpha` }),
      isAlive: () => false,
      err: (line) => errors.push(line),
      ...deps,
    },
  });
  t.after(() => manager.closeAll());
  return { manager, fake, errors };
}

// Awaits a promise expected to reject with a TerminalRefusal and answers it.
async function refusal(promise) {
  try {
    await promise;
  } catch (err) {
    assert.ok(err instanceof TerminalRefusal, `not a TerminalRefusal: ${err?.stack ?? err}`);
    return err;
  }
  assert.fail("the call was not refused");
}

// A job row as the store answers it, with its checkout inline so no registry is read.
function jobRow(status, checkout, { id = 125, slug = "j-125-run" } = {}) {
  return { id, status, slug, project: "alpha", project_id: FIXED_PROJECT_ID, project_path: checkout, last_session_id: SESSION, attempts: 1 };
}

// A fake websocket client that records what the manager sends it and lets a test send frames back.
function fakeClient() {
  const handlers = { message: null, close: null };
  return {
    sent: [],
    closed: null,
    sendBinary(buffer) {
      this.sent.push(Buffer.from(buffer).toString("utf8"));
      return true;
    },
    close(code, reason) {
      this.closed = { code, reason };
    },
    onMessage: (fn) => {
      handlers.message = fn;
    },
    onClose: (fn) => {
      handlers.close = fn;
    },
    send: (payload, binary) => handlers.message(Buffer.from(payload), binary),
  };
}

// Writes one registration file the way a studio does.
function writeRegistrationFile(env, registration) {
  mkdirSync(studioTerminalsDir(env), { recursive: true });
  const path = join(studioTerminalsDir(env), `${registration.port}-${registration.id}.json`);
  writeFileSync(path, JSON.stringify({ bin: process.execPath, entry: ENTRY_FIXTURE, lstart: LSTART, owner_pid: 999_999, kind: "operator", ...registration }));
  return path;
}

test("the loader answers unavailable with the import's reason, and a create then answers 503", async (t) => {
  const missing = await loadPty({ deps: { importImpl: async () => Promise.reject(new Error("Cannot find package 'node-pty'\nmore")) } });
  assert.deepEqual(missing, { available: false, reason: "Cannot find package 'node-pty'" });

  const env = makeHome(t, "term-unavailable");
  const project = makeProject(t, env, "alpha");
  assert.ok(project);
  const { manager } = makeManager(t, env, { deps: { loadPty: async () => missing } });
  const listing = await manager.list();
  assert.equal(listing.available, false);
  assert.equal(listing.reason, "Cannot find package 'node-pty'");
  const err = await refusal(manager.create({ kind: "operator", project: "alpha" }));
  assert.equal(err.status, 503);
  assert.match(err.message, /terminal unavailable: Cannot find package 'node-pty'/);
});

test("on darwin the loader chmods a spawn-helper that is not executable, and only reports it without `fix`", async () => {
  const dir = "/x/node-pty";
  const helper = `${dir}/prebuilds/darwin-arm64/spawn-helper`;
  const modes = new Map();
  const deps = (chmodImpl) => ({
    platform: "darwin",
    arch: "arm64",
    importImpl: async () => ({ default: { spawn() {} } }),
    resolvePackageImpl: () => ({ dir, version: "1.1.0" }),
    accessImpl: async (path, mode) => {
      if (path !== helper) throw new Error("ENOENT");
      if (mode !== 0 && modes.get(path) !== 0o755) throw new Error("EACCES");
    },
    chmodImpl,
  });
  const report = await loadPty({ fix: false, deps: deps(async () => assert.fail("doctor's load chmodded")) });
  assert.deepEqual(report, { available: false, reason: `spawn-helper not executable (${helper})`, helper });

  const refused = await loadPty({ deps: deps(async () => Promise.reject(new Error("EPERM"))) });
  assert.equal(refused.available, false);

  const fixed = await loadPty({ deps: deps(async (path, mode) => modes.set(path, mode)) });
  assert.equal(fixed.available, true);
  assert.equal(fixed.version, "1.1.0");
  assert.equal(modes.get(helper), 0o755);
});

test("an operator terminal runs `nightqueue open <project>` in the registry's checkout, and is recorded for the reaper", async (t) => {
  const env = makeHome(t, "term-operator");
  const checkout = realpathSync(makeProject(t, env, "alpha"));
  const { manager, fake } = makeManager(t, env);
  const { terminal, reused } = await manager.create({ kind: "operator", project: "alpha" });
  assert.equal(reused, false);
  assert.equal(terminal.label, "alpha operator");
  assert.equal(terminal.cwd, checkout);
  const child = fake.spawned[0];
  assert.equal(child.file, process.execPath);
  assert.deepEqual(child.args, [entryOf(env), "open", "alpha"]);
  assert.equal(child.options.cwd, checkout);
  assert.equal(child.options.encoding, null);
  assert.equal(child.options.env.NIGHTQUEUE_HOME, env.NIGHTQUEUE_HOME);
  assert.equal(child.options.env.TERM, "xterm-256color");
  const registration = JSON.parse(readFileSync(join(studioTerminalsDir(env), `${PORT}-${terminal.id}.json`), "utf8"));
  assert.equal(registration.pid, child.pid);
  assert.equal(registration.owner_pid, process.pid);
  assert.equal(registration.lstart, LSTART);
  assert.equal(registration.bin, process.execPath);
  assert.equal(registration.entry, entryOf(env));

  assert.equal((await refusal(manager.create({ kind: "operator", project: "nope" }))).status, 404);
});

test("a terminal child never inherits the studio's token nor any other `NIGHTQUEUE_STUDIO_*` setting", async (t) => {
  const env = { ...makeHome(t, "term-env"), NIGHTQUEUE_STUDIO_TOKEN: "secret-token", [SPAWN_SELF_ENV]: "1", KEEP_ME: "yes" };
  makeProject(t, env, "alpha");
  const { manager, fake } = makeManager(t, env);
  await manager.create({ kind: "operator", project: "alpha" });
  const childEnv = fake.spawned[0].options.env;
  assert.deepEqual(Object.keys(childEnv).filter((key) => key.startsWith("NIGHTQUEUE_STUDIO_")), []);
  assert.equal(childEnv.KEEP_ME, "yes");
  assert.equal(childEnv.NIGHTQUEUE_HOME, env.NIGHTQUEUE_HOME);
});

test("a terminal runs the installed runtime's CLI, and the studio's own tree only when the dev loop asks for it", async (t) => {
  const env = makeHome(t, "term-cli-root");
  makeProject(t, env, "alpha");
  const installedBin = join(runtimePackageDir(env), "bin");
  mkdirSync(installedBin, { recursive: true });
  writeFileSync(join(installedBin, "nightqueue.mjs"), "");
  const installedEntry = join(realpathSync(runtimePackageDir(env)), "bin", "nightqueue.mjs");
  const ownEntry = join(packageRoot(), "bin", "nightqueue.mjs");
  assert.notEqual(installedEntry, ownEntry);

  const runtime = makeManager(t, env);
  await runtime.manager.create({ kind: "operator", project: "alpha" });
  assert.equal(runtime.fake.spawned[0].args[0], installedEntry);

  const dev = makeManager(t, { ...env, [SPAWN_SELF_ENV]: "1" });
  await dev.manager.create({ kind: "operator", project: "alpha" });
  assert.equal(dev.fake.spawned[0].args[0], ownEntry);
});

test("a body key the studio does not read, `cwd` above all, is a 400", async (t) => {
  const env = makeHome(t, "term-cwd");
  makeProject(t, env, "alpha");
  const { manager, fake } = makeManager(t, env);
  const err = await refusal(manager.create({ kind: "operator", project: "alpha", cwd: "/tmp" }));
  assert.equal(err.status, 400);
  assert.match(err.message, /never the request/);
  assert.equal((await refusal(manager.create({ kind: "shell" }))).status, 400);
  assert.equal(fake.spawned.length, 0);
});

test("the sixth terminal opens and the seventh is refused, even when the creates race", async (t) => {
  const env = makeHome(t, "term-cap");
  makeProject(t, env, "alpha");
  const { manager, fake } = makeManager(t, env);
  const results = await Promise.allSettled(Array.from({ length: 8 }, () => manager.create({ kind: "operator", project: "alpha" })));
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 6);
  const refused = results.filter((result) => result.status === "rejected").map((result) => result.reason);
  assert.deepEqual(refused.map((err) => err.status), [409, 409]);
  assert.match(refused[0].message, /6 terminals are open, the cap/);
  assert.equal(fake.spawned.length, 6);

  fake.spawned[0].emitExit(0);
  await manager.create({ kind: "operator", project: "alpha" });
  assert.equal(fake.spawned.length, 7);
});

test("a session opens only for gate, failed, done and cancelled jobs, in the run's worktree or the checkout", async (t) => {
  const env = makeHome(t, "term-session");
  const checkout = makeDir(t, "term-checkout");
  const worktree = makeDir(t, "term-worktree");
  recordRunFields({ projectId: FIXED_PROJECT_ID, slug: "j-125-run", fields: { worktree }, env });
  recordRunFields({ projectId: FIXED_PROJECT_ID, slug: "j-126-run", fields: { worktree: join(worktree, "gone") }, env });
  const jobs = new Map();
  const { manager, fake } = makeManager(t, env, { deps: { readJob: async (id) => jobs.get(id) ?? null } });

  for (const status of ["pending", "running", "closed"]) {
    jobs.set(125, jobRow(status, checkout));
    const err = await refusal(manager.create({ kind: "session", job: "J-125" }));
    assert.equal(err.status, 409);
    assert.match(err.message, new RegExp(`J-125 is ${status}`));
  }
  assert.equal(fake.spawned.length, 0);

  for (const [index, status] of ["gate", "failed", "done", "cancelled"].entries()) {
    jobs.set(200 + index, jobRow(status, checkout, { id: 200 + index }));
    await manager.create({ kind: "session", job: `J-${200 + index}` });
    const child = fake.spawned.at(-1);
    assert.deepEqual(child.args.slice(1), ["queue", "session", `J-${200 + index}`], status);
  }

  jobs.set(125, jobRow("done", checkout));
  const inWorktree = await manager.create({ kind: "session", job: "J-125" });
  assert.equal(inWorktree.terminal.cwd, worktree);
  assert.equal(inWorktree.terminal.label, "J-125 session");
  assert.equal(inWorktree.terminal.note, null);
  jobs.set(126, jobRow("done", checkout, { id: 126, slug: "j-126-run" }));
  const released = await manager.create({ kind: "session", job: "J-126" });
  assert.equal(released.terminal.cwd, checkout);
  assert.match(released.terminal.note, /worktree was released/);

  assert.equal((await refusal(manager.create({ kind: "session", job: "J-999" }))).status, 404);
  assert.equal((await refusal(manager.create({ kind: "session", job: "nope" }))).status, 400);
});

test("a second session of one job reuses the open tab, and an instruction for it is refused", async (t) => {
  const env = makeHome(t, "term-reuse");
  const checkout = makeDir(t, "term-checkout");
  const { manager, fake } = makeManager(t, env, { deps: { readJob: async () => jobRow("gate", checkout) } });
  const first = await manager.create({ kind: "session", job: "J-125" });
  const again = await manager.create({ kind: "session", job: "J-125" });
  assert.equal(again.reused, true);
  assert.equal(again.terminal.id, first.terminal.id);
  assert.equal(fake.spawned.length, 1);
  const err = await refusal(manager.create({ kind: "session", job: "J-125", instruction: "look" }));
  assert.equal(err.status, 409);
});

test("an instruction over the cap, empty, or starting with `-` is refused before any spawn; one at the cap goes as one `--prompt=` element and nothing is ever typed", async (t) => {
  const env = makeHome(t, "term-instruction");
  makeProject(t, env, "alpha");
  const { manager, fake } = makeManager(t, env);
  for (const instruction of ["x".repeat(INSTRUCTION_MAX + 1), " \n\t ", "--dangerously-skip-permissions", " -x"]) {
    const err = await refusal(manager.create({ kind: "operator", project: "alpha", instruction }));
    assert.equal(err.status, 400, instruction.slice(0, 40));
  }
  assert.equal(fake.spawned.length, 0);

  const text = `Analyse I-1:\nfix${"y".repeat(INSTRUCTION_MAX - 16)}`;
  assert.equal([...text].length, INSTRUCTION_MAX);
  const { terminal } = await manager.create({ kind: "operator", project: "alpha", instruction: text });
  const child = fake.spawned[0];
  assert.equal(child.args.at(-1), `--prompt=${text.replace("\n", " ")}`);
  assert.equal(terminal.instruction, "given");
  child.emitData("Do you trust the files in this folder?\r\n❯ 1. Yes, proceed\r\n  2. No, exit");
  await sleep(1600);
  assert.deepEqual(child.writes, [], "the studio wrote to the pty without a client");
  assert.equal(JSON.stringify(await manager.list()).includes("fixyyy"), false, "the instruction text is stored");
});

test("only one `child.write(` exists in the terminal manager: the attached client's input", () => {
  const source = readFileSync(TERMINAL_SOURCE, "utf8");
  assert.equal(source.match(/child\.write\(/g)?.length, 1);
});

test("a session with an instruction runs `queue session J-n --prompt=<text>`, and one without runs it bare", async (t) => {
  const env = makeHome(t, "term-session-prompt");
  const checkout = makeDir(t, "term-checkout");
  const { manager, fake } = makeManager(t, env, { deps: { readJob: async (id) => jobRow("gate", checkout, { id, slug: `j-${id}-run` }) } });
  await manager.create({ kind: "session", job: "J-125", instruction: "look at the gate" });
  assert.deepEqual(fake.spawned[0].args.slice(1), ["queue", "session", "J-125", "--prompt=look at the gate"]);
  await manager.create({ kind: "session", job: "J-126" });
  assert.deepEqual(fake.spawned[1].args.slice(1), ["queue", "session", "J-126"]);
});

test("the argv the studio spawns is a working nightqueue command that starts claude with the instruction as its first prompt", async (t) => {
  const env = makeHome(t, "term-e2e");
  delete env.NIGHTQUEUE_MODE;
  const base = realpathSync(makeDir(t, "term-e2e-host"));
  const checkout = initGitRepo(join(base, "checkout"));
  for (const dir of ["user-home", "claude-config"]) mkdirSync(join(base, dir));
  const claude = join(base, "claude");
  copyFileSync(FAKE_CLAUDE, claude);
  chmodSync(claude, 0o755);
  const callsPath = join(base, "calls.jsonl");
  Object.assign(env, { HOME: join(base, "user-home"), CLAUDE_CONFIG_DIR: join(base, "claude-config"), NIGHTQUEUE_CLAUDE_BIN: claude, NIGHTQUEUE_FAKE_CALLS: callsPath });
  registerCheckout(env, { path: checkout, name: "alpha" });
  const { manager, fake } = makeManager(t, env);
  await manager.create({ kind: "operator", project: "alpha", instruction: "Analyse KEY-3: fix it" });
  const { file, args, options } = fake.spawned[0];

  const result = spawnSync(file, args, { cwd: options.cwd, env: options.env, encoding: "utf8", timeout: 60_000 });

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const launches = readFileSync(callsPath, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  assert.equal(launches.length, 1);
  assert.equal(launches[0].argv.at(-1), "Analyse KEY-3: fix it");
  assert.equal(launches[0].argv.includes(OPERATOR_OPENING_PROMPT), false);
  assert.equal(launches[0].mode, "operator");
});

test("a create still loading when the studio closes is refused, and no child is ever spawned", async (t) => {
  const env = makeHome(t, "term-close-race");
  const checkout = makeDir(t, "term-checkout");
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const readProject = async () => {
    await gate;
    return { name: "alpha", path: checkout };
  };
  const { manager, fake } = makeManager(t, env, { deps: { readProject } });
  const pending = manager.create({ kind: "operator", project: "alpha" }).then(
    () => null,
    (err) => err,
  );
  await sleep(30);
  manager.closeAll();
  release();
  const err = await pending;
  assert.equal(err?.status, 503);
  assert.equal(fake.spawned.length, 0);
});

test("closing a terminal hangs up its process group, kills it after the grace period, and drops its registration", async (t) => {
  const env = makeHome(t, "term-delete");
  makeProject(t, env, "alpha");
  const fake = fakePtyFactory({ ignoresHangUp: true });
  const { manager } = makeManager(t, env, { fake });
  const { terminal } = await manager.create({ kind: "operator", project: "alpha" });
  const pid = fake.spawned[0].pid;
  const file = join(studioTerminalsDir(env), `${PORT}-${terminal.id}.json`);
  assert.ok(existsSync(file));
  assert.deepEqual(manager.remove(terminal.id), { id: terminal.id, ended: true });
  assert.deepEqual(fake.signals, [{ pid: -pid, signal: "SIGHUP" }]);
  assert.deepEqual((await manager.list()).terminals, []);
  await sleep(TIMING.killGraceMs * 2);
  assert.deepEqual(fake.signals, [{ pid: -pid, signal: "SIGHUP" }, { pid: -pid, signal: "SIGKILL" }]);
  assert.equal(existsSync(file), false);
  assert.throws(() => manager.remove(terminal.id), (err) => err.status === 404);
});

test("a child that obeys the hang-up is never sent SIGKILL", async (t) => {
  const env = makeHome(t, "term-hangup");
  makeProject(t, env, "alpha");
  const { manager, fake } = makeManager(t, env);
  const { terminal } = await manager.create({ kind: "operator", project: "alpha" });
  manager.remove(terminal.id);
  await sleep(TIMING.killGraceMs * 2);
  assert.deepEqual(fake.signals.map((entry) => entry.signal), ["SIGHUP"]);
  assert.deepEqual(readdirSync(studioTerminalsDir(env)), []);
});

test("a claude that outlives its nightqueue parent is killed with the group, on close and on the parent's own exit", async (t) => {
  const env = makeHome(t, "term-lingering");
  makeProject(t, env, "alpha");
  const fake = fakePtyFactory({ groupOutlivesLeader: true });
  const { manager } = makeManager(t, env, { fake });
  const closed = await manager.create({ kind: "operator", project: "alpha" });
  const first = fake.spawned[0].pid;
  manager.remove(closed.terminal.id);
  await sleep(TIMING.killGraceMs * 2);
  assert.deepEqual(fake.signals, [{ pid: -first, signal: "SIGHUP" }, { pid: -first, signal: "SIGKILL" }]);

  fake.signals.length = 0;
  await manager.create({ kind: "operator", project: "alpha" });
  const child = fake.spawned[1];
  child.emitExit(0);
  await sleep(TIMING.killGraceMs * 2);
  assert.deepEqual(fake.signals, [{ pid: -child.pid, signal: "SIGHUP" }, { pid: -child.pid, signal: "SIGKILL" }]);
});

test("a pty paused for a full client resumes once a newer client replaces it", async (t) => {
  const env = makeHome(t, "term-paused-replace");
  makeProject(t, env, "alpha");
  const { manager, fake } = makeManager(t, env);
  const { terminal } = await manager.create({ kind: "operator", project: "alpha" });
  const child = fake.spawned[0];
  const full = { ...fakeClient(), socket: new EventEmitter(), sendBinary: () => false };
  manager.attach(terminal.id, full);
  child.emitData("first");
  assert.equal(child.paused, true);
  const fresh = fakeClient();
  manager.attach(terminal.id, fresh);
  assert.equal(child.paused, false, "the pty is still paused for the replaced client");
  child.emitData("x");
  assert.ok(fresh.sent.join("").includes("x"));
  full.socket.emit("drain");
  assert.equal(child.paused, false);
});

test("the reaper never kills on a registration without a start time or without the CLI entry, and removes it", async (t) => {
  const env = makeHome(t, "term-reap-unverified");
  const noStart = writeRegistrationFile(env, { id: "a".repeat(16), port: PORT, pid: 201, lstart: null });
  const noEntry = writeRegistrationFile(env, { id: "b".repeat(16), port: PORT, pid: 202, entry: undefined });
  const kills = [];
  const { manager } = makeManager(t, env, {
    deps: {
      psImpl: () => ({ lstart: LSTART, command: `${process.execPath} ${ENTRY_FIXTURE} open alpha` }),
      killImpl: (pid, signal) => kills.push({ pid, signal }),
    },
  });
  assert.equal(manager.reap(), 0);
  await sleep(TIMING.killGraceMs * 2);
  assert.deepEqual(kills, []);
  assert.equal(existsSync(noStart), false);
  assert.equal(existsSync(noEntry), false);
});

test("an attach replays the scrollback, carries input and resizes, and the newest attach wins", async (t) => {
  const env = makeHome(t, "term-attach");
  makeProject(t, env, "alpha");
  const { manager, fake } = makeManager(t, env);
  const { terminal } = await manager.create({ kind: "operator", project: "alpha" });
  const child = fake.spawned[0];
  child.emitData("before attach");
  const first = fakeClient();
  manager.attach(terminal.id, first);
  assert.deepEqual(first.sent, ["before attach"]);
  child.emitData(" live");
  assert.deepEqual(first.sent, ["before attach", " live"]);
  first.send("ls\r", true);
  first.send(JSON.stringify({ resize: { cols: 100, rows: 40 } }), false);
  first.send(JSON.stringify({ resize: { cols: 9000, rows: 40 } }), false);
  first.send("not json", false);
  assert.deepEqual(child.writes, ["ls\r"]);
  assert.deepEqual(child.resizes, [{ cols: 100, rows: 40 }]);
  assert.equal((await manager.list()).terminals[0].attached, true);

  const second = fakeClient();
  manager.attach(terminal.id, second);
  assert.deepEqual(first.closed, { code: 4001, reason: "attached elsewhere" });
  assert.deepEqual(second.sent, ["before attach live"]);

  child.emitExit(3);
  assert.deepEqual(second.closed, { code: 1000, reason: "exited 3" });
  assert.deepEqual((await manager.list()).terminals[0].exited, { code: 3, signal: null });
  assert.throws(() => manager.attach(terminal.id, fakeClient()), (err) => err.status === 404);
});

test("the reaper ends this port's leftovers and dead owners', and spares a recycled pid and a live studio's terminals", async (t) => {
  const env = makeHome(t, "term-reap");
  const signals = [];
  const table = new Map([
    [101, { lstart: LSTART, command: `node ${ENTRY_FIXTURE} open alpha` }],
    [102, { lstart: "Tue Oct 6 09:00:00 2026", command: `node ${ENTRY_FIXTURE} open alpha` }],
    [103, { lstart: LSTART, command: `node ${ENTRY_FIXTURE} open alpha` }],
    [104, { lstart: LSTART, command: `node ${ENTRY_FIXTURE} queue session J-1` }],
  ]);
  const same = writeRegistrationFile(env, { id: "a".repeat(16), port: PORT, pid: 101 });
  const recycled = writeRegistrationFile(env, { id: "b".repeat(16), port: PORT, pid: 102 });
  const liveOwner = writeRegistrationFile(env, { id: "c".repeat(16), port: 5555, pid: 103, owner_pid: 7 });
  const deadOwner = writeRegistrationFile(env, { id: "d".repeat(16), port: 6666, pid: 104, owner_pid: 8 });
  const broken = join(studioTerminalsDir(env), `${PORT}-${"e".repeat(16)}.json`);
  writeFileSync(broken, "{not json");
  const { manager, errors } = makeManager(t, env, {
    deps: {
      psImpl: (pid) => table.get(pid) ?? null,
      isAlive: (pid) => pid === 7 || table.has(pid),
      killImpl: (pid, signal) => {
        if (signal === 0) {
          if (!table.has(Math.abs(pid))) throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
          return;
        }
        signals.push({ pid, signal });
        if (signal === "SIGKILL") table.delete(Math.abs(pid));
      },
    },
  });
  assert.equal(manager.reap(), 2);
  assert.deepEqual(signals, [{ pid: -101, signal: "SIGHUP" }, { pid: -104, signal: "SIGHUP" }]);
  for (const path of [same, recycled, deadOwner, broken]) assert.equal(existsSync(path), false, path);
  assert.equal(existsSync(liveOwner), true);
  assert.deepEqual(errors, ["studio: reaped 2 terminal(s) left by an earlier studio"]);
  await sleep(TIMING.killGraceMs * 2);
  assert.deepEqual(signals.slice(2), [{ pid: -101, signal: "SIGKILL" }, { pid: -104, signal: "SIGKILL" }]);
});

test("a create from inside a job against the runner's home is refused, and a temporary home is allowed", async (t) => {
  const env = makeHome(t, "term-inside-job");
  makeProject(t, env, "alpha");
  const runner = { ...env, NIGHTQUEUE_JOB_ID: "59", NIGHTQUEUE_JOB_HOME: env.NIGHTQUEUE_HOME };
  const { manager: inside, fake } = makeManager(t, runner);
  const err = await refusal(inside.create({ kind: "operator", project: "alpha" }));
  assert.equal(err.status, 403);
  assert.match(err.message, /from inside J-59/);
  assert.equal(fake.spawned.length, 0);

  const temporary = { ...env, NIGHTQUEUE_JOB_ID: "59", NIGHTQUEUE_JOB_HOME: makeDir(t, "runner-home") };
  const { manager: allowed } = makeManager(t, temporary);
  assert.equal((await allowed.create({ kind: "operator", project: "alpha" })).reused, false);
});

test("ps lines and resize frames are read strictly", () => {
  assert.deepEqual(parsePsLine("Mon Oct  5 14:00:00 2026     /fake/bin/claude --agent x\n"), { lstart: LSTART, command: "/fake/bin/claude --agent x" });
  assert.equal(parsePsLine(""), null);
  assert.deepEqual(parseResize('{"resize":{"cols":80,"rows":24}}'), { cols: 80, rows: 24 });
  assert.equal(parseResize('{"resize":{"cols":1,"rows":24}}'), null);
  assert.equal(parseResize('{"resize":{"cols":80.5,"rows":24}}'), null);
  assert.equal(parseResize("{"), null);
});
