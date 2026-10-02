import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { defaultContext, run, skipsLock } from "../src/cli/index.mjs";
import { migrateSchemaStep } from "../src/cli/install-steps.mjs";
import { makeReport } from "../src/cli/report.mjs";
import { migrateHomeSchema, SCHEMA_PARENT_ENV } from "../src/cli/schema-migrate.mjs";
import { lockPath } from "../src/config/lock.mjs";
import { dbPath, preVersionBackupPath } from "../src/config/paths.mjs";
import { spawnRoot } from "../src/host/paths.mjs";
import { closeDb, DB_USER_VERSION, openDb } from "../src/memory/db.mjs";
import { acquireClose, acquirePostClose, addJob } from "../src/memory/jobs.mjs";
import { writeRunnerRecord } from "../src/queue/registry.mjs";
import { assertIsolatedEnv, makeHostEnv } from "../test-support/host.mjs";
import { restorePreV22Names } from "../test-support/legacy-home.mjs";
import { ensureProject, makeProject, seedClosedJob, seedDoneJob } from "../test-support/memory.mjs";

const RUNNER_PID = 4242;

// Context that captures the output and answers `kill` only for the pids the test says are alive.
function makeCtx(env, alive = new Set()) {
  const out = [];
  const err = [];
  const ctx = {
    ...defaultContext(),
    env: assertIsolatedEnv(env),
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    stdin: { isTTY: false },
    stdout: new PassThrough(),
    killImpl: (pid) => {
      if (!alive.has(pid)) throw Object.assign(new Error(`kill ESRCH ${pid}`), { code: "ESRCH" });
      return true;
    },
  };
  return { ctx, out, err };
}

// A host whose database is stamped v20 after `seed` wrote its rows - neither v21 column, the tracker under its pre-v22 names - folded and closed so the file alone is the database.
function v20Host(t, name, seed = () => {}) {
  const host = makeHostEnv(t, name);
  makeProject(t, host.env, "alpha");
  seed(host.env, ensureProject(host.env, "alpha"));
  const db = openDb(host.env);
  db.exec("ALTER TABLE jobs DROP COLUMN origin; ALTER TABLE projects DROP COLUMN integrations");
  restorePreV22Names(db);
  db.exec("PRAGMA user_version = 20");
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  closeDb(host.env);
  for (const sidecar of ["-wal", "-shm"]) rmSync(`${dbPath(host.env)}${sidecar}`, { force: true });
  return host.env;
}

// A job `running` under a lease that ends `offset` from now ('+1 hour' is live, '-1 hour' expired).
function runningJob(offset) {
  return (env, projectId) => {
    const id = addJob({ projectId, prompt: `running ${offset}` }, env).id;
    openDb(env).prepare("UPDATE jobs SET status = 'running', worker = 'w', started_at = datetime('now'), lease_until = datetime('now', ?) WHERE id = ?").run(offset, id);
  };
}

// The pre-v<N> backups in the home, by name.
function backups(env) {
  return readdirSync(dirname(dbPath(env))).filter((name) => name.startsWith("nightqueue.db.pre-v"));
}

// The user_version stamped in a database file's header.
function headerVersion(path) {
  return readFileSync(path).readUInt32BE(60);
}

// Asserts a refused migration wrote nothing: same bytes, no backup.
function assertNothingWritten(env, before) {
  assert.ok(readFileSync(dbPath(env)).equals(before), "a refused migration wrote to the database");
  assert.deepEqual(backups(env), [], "a refused migration took a backup");
}

test("on a v20 home with nothing running, migrateHomeSchema backs the v20 file up first, then migrates it to the current schema", async (t) => {
  const env = v20Host(t, "schema-migrate-idle");
  const { ctx, out } = makeCtx(env);

  const result = await migrateHomeSchema(ctx);

  const backupPath = preVersionBackupPath(env, DB_USER_VERSION);
  assert.deepEqual(result, { status: "migrated", from: 20, to: DB_USER_VERSION, backup: backupPath });
  assert.equal(headerVersion(backupPath), 20, "the backup is not the v20 database");
  assert.equal(openDb(env).prepare("PRAGMA user_version").get().user_version, DB_USER_VERSION);
  assert.deepEqual(out, [`database schema: v20 -> v${DB_USER_VERSION} (backup at ${backupPath})`]);
});

