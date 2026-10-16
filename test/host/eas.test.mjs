import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  easAccountStatus,
  easBin,
  easEnv,
  easUpdateGroupUrl,
  execFileDetached,
  parseEasProjectFullName,
  parseEasWhoami,
  runEasAsync,
} from "../../src/host/eas.mjs";

// A temporary eas script that starts a long-lived child, writes its pid and waits for it.
function easWithGrandchild(t) {
  const dir = mkdtempSync(join(tmpdir(), "nq-eas-group-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, "eas");
  writeFileSync(bin, "#!/bin/sh\nsleep 30 &\necho $! > \"$NQ_PIDFILE\"\nwait\n");
  chmodSync(bin, 0o755);
  return { dir, bin, pidFile: join(dir, "pid") };
}

// Waits until a file exists, at most the given time.
async function untilExists(path, maxMs) {
  const end = Date.now() + maxMs;
  while (!existsSync(path) && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 20));
}

// Tells whether a process is still running.
function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// The pid the script's child wrote, killed for good after the check so no test leaves it behind.
async function grandchildAfter(t, pidFile) {
  assert.ok(existsSync(pidFile), "the eas script never recorded its child");
  const pid = Number(readFileSync(pidFile, "utf8").trim());
  await new Promise((resolve) => setTimeout(resolve, 200));
  const alive = isAlive(pid);
  if (alive) process.kill(pid, "SIGKILL");
  return { pid, alive };
}

// An in-process execFile double answering one scripted result and recording the call; no binary is ever spawned.
function fakeExecFile({ err = null, stdout = "", stderr = "" } = {}) {
  const calls = [];
  const impl = (file, args, options, callback) => {
    calls.push({ file, args, options });
    setImmediate(() => callback(err, stdout, stderr));
  };
  return { impl, calls };
}

test("easBin answers NIGHTQUEUE_EAS_BIN trimmed, or eas", () => {
  assert.equal(easBin({ NIGHTQUEUE_EAS_BIN: "  /opt/eas  " }), "/opt/eas");
  assert.equal(easBin({ NIGHTQUEUE_EAS_BIN: "   " }), "eas");
  assert.equal(easBin({}), "eas");
});

test("easEnv drops every NIGHTQUEUE_ variable and keeps the rest", () => {
  const env = easEnv({ PATH: "/bin", EXPO_TOKEN: "t", NIGHTQUEUE_HOME: "/h", NIGHTQUEUE_CLOSE_WORKER: "1" });
  assert.deepEqual(env, { PATH: "/bin", EXPO_TOKEN: "t" });
});

test("runEasAsync passes an env without NIGHTQUEUE_ variables, the cwd and a large buffer", async () => {
  const fake = fakeExecFile({ stdout: "ok" });
  const result = await runEasAsync(["whoami"], { cwd: "/tmp/x", env: { PATH: "/bin", NIGHTQUEUE_EAS_BIN: "/opt/eas", NIGHTQUEUE_HOME: "/h" }, execFileImpl: fake.impl });
  assert.equal(result.ok, true);
  assert.equal(result.code, 0);
  assert.equal(fake.calls[0].file, "/opt/eas");
  assert.deepEqual(fake.calls[0].args, ["whoami"]);
  assert.equal(fake.calls[0].options.cwd, "/tmp/x");
  assert.deepEqual(fake.calls[0].options.env, { PATH: "/bin" });
  assert.equal(fake.calls[0].options.maxBuffer, 16 * 1024 * 1024);
});

test("runEasAsync never rejects, even when execFile throws", async () => {
  const result = await runEasAsync(["whoami"], { env: {}, execFileImpl: () => { throw Object.assign(new Error("spawn eas ENOENT"), { code: "ENOENT" }); } });
  assert.equal(result.ok, false);
  assert.equal(result.missing, true);
});

test("parseEasWhoami reads the first line, without ANSI and without the EXPO_TOKEN suffix", () => {
  assert.equal(parseEasWhoami("alice\n"), "alice");
  assert.equal(parseEasWhoami("\n\u001b[1malice\u001b[22m (authenticated using EXPO_TOKEN)\nother"), "alice");
  assert.equal(parseEasWhoami(""), null);
  assert.equal(parseEasWhoami(undefined), null);
});

test("easAccountStatus answers a logged-in eas with its account", async () => {
  const fake = fakeExecFile({ stdout: "alice\n" });
  assert.deepEqual(await easAccountStatus({ env: {}, execFileImpl: fake.impl }), { installed: true, authenticated: true, login: "alice", host: null });
  assert.deepEqual(fake.calls[0].args, ["whoami"]);
  assert.equal(fake.calls[0].options.timeout, 15000);
});

test("easAccountStatus answers a logged-out eas, a missing binary and a timeout without throwing", async () => {
  const loggedOut = fakeExecFile({ err: Object.assign(new Error("exit 1"), { code: 1 }), stderr: "Not logged in" });
  assert.deepEqual(await easAccountStatus({ env: {}, execFileImpl: loggedOut.impl }), { installed: true, authenticated: false, login: null, host: null });
  const missing = fakeExecFile({ err: Object.assign(new Error("spawn eas ENOENT"), { code: "ENOENT" }) });
  assert.deepEqual(await easAccountStatus({ env: {}, execFileImpl: missing.impl }), { installed: false, authenticated: false, login: null, host: null });
  const slow = fakeExecFile({ err: Object.assign(new Error("killed"), { killed: true, signal: "SIGTERM" }) });
  assert.deepEqual(await easAccountStatus({ env: {}, execFileImpl: slow.impl }), { installed: true, authenticated: null, login: null, host: null });
});

test("easAccountStatus hands the caller's signal to the eas call", async () => {
  const fake = fakeExecFile({ stdout: "alice\n" });
  const controller = new AbortController();
  await easAccountStatus({ env: {}, execFileImpl: fake.impl, signal: controller.signal });
  assert.equal(fake.calls[0].options.signal, controller.signal);
});

test("an eas call that passes its timeout leaves no process it started alive", async (t) => {
  const script = easWithGrandchild(t);
  const env = { PATH: "/usr/bin:/bin", NQ_PIDFILE: script.pidFile, NIGHTQUEUE_EAS_BIN: script.bin };
  const result = await runEasAsync(["update"], { cwd: script.dir, env, timeoutMs: 10000 });
  assert.equal(result.unfinished, true);
  const grandchild = await grandchildAfter(t, script.pidFile);
  assert.equal(grandchild.alive, false, `grandchild pid ${grandchild.pid} survived the eas timeout`);
});

test("an aborted eas call leaves no process it started alive and reads as unfinished", async (t) => {
  const script = easWithGrandchild(t);
  const env = { PATH: "/usr/bin:/bin", NQ_PIDFILE: script.pidFile, NIGHTQUEUE_EAS_BIN: script.bin };
  const controller = new AbortController();
  const pending = runEasAsync(["update"], { cwd: script.dir, env, timeoutMs: 20000, signal: controller.signal });
  await untilExists(script.pidFile, 10000);
  controller.abort();
  const result = await pending;
  assert.equal(result.unfinished, true);
  const grandchild = await grandchildAfter(t, script.pidFile);
  assert.equal(grandchild.alive, false, `grandchild pid ${grandchild.pid} survived the abort`);
});

test("execFileDetached answers stdout and stderr, an exit code and a missing binary like execFile", async () => {
  const run = (file, args) => new Promise((resolve) => execFileDetached(file, args, { env: { PATH: "/usr/bin:/bin" }, timeout: 5000 }, (err, stdout, stderr) => resolve({ err, stdout, stderr })));
  const ok = await run("/bin/sh", ["-c", "echo out; echo err >&2"]);
  assert.deepEqual(ok, { err: null, stdout: "out\n", stderr: "err\n" });
  const failed = await run("/bin/sh", ["-c", "exit 3"]);
  assert.equal(failed.err.code, 3);
  assert.equal(failed.err.killed, false);
  const missing = await run("/nonexistent/nightqueue-eas", []);
  assert.equal(missing.err.code, "ENOENT");
});

test("easAccountStatus against a binary that does not exist answers not installed", async () => {
  const status = await easAccountStatus({ env: { PATH: process.env.PATH, NIGHTQUEUE_EAS_BIN: "/nonexistent/nightqueue-eas" } });
  assert.deepEqual(status, { installed: false, authenticated: false, login: null, host: null });
});

test("parseEasProjectFullName reads @owner/slug, and the update group URL encodes each part", () => {
  assert.deepEqual(parseEasProjectFullName("fullName  @acme/my-app\nID  123"), { owner: "acme", slug: "my-app" });
  assert.equal(parseEasProjectFullName("nothing here"), null);
  assert.equal(easUpdateGroupUrl("acme", "my app", "g/1"), "https://expo.dev/accounts/acme/projects/my%20app/updates/g%2F1");
});
