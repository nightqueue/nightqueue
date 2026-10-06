import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { isRunnerHome } from "../../src/config/job-home.mjs";
import { dbPath, preVersionBackupPath } from "../../src/config/paths.mjs";
import { closeDb, DB_USER_VERSION, migrateHomeDatabase, openDb, openDbReadOnly } from "../../src/memory/db.mjs";
import { addJob } from "../../src/memory/jobs.mjs";
import { openRegistryReader } from "../../src/store/open.mjs";
import { restorePreV22Names } from "../../test-support/legacy-home.mjs";
import { makeDir, makeHome, makeProject, projectIdOf } from "../../test-support/memory.mjs";

const CLI = fileURLToPath(new URL("../../bin/nightqueue.mjs", import.meta.url));
const REFUSAL = /refused: the database at .* is the runner's home at schema v20, and this build \(v\d+\) would migrate it from inside J-7; nothing was changed - run this build against a temporary home \(`nightqueue sandbox <command>` or NIGHTQUEUE_HOME=\$\(mktemp -d\)\)/;
const OUTDATED = /database at v20, this nightqueue expects v23: run `nightqueue update`/;

// A temporary home stamped v20 with the project `alpha`, one job and the tracker under its pre-v22 names.
function makeV20Home(t, name) {
  const env = makeHome(t, name);
  makeProject(t, env, "alpha");
  addJob({ projectId: projectIdOf(env, "alpha"), prompt: "fix the worker" }, env);
  const db = openDb(env);
  db.exec("ALTER TABLE jobs DROP COLUMN origin; ALTER TABLE projects DROP COLUMN integrations");
  restorePreV22Names(db);
  db.exec("PRAGMA user_version = 20");
  closeDb(env);
  return env;
}

// The environment of a job whose runner pinned `jobHome` as its own home.
function jobEnv(env, jobHome) {
  return { ...env, NIGHTQUEUE_JOB_ID: "7", NIGHTQUEUE_JOB_HOME: jobHome };
}

// The schema version on disk and whether jobs.origin exists, read without migrating.
function diskState(env) {
  const db = openDbReadOnly(env, { anySchema: true });
  try {
    const version = db.prepare("PRAGMA user_version").get().user_version;
    const origin = db.prepare("PRAGMA table_info(jobs)").all().some((column) => column.name === "origin");
    return { version, origin };
  } finally {
    db.close();
  }
}

// The bytes of the database file and whether each sidecar exists, the proof a refusal wrote nothing.
function diskBytes(env) {
  const path = dbPath(env);
  return { main: readFileSync(path), wal: existsSync(`${path}-wal`), shm: existsSync(`${path}-shm`) };
}

// Asserts the database and its sidecars are exactly as they were.
function assertUntouched(env, before) {
  const after = diskBytes(env);
  assert.ok(after.main.equals(before.main), "a refused open wrote to the database");
  assert.deepEqual({ wal: after.wal, shm: after.shm }, { wal: before.wal, shm: before.shm }, "a refused open created or removed a sidecar");
}

// Runs the worktree CLI against the temporary home of `env`.
function runCli(env, args) {
  return spawnSync(process.execPath, [CLI, ...args], { env, encoding: "utf8" });
}

test("a job never migrates the runner's own home: openDb refuses with the update message and the file is byte-identical", (t) => {
  const env = makeV20Home(t, "runner-home-open");
  const before = diskBytes(env);
  assert.throws(() => openDb(jobEnv(env, env.NIGHTQUEUE_HOME)), OUTDATED);
  assertUntouched(env, before);
});

test("the migration itself, run from inside a job against the runner's own home, is still refused by the in-job guard", (t) => {
  const env = makeV20Home(t, "runner-home-migrate");
  assert.throws(() => migrateHomeDatabase(jobEnv(env, env.NIGHTQUEUE_HOME), { backupPath: preVersionBackupPath(env, DB_USER_VERSION) }), REFUSAL);
  assert.deepEqual(diskState(env), { version: 20, origin: false });
});

