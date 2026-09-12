import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { dbShmPath, runnerPidPath } from "../../src/config/paths.mjs";
import { openDb } from "../../src/memory/db.mjs";
import { runnerPidfileState, runnerView, stampRunnerDbWitness, writeRunnerPidfile } from "../../src/queue/pidfile.mjs";
import { makeHome } from "../../test-support/memory.mjs";

const CLI = fileURLToPath(new URL("../../bin/nightshift.mjs", import.meta.url));
const WITNESS_TIMEOUT_MS = 15000;

// Identity of the shared-memory file of the home, in the decimal strings the witness carries.
function shmIdentity(env) {
  const stats = statSync(dbShmPath(env), { bigint: true });
  return { ino: String(stats.ino), dev: String(stats.dev) };
}

// The registration as it is on disk right now, or null while there is none.
function readPidfile(env) {
  try {
    return JSON.parse(readFileSync(runnerPidPath(env), "utf8"));
  } catch {
    return null;
  }
}

// Waits until the registration carries the witness of the runner, and says what it found when it never does.
async function waitForWitness(env, child) {
  const deadline = Date.now() + WITNESS_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const info = readPidfile(env);
    if (info?.dbShm?.ino) return info;
    if (child.exitCode !== null) throw new Error(`the runner exited (code ${child.exitCode}) before it registered a witness`);
    await delay(50);
  }
  throw new Error(`no witness in ${runnerPidPath(env)} after ${WITNESS_TIMEOUT_MS} ms: ${JSON.stringify(readPidfile(env))}`);
}

test("a runner registers the shared-memory file its own connection is attached to, and never the record of another process", async (t) => {
  const env = makeHome(t, "pidfile-db-witness");
  openDb(env);

  writeRunnerPidfile({ pid: process.pid + 1, mode: "watch", jobId: null, intervalS: 5, startedAt: new Date().toISOString(), logPath: null, runtimeDir: null }, env);
  assert.equal(await stampRunnerDbWitness(env), null, "the witness was written into the registration of another process");
  assert.equal(readPidfile(env).dbShm, undefined);

  writeRunnerPidfile({ pid: process.pid, mode: "watch", jobId: null, intervalS: 5, startedAt: new Date().toISOString(), logPath: null, runtimeDir: null }, env);
  const stamped = await stampRunnerDbWitness(env);
  const onDisk = shmIdentity(env);
  assert.equal(stamped.dbShm.ino, onDisk.ino);
  assert.equal(stamped.dbShm.dev, onDisk.dev);
  assert.equal(readPidfile(env).dbShm.ino, onDisk.ino, "the witness never reached the file");
  assert.equal(readPidfile(env).mode, "watch", "the stamp dropped a field of the registration");
  assert.equal(runnerView(runnerPidfileState(env, () => true)).dbShm, undefined, "the witness leaked into the runner view every reader prints");
});

test("a real `queue run --watch --foreground` registers the shared-memory file it opened", async (t) => {
  const env = makeHome(t, "pidfile-db-witness-e2e");
  const child = spawn(process.execPath, [CLI, "queue", "run", "--watch", "2", "--foreground"], { env, stdio: "ignore" });
  t.after(() => child.kill("SIGKILL"));

  const info = await waitForWitness(env, child);
  assert.equal(info.pid, child.pid, "the registration does not name the runner that was started");
  assert.deepEqual({ ino: info.dbShm.ino, dev: info.dbShm.dev }, shmIdentity(env), "the runner registered a shared-memory file other than the one on disk");
});