test("a registered live runner refuses the migration, named by pid, and nothing is written", async (t) => {
  const env = v20Host(t, "schema-migrate-runner");
  writeRunnerRecord({ pid: RUNNER_PID, startedAt: new Date().toISOString(), mode: "watch", intervalS: 30, logPath: "/tmp/a.log" }, env);
  const before = readFileSync(dbPath(env));
  const { ctx } = makeCtx(env, new Set([RUNNER_PID]));

  await assert.rejects(migrateHomeSchema(ctx), (err) => {
    assert.match(err.message, new RegExp(`^the database must migrate from v20 to v${DB_USER_VERSION}, but pid 4242 still use it - stop them`));
    assert.match(err.message, /nothing was written$/);
    return true;
  });
  assertNothingWritten(env, before);
});

test("a job running under a live lease refuses the migration, named by job", async (t) => {
  const env = v20Host(t, "schema-migrate-live-job", runningJob("+1 hour"));
  const before = readFileSync(dbPath(env));
  await assert.rejects(migrateHomeSchema(makeCtx(env).ctx), /but J-1 \(live lease\) still use it/);
  assertNothingWritten(env, before);
});

test("a close in flight and the post-close hold of a closed job both refuse the migration, named as closes", async (t) => {
  const seed = (env, projectId) => {
    const closing = seedDoneJob(env, { project: "alpha" });
    assert.ok(acquireClose(closing, { worker: "test:close", leaseS: 600 }, env));
    const closed = seedClosedJob(env, { project: "alpha" });
    assert.ok(acquirePostClose(closed, { worker: "test:post-close", leaseS: 600 }, env));
    assert.ok(projectId);
  };
  const env = v20Host(t, "schema-migrate-close", seed);
  const before = readFileSync(dbPath(env));
  await assert.rejects(migrateHomeSchema(makeCtx(env).ctx), /close J-1 \(live close lease\), close J-2 \(live close lease\) still use it/);
  assertNothingWritten(env, before);
});

test("a `running` row whose lease expired never blocks the migration: it is named in a warning and left to the next runner", async (t) => {
  const env = v20Host(t, "schema-migrate-stale", runningJob("-1 hour"));
  const { ctx, err } = makeCtx(env);
  assert.equal((await migrateHomeSchema(ctx)).status, "migrated");
  assert.deepEqual(err, ["warning: J-1 is `running` with an expired lease; the next runner recovers it"]);
});

test("an earlier backup is never overwritten: the migration writes a stamped copy beside it", async (t) => {
  const env = v20Host(t, "schema-migrate-backup-kept");
  const base = preVersionBackupPath(env, DB_USER_VERSION);
  writeFileSync(base, "an earlier backup");

  const result = await migrateHomeSchema(makeCtx(env).ctx);

  assert.equal(readFileSync(base, "utf8"), "an earlier backup");
  assert.ok(result.backup.startsWith(`${base}.`), result.backup);
  assert.equal(headerVersion(result.backup), 20);
});

test("a current, a missing and an unreadable database are left as they are", async (t) => {
  const missing = makeHostEnv(t, "schema-migrate-missing").env;
  const { ctx: none, out: noneOut } = makeCtx(missing);
  assert.deepEqual(await migrateHomeSchema(none), { status: "none" });
  assert.deepEqual(noneOut, ["database schema: no database yet"]);
  assert.equal(existsSync(dbPath(missing)), false, "the check created a database");

  const current = makeHostEnv(t, "schema-migrate-current");
  makeProject(t, current.env, "alpha");
  closeDb(current.env);
  assert.deepEqual(await migrateHomeSchema(makeCtx(current.env).ctx), { status: "current" });
  assert.deepEqual(backups(current.env), []);

  const garbage = makeHostEnv(t, "schema-migrate-garbage");
  mkdirSync(dirname(dbPath(garbage.env)), { recursive: true });
  writeFileSync(dbPath(garbage.env), "database bytes");
  assert.deepEqual(await migrateHomeSchema(makeCtx(garbage.env).ctx), { status: "unreadable" });
  assert.equal(readFileSync(dbPath(garbage.env), "utf8"), "database bytes");
});