test("a read command inside a job refuses with the update message and writes nothing", async (t) => {
  const env = makeV20Home(t, "runner-home-reader");
  const before = diskBytes(env);
  await assert.rejects(() => openRegistryReader(jobEnv(env, env.NIGHTQUEUE_HOME)), OUTDATED);
  assertUntouched(env, before);
});

test("the worktree CLI inside a job refuses a read of an older home and writes nothing", (t) => {
  const env = makeV20Home(t, "runner-home-cli");
  const before = diskBytes(env);
  const result = runCli(jobEnv(env, env.NIGHTQUEUE_HOME), ["decision", "show", "D-1", "--project", "alpha"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, OUTDATED);
  assertUntouched(env, before);
});

test("inside a job a read of a temporary home that is not the runner's never migrates it either", (t) => {
  const env = makeV20Home(t, "runner-home-temp");
  const before = diskBytes(env);
  const runnerHome = join(makeDir(t, "runner-home-other"), "home");
  const result = runCli(jobEnv(env, runnerHome), ["decision", "show", "D-1", "--project", "alpha"]);
  assert.match(result.stderr, OUTDATED);
  assertUntouched(env, before);
});

test("inside a job the migration of a temporary home that is not the runner's still runs", (t) => {
  const env = makeV20Home(t, "runner-home-temp-migrate");
  const runnerHome = join(makeDir(t, "runner-home-other-migrate"), "home");
  const result = migrateHomeDatabase(jobEnv(env, runnerHome), { backupPath: preVersionBackupPath(env, DB_USER_VERSION) });
  closeDb(env);
  assert.equal(result.migrated, true);
  assert.deepEqual(diskState(env), { version: DB_USER_VERSION, origin: true });
});

test("outside a job, with no NIGHTQUEUE_JOB_ID (the incident), the same read refuses and writes nothing", (t) => {
  const env = makeV20Home(t, "runner-home-operator");
  const operator = { ...env };
  delete operator.NIGHTQUEUE_JOB_ID;
  delete operator.NIGHTQUEUE_JOB_HOME;
  const before = diskBytes(env);
  const result = runCli(operator, ["decision", "show", "D-1", "--project", "alpha"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, OUTDATED);
  assertUntouched(env, before);
});

test("a job may still create a fresh database in the home it was pinned to", (t) => {
  const env = makeHome(t, "runner-home-fresh");
  openDb(jobEnv(env, env.NIGHTQUEUE_HOME));
  closeDb(env);
  assert.ok(existsSync(dbPath(env)));
  assert.equal(diskState(env).version, DB_USER_VERSION);
});

test("a NIGHTQUEUE_HOME symlinked to the pinned runner home is still the runner's home, and its migration is refused", (t) => {
  const env = makeV20Home(t, "runner-home-symlink");
  const link = join(makeDir(t, "runner-home-link"), "home-link");
  symlinkSync(env.NIGHTQUEUE_HOME, link);
  const linked = { ...jobEnv(env, env.NIGHTQUEUE_HOME), NIGHTQUEUE_HOME: link };
  assert.equal(isRunnerHome(linked), true);
  assert.throws(() => openDb(linked), OUTDATED);
  assert.throws(() => migrateHomeDatabase(linked, { backupPath: preVersionBackupPath(linked, DB_USER_VERSION) }), /refused/);
  assert.deepEqual(diskState(env), { version: 20, origin: false });
});

test("a job with no pinned home and no NIGHTQUEUE_HOME reads the default home as the runner's", () => {
  assert.equal(isRunnerHome({ NIGHTQUEUE_JOB_ID: "7" }), true);
  assert.equal(isRunnerHome({ NIGHTQUEUE_JOB_ID: "7", NIGHTQUEUE_HOME: "/tmp/elsewhere" }), false);
});
