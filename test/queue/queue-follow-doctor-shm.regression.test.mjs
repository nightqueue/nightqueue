import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { defaultContext, run } from "../../src/cli/index.mjs";
import { dbShmPath, runnerRegistryPath } from "../../src/config/paths.mjs";
import { openDb } from "../../src/memory/db.mjs";
import { addJob } from "../../src/memory/jobs.mjs";
import { stampRunnerDbWitness, writeRunnerRecord } from "../../src/queue/registry.mjs";
import { makeHome, makeProject } from "../../test-support/memory.mjs";

const CLI = fileURLToPath(new URL("../../bin/nightshift.mjs", import.meta.url));
const HOLDER = fileURLToPath(new URL("../../test-support/db-holder.mjs", import.meta.url));
const QUEUE_SRC = fileURLToPath(new URL("../../src/cli/queue.mjs", import.meta.url));

// Identity of the shared-memory file of the home, the thing a split moves.
function shmIdentity(env) {
  const stats = statSync(dbShmPath(env), { bigint: true });
  return `${stats.dev}:${stats.ino}`;
}

// Starts a real second process that opens the database and holds the connection until the test kills it.
function startHolder(t, env) {
  const child = spawn(process.execPath, [HOLDER], { env, encoding: "utf8" });
  t.after(() => child.kill("SIGKILL"));
  return new Promise((done, fail) => {
    child.stdout.setEncoding("utf8");
    child.stdout.once("data", (line) => done({ child, ...JSON.parse(line) }));
    child.stderr.setEncoding("utf8");
    child.stderr.once("data", (text) => fail(new Error(text)));
    child.once("exit", (code) => fail(new Error(`the holder exited before it was ready (code ${code})`)));
  });
}

// Runs `queue status --follow --until-idle` in this process with an injected sleep, exactly the entry point an operator watches.
async function runFollow(env, onTick) {
  const out = [];
  const err = [];
  const ctx = {
    ...defaultContext(),
    env,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    stdout: { isTTY: false, columns: 120, write: () => {} },
    sleep: async () => await onTick(),
    killImpl: () => {
      throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
    },
  };
  const code = await run(["queue", "status", "--follow", "--until-idle"], ctx);
  return { code, out, err };
}

// Runs `nightshift doctor --json` in this process, through the real entry point, with the host commands stubbed away so only the home's own state matters.
async function diagnose(env) {
  const out = [];
  const ctx = {
    ...defaultContext(),
    env,
    out: (line) => out.push(line),
    err: () => {},
    spawnSyncImpl: () => ({ status: 1, error: { code: "ENOENT" } }),
  };
  await run(["doctor", "--json"], ctx);
  const checks = JSON.parse(out[0]).checks;
  const found = checks.find((entry) => entry.name === "db shm");
  assert.ok(found, `no \`db shm\` check in ${checks.map((entry) => entry.name).join(", ")}`);
  return found;
}

// Replaces the witness of the registration, the state a home is left in once its shared-memory file was split and the process never restarted to re-stamp it.
function rewriteWitness(env, dbShm) {
  const path = runnerRegistryPath(process.pid, env);
  const info = JSON.parse(readFileSync(path, "utf8"));
  writeFileSync(path, `${JSON.stringify({ ...info, dbShm }, null, 2)}\n`);
}

// The body of `followStatus`, isolated so the pin below cannot drift onto an unrelated function of the same file.
function followStatusSource() {
  const text = readFileSync(QUEUE_SRC, "utf8");
  const start = text.indexOf("async function followStatus");
  assert.ok(start >= 0, "followStatus moved or was renamed; update this pin");
  const nextFunction = text.indexOf("\nfunction ", start + 1);
  const nextAsyncFunction = text.indexOf("\nasync function ", start + 1);
  const candidates = [nextFunction, nextAsyncFunction].filter((index) => index >= 0);
  const end = candidates.length ? Math.min(...candidates) : text.length;
  return text.slice(start, end);
}