test("`nightqueue update --schema-only` with a registered runner exits 1 and writes nothing, and `--force` is refused with it", async (t) => {
  const env = v20Host(t, "schema-migrate-cli");
  writeRunnerRecord({ pid: RUNNER_PID, startedAt: new Date().toISOString(), mode: "watch", intervalS: 30, logPath: "/tmp/a.log" }, env);
  const before = readFileSync(dbPath(env));
  const { ctx, err } = makeCtx(env, new Set([RUNNER_PID]));

  assert.equal(await run(["update", "--schema-only"], ctx), 1);
  assert.match(err.join("\n"), /but pid 4242 still use it/);
  assert.equal(await run(["update", "--schema-only", "--force"], ctx), 1);
  assert.match(err.at(-1), /takes no version, `--from` nor `--force`/);
  assertNothingWritten(env, before);
});

test("the schema child borrows the home lock only with its parent's token and a lock the parent holds", (t) => {
  const { env } = makeHostEnv(t, "schema-migrate-lock");
  const token = { ...env, [SCHEMA_PARENT_ENV]: String(process.ppid) };
  assert.equal(skipsLock("update", ["--schema-only"], token), false, "no lock held: a direct invocation takes it");
  mkdirSync(lockPath(env), { recursive: true });
  t.after(() => rmSync(lockPath(env), { recursive: true, force: true }));
  assert.equal(skipsLock("update", ["--schema-only"], token), false, "a lock that names no owner was borrowed");
  writeFileSync(join(lockPath(env), "owner"), String(process.pid + 1));
  assert.equal(skipsLock("update", ["--schema-only"], token), false, "a lock another process owns was borrowed");
  writeFileSync(join(lockPath(env), "owner"), String(process.ppid));
  assert.equal(skipsLock("update", ["--schema-only"], token), true);
  assert.equal(skipsLock("update", ["--schema-only"], { ...env, [SCHEMA_PARENT_ENV]: "1" }), false, "another parent's token borrowed the lock");
  assert.equal(skipsLock("update", ["--schema-only"], env), false, "no token borrowed the lock");
  assert.equal(skipsLock("update", [], token), false, "a plain update skipped the lock");
});

test("migrateSchemaStep runs `update --schema-only` from the installed runtime with the parent token, and a refusal degrades the step", (t) => {
  const { env } = makeHostEnv(t, "schema-migrate-step");
  const calls = [];
  const answers = [
    { status: 0, stdout: "database schema: v20 -> v21 (backup at /x)\n", stderr: "warning: J-3 is `running` with an expired lease; the next runner recovers it\n" },
    { status: 1, stdout: "", stderr: "nightqueue: the database must migrate from v20 to v21, but pid 9 still use it\n" },
  ];
  const out = [];
  const err = [];
  const ctx = { env, out: (line) => out.push(line), err: (line) => err.push(line), spawnSyncImpl: (file, args, options) => {
    calls.push({ file, args, options });
    return answers[calls.length - 1];
  } };

  assert.equal(migrateSchemaStep(ctx, makeReport(ctx), { ready: true }), true);
  assert.equal(calls[0].file, process.execPath);
  assert.deepEqual(calls[0].args, [join(spawnRoot(env), "bin", "nightqueue.mjs"), "update", "--schema-only"]);
  assert.equal(calls[0].options.env[SCHEMA_PARENT_ENV], String(process.pid));
  assert.ok(out.includes("database schema: ok (v20 -> v21 (backup at /x))"), out.join("\n"));
  assert.ok(out.some((line) => line.startsWith("the database schema changed: restart every MCP client")), out.join("\n"));
  assert.ok(err.includes("warning: J-3 is `running` with an expired lease; the next runner recovers it"), err.join("\n"));

  const report = makeReport(ctx);
  assert.equal(migrateSchemaStep(ctx, report, { ready: true }), false);
  assert.equal(report.count(), 1);
  assert.ok(out.includes("database schema: failed (the database must migrate from v20 to v21, but pid 9 still use it)"), out.join("\n"));

  assert.equal(migrateSchemaStep(ctx, makeReport(ctx), { ready: false }), true);
  assert.equal(calls.length, 2, "a runtime that is not ready still spawned the schema child");
  assert.ok(out.includes("database schema: skipped (the runtime is not ready)"), out.join("\n"));
  assert.equal(out.filter((line) => line.startsWith("the database schema changed")).length, 1, "a step that migrated nothing asked for a restart");
});
