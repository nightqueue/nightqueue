import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { isRunnerHome } from "../../src/config/job-home.mjs";
import { dbPath } from "../../src/config/paths.mjs";
import { closeDb, DB_USER_VERSION, openDb, openDbReadOnly } from "../../src/memory/db.mjs";
import { addJob } from "../../src/memory/jobs.mjs";
import { openRegistryReader } from "../../src/store/open.mjs";
import { makeDir, makeHome, makeProject, projectIdOf } from "../../test-support/memory.mjs";

const CLI = fileURLToPath(new URL("../../bin/nightqueue.mjs", import.meta.url));
const REFUSAL = /refused: the database at .* is the runner's home at schema v20, and this build \(v\d+\) would migrate it from inside J-7; nothing was changed - run this build against a temporary home \(`nightqueue sandbox <command>` or NIGHTQUEUE_HOME=\$\(mktemp -d\)\)/;

// A temporary home stamped v20 with the project `alpha` and one job.
function makeV20Home(t, name) {
  const env = makeHome(t, name);
  makeProject(t, env, "alpha");
  addJob({ projectId: projectIdOf(env, "alpha"), prompt: "fix the worker" }, env);
  openDb(env).exec("ALTER TABLE jobs DROP COLUMN origin; ALTER TABLE projects DROP COLUMN integrations; PRAGMA user_version = 20;");
  closeDb(env);
  return env;
}

// The environment of a job whose runner pinned `jobHome` as its own home.
function jobEnv(env, jobHome) {
  return { ...env, NIGHTQUEUE_JOB_ID: "7", NIGHTQUEUE_JOB_HOME: jobHome };
}

// The schema version on disk and whether jobs.origin exists, read without migrating.
function diskState(env) {
  const db = openDbReadOnly(env);
  try {
    const version = db.prepare("PRAGMA user_version").get().user_version;
    const origin = db.prepare("PRAGMA table_info(jobs)").all().some((column) => column.name === "origin");
    return { version, origin };
  } finally {
    db.close();
  }
}

// Runs the worktree CLI against the temporary home of `env`.
function runCli(env, args) {
  return spawnSync(process.execPath, [CLI, ...args], { env, encoding: "utf8" });
}

test("a job never migrates the runner's own home: openDb refuses and the schema stays v20", (t) => {
  const env = makeV20Home(t, "runner-home-open");
  assert.throws(() => openDb(jobEnv(env, env.NIGHTQUEUE_HOME)), REFUSAL);
  assert.deepEqual(diskState(env), { version: 20, origin: false });
});

test("a read command inside a job refuses before migrating, with the refusal unwrapped", async (t) => {
  const env = makeV20Home(t, "runner-home-reader");
  await assert.rejects(() => openRegistryReader(jobEnv(env, env.NIGHTQUEUE_HOME)), REFUSAL);
  assert.deepEqual(diskState(env), { version: 20, origin: false });
});

test("the worktree CLI inside a job refuses a read that would migrate the runner's home", (t) => {
  const env = makeV20Home(t, "runner-home-cli");
  const result = runCli(jobEnv(env, env.NIGHTQUEUE_HOME), ["decision", "show", "D-1", "--project", "alpha"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, REFUSAL);
  assert.deepEqual(diskState(env), { version: 20, origin: false });
});

test("inside a job a temporary home that is not the runner's still migrates", (t) => {
  const env = makeV20Home(t, "runner-home-temp");
  const runnerHome = join(makeDir(t, "runner-home-other"), "home");
  runCli(jobEnv(env, runnerHome), ["decision", "show", "D-1", "--project", "alpha"]);
  assert.deepEqual(diskState(env), { version: DB_USER_VERSION, origin: true });
});

test("outside a job the same read migrates as before", (t) => {
  const env = makeV20Home(t, "runner-home-operator");
  const operator = { ...env };
  delete operator.NIGHTQUEUE_JOB_ID;
  delete operator.NIGHTQUEUE_JOB_HOME;
  runCli(operator, ["decision", "show", "D-1", "--project", "alpha"]);
  assert.deepEqual(diskState(env), { version: DB_USER_VERSION, origin: true });
});

test("a job may still create a fresh database in the home it was pinned to", (t) => {
  const env = makeHome(t, "runner-home-fresh");
  openDb(jobEnv(env, env.NIGHTQUEUE_HOME));
  closeDb(env);
  assert.ok(existsSync(dbPath(env)));
  assert.equal(diskState(env).version, DB_USER_VERSION);
});

test("a NIGHTQUEUE_HOME symlinked to the pinned runner home is still the runner's home and is refused", (t) => {
  const env = makeV20Home(t, "runner-home-symlink");
  const link = join(makeDir(t, "runner-home-link"), "home-link");
  symlinkSync(env.NIGHTQUEUE_HOME, link);
  const linked = { ...jobEnv(env, env.NIGHTQUEUE_HOME), NIGHTQUEUE_HOME: link };
  assert.equal(isRunnerHome(linked), true);
  assert.throws(() => openDb(linked), /refused/);
  assert.deepEqual(diskState(env), { version: 20, origin: false });
});

test("a job with no pinned home and no NIGHTQUEUE_HOME reads the default home as the runner's", () => {
  assert.equal(isRunnerHome({ NIGHTQUEUE_JOB_ID: "7" }), true);
  assert.equal(isRunnerHome({ NIGHTQUEUE_JOB_ID: "7", NIGHTQUEUE_HOME: "/tmp/elsewhere" }), false);
});