test("a follow session never loses a live holder's shared-memory file, and doctor's witness check tracks that same file", async (t) => {
  const env = makeHome(t, "queue-follow-doctor-shm");
  makeProject(t, env, "alpha");
  const id = addJob({ project: "alpha", prompt: "fix the worker" }, env).id;

  openDb(env);
  writeRunnerRecord(
    { pid: process.pid, mode: "watch", jobId: null, intervalS: 5, startedAt: new Date().toISOString(), logPath: null, runtimeDir: null },
    env,
  );
  const stamped = await stampRunnerDbWitness(env);
  assert.ok(stamped?.dbShm?.ino, "the registration was not stamped with a witness before the follow session started");

  const holder = await startHolder(t, env);
  const before = shmIdentity(env);
  assert.equal(before, `${holder.dev}:${holder.ino}`, "the holder opened a shared-memory file other than the one on disk");
  assert.equal(before, `${stamped.dbShm.dev}:${stamped.dbShm.ino}`, "the runner's own witness does not match the file its own connection is attached to");

  const okBefore = await diagnose(env);
  assert.equal(okBefore.status, "ok", okBefore.detail);
  assert.match(okBefore.detail, /the live runner is attached to the file on disk/);

  let ticks = 0;
  const duringTicks = [];
  const result = await runFollow(env, () => {
    ticks += 1;
    duringTicks.push(shmIdentity(env));
    if (ticks === 2) {
      const cancelled = spawnSync(process.execPath, [CLI, "queue", "cancel", String(id)], { env, encoding: "utf8" });
      assert.equal(cancelled.status, 0, cancelled.stderr);
    }
  });

  assert.equal(result.code, 0, result.err.join("\n"));
  assert.ok(ticks >= 2, "the loop stopped before the write of the third process");
  assert.deepEqual([...new Set(duringTicks)], [before], "the shared-memory file moved while the holder was still attached to it");
  assert.equal(shmIdentity(env), before, "the shared-memory file moved by the end of the follow session");
  assert.match(result.out.join("\n"), /cancelled/, "the follow session never rendered the row the third process wrote");
  assert.equal(holder.child.exitCode, null, "the holder died during the follow session");
  // The follow answers every liveness probe with ESRCH, so it reads its own registration as stale - and still never
  // prunes it: a follow writes nothing (decision #24). The runner is registered and stamped again for the checks below.
  assert.equal(existsSync(runnerRegistryPath(process.pid, env)), true, "the follow pruned a registration: a read wrote to the file system");
  writeRunnerRecord(
    { pid: process.pid, mode: "watch", jobId: null, intervalS: 5, startedAt: new Date().toISOString(), logPath: null, runtimeDir: null },
    env,
  );
  await stampRunnerDbWitness(env);

  const okAfter = await diagnose(env);
  assert.equal(okAfter.status, "ok", okAfter.detail);
  assert.match(okAfter.detail, /the live runner is attached to the file on disk/);
  assert.match(okAfter.detail, new RegExp(`inode ${statSync(dbShmPath(env), { bigint: true }).ino}`));

  rewriteWitness(env, { ino: "999999999", dev: stamped.dbShm.dev, at: new Date().toISOString() });
  const warned = await diagnose(env);
  assert.equal(warned.status, "warn", "doctor did not flag a runner whose registered witness diverges from the file on disk");
  assert.match(warned.detail, /holds inode/);
  assert.match(warned.hint ?? "", /local disk/);
});

test("followStatus keeps no per-tick close of the cached connection (the exact line the incident's fix removed)", () => {
  const body = followStatusSource();
  assert.doesNotMatch(body, /closeDb\(/, "a per-tick closeDb reintroduces the split: another live connection can be left attached to a file this process just deleted/recreated on a filesystem that does not honor POSIX advisory locks");
});
