import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { defaultContext, run } from "../src/cli/index.mjs";
import { dbShmPath, homeDir, runnerRegistryPath } from "../src/config/paths.mjs";
import { ensureHome } from "../src/config/store.mjs";
import { openDb } from "../src/memory/db.mjs";
import { stampRunnerDbWitness, writeRunnerRecord } from "../src/queue/registry.mjs";
import { makeHostEnv } from "../test-support/host.mjs";

// Runs the diagnosis in process, with a host that answers nothing so only the checks of the home matter.
async function diagnose(env, { alive = false, args = [] } = {}) {
  const out = [];
  const ctx = {
    ...defaultContext(),
    env,
    out: (line) => out.push(line),
    err: () => {},
    spawnSyncImpl: () => ({ status: 1, error: { code: "ENOENT" } }),
    killImpl: () => {
      if (alive) return true;
      throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
    },
  };
  await run(["doctor", "--json", ...args], ctx);
  return JSON.parse(out[0]).checks;
}

// The `db shm` line of a report.
function dbShmLine(checks) {
  const found = checks.find((entry) => entry.name === "db shm");
  assert.ok(found, `no \`db shm\` check in ${checks.map((entry) => entry.name).join(", ")}`);
  return found;
}

// Registers a runner that is this process, so the diagnosis has a live record to compare with.
function registerRunner(env) {
  writeRunnerRecord({ pid: process.pid, mode: "watch", jobId: null, intervalS: 5, startedAt: new Date().toISOString(), logPath: null, runtimeDir: null }, env);
}

// Replaces the witness of the registration, the state a home is left in once its shared-memory file was split.
function rewriteWitness(env, dbShm) {
  const path = runnerRegistryPath(process.pid, env);
  const info = JSON.parse(readFileSync(path, "utf8"));
  writeFileSync(path, `${JSON.stringify({ ...info, dbShm }, null, 2)}\n`);
}

test("the db shm check reports the database, the runner without a witness and the runner attached to the file on disk", async (t) => {
  const host = makeHostEnv(t, "doctor-db-shm-ok");
  ensureHome(host.env);

  const empty = dbShmLine(await diagnose(host.env));
  assert.equal(empty.status, "ok");
  assert.match(empty.detail, /no database yet/);

  openDb(host.env);
  const noRunner = dbShmLine(await diagnose(host.env));
  assert.equal(noRunner.status, "ok");
  assert.match(noRunner.detail, /no live runner to compare with/);

  registerRunner(host.env);
  const noWitness = dbShmLine(await diagnose(host.env, { alive: true }));
  assert.equal(noWitness.status, "ok", "a runner without a witness must be an unknown, never a warning");
  assert.match(noWitness.detail, /^unknown: the live runner \(pid \d+\) registered no shared-memory witness$/);

  await stampRunnerDbWitness(host.env);
  const attached = dbShmLine(await diagnose(host.env, { alive: true }));
  assert.equal(attached.status, "ok");
  assert.match(attached.detail, new RegExp(`inode ${statSync(dbShmPath(host.env), { bigint: true }).ino}`));
});

test("the db shm check warns when the file a live runner holds was replaced or is gone", async (t) => {
  const host = makeHostEnv(t, "doctor-db-shm-split");
  ensureHome(host.env);
  openDb(host.env);
  registerRunner(host.env);
  await stampRunnerDbWitness(host.env);
  const onDisk = statSync(dbShmPath(host.env), { bigint: true });

  rewriteWitness(host.env, { ino: "424242", dev: String(onDisk.dev), at: new Date().toISOString() });
  const split = dbShmLine(await diagnose(host.env, { alive: true }));
  assert.equal(split.status, "warn");
  assert.match(split.detail, new RegExp(`holds inode ${onDisk.dev}:424242, disk has ${onDisk.dev}:${onDisk.ino}`));
  assert.match(split.hint, /must be on local disk|local disk/);

  rewriteWitness(host.env, { ino: String(onDisk.ino), dev: String(onDisk.dev), at: new Date().toISOString() });
  rmSync(dbShmPath(host.env));
  const gone = dbShmLine(await diagnose(host.env, { alive: true }));
  assert.equal(gone.status, "warn");
  assert.match(gone.detail, /the shared-memory file the runner \(pid \d+\) is attached to is gone/);

  writeFileSync(join(homeDir(host.env), ".fuse_hidden0000000c00000001"), "orphan");
  const orphans = dbShmLine(await diagnose(host.env, { alive: true }));
  assert.equal(orphans.status, "warn");
  assert.match(orphans.detail, /1 hidden orphan file\(s\) beside the database \(\.fuse_hidden0000000c00000001\)/);
});

test("the db shm check states an unknown instead of crashing the report when the home cannot be listed", async (t) => {
  if (process.getuid?.() === 0) return;
  const host = makeHostEnv(t, "doctor-db-shm-unreadable");
  ensureHome(host.env);
  openDb(host.env);
  const home = homeDir(host.env);
  chmodSync(home, 0o100);
  let checks = [];
  try {
    checks = await diagnose(host.env);
  } finally {
    chmodSync(home, 0o700);
  }

  const line = dbShmLine(checks);
  assert.equal(line.status, "warn");
  assert.match(line.detail, /^unknown: .* cannot be listed/);
  assert.ok(checks.length > 5, "the unreadable home cut the rest of the report short");
});

// Leaves one hidden orphan beside a database and returns its path.
function leaveOrphan(env) {
  const path = join(homeDir(env), ".nfs0000000000000001");
  writeFileSync(path, "orphan");
  return path;
}

test("doctor without --fix keeps the shm orphans, and --fix removes them only when no runner is alive", async (t) => {
  const host = makeHostEnv(t, "doctor-db-shm-fix");
  ensureHome(host.env);
  openDb(host.env);
  const orphan = leaveOrphan(host.env);

  const plain = dbShmLine(await diagnose(host.env));
  assert.equal(plain.status, "warn");
  assert.match(plain.hint, /doctor --fix/);
  assert.equal(existsSync(orphan), true, "a plain doctor removed a file");

  registerRunner(host.env);
  const held = dbShmLine(await diagnose(host.env, { alive: true, args: ["--fix"] }));
  assert.equal(held.status, "warn");
  assert.match(held.detail, /not removed: a live runner is registered \(pid \d+\)/);
  assert.equal(existsSync(orphan), true, "--fix removed an orphan while a runner is alive");

  const fixed = dbShmLine(await diagnose(host.env, { args: ["--fix"] }));
  assert.equal(fixed.status, "ok");
  assert.match(fixed.detail, /removed 1 hidden orphan file/);
  assert.equal(existsSync(orphan), false);
});

test("doctor names an old _broken quarantine with its size and the legacy ~/.nightshift, and deletes neither", async (t) => {
  const host = makeHostEnv(t, "doctor-legacy-leftovers");
  ensureHome(host.env);
  const old = join(homeDir(host.env), "_broken-20200101T000000Z");
  const fresh = join(homeDir(host.env), "_broken-fresh");
  mkdirSync(old);
  mkdirSync(fresh);
  writeFileSync(join(old, "data"), "x".repeat(2048));
  const longAgo = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
  utimesSync(old, longAgo, longAgo);
  const legacyHome = join(host.env.HOME, ".nightshift");
  mkdirSync(legacyHome, { recursive: true });

  const checks = await diagnose(host.env);
  const quarantine = checks.find((entry) => entry.name === "quarantine _broken-20200101T000000Z");
  assert.equal(quarantine.status, "warn");
  assert.match(quarantine.detail, /^2\.0 KB at .*_broken-20200101T000000Z, older than 30 days$/);
  assert.equal(checks.some((entry) => entry.name === "quarantine _broken-fresh"), false);
  const legacy = checks.find((entry) => entry.name === "legacy home");
  assert.equal(legacy.status, "warn");
  assert.match(legacy.hint, /rm -rf /);
  assert.equal(existsSync(old) && existsSync(legacyHome), true);
});
