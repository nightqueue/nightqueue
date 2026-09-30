import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, truncateSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { defaultContext, run } from "../src/cli/index.mjs";
import { dbPath, dbShmPath, dbWalPath, homeDir, preV20BackupPath } from "../src/config/paths.mjs";
import { closeDb, openDb } from "../src/memory/db.mjs";
import { addJob } from "../src/memory/jobs.mjs";
import { moveProject } from "../src/memory/registry.mjs";
import { writeRunnerRecord } from "../src/queue/registry.mjs";
import { openStore } from "../src/store/open.mjs";
import { makeHostEnv } from "../test-support/host.mjs";
import { ensureProject, makeDir, makeHome, registerCheckout } from "../test-support/memory.mjs";
import { capturedUnavailableError, makeSickHome } from "../test-support/sick-home.mjs";
import { git, publishedCheckout } from "../test-support/worktrees.mjs";

const { DatabaseSync } = await import("node:sqlite");

const SETUP =["setup", "--no-path", "--no-embedding"];
const FIX_HINT = "nightqueue doctor --fix";
const QUARANTINE_NAME = /^_broken-\d{8}T\d{6}Z$/;

// Subprocess runner that answers for `gh` and lets every other command run, so git and the fake claude really answer.
function fakeGh(file, args, options) {
  if (file === "gh") return { status: 0, stdout: "Logged in", stderr: "" };
  return spawnSync(file, args, options);
}

// Runs the diagnosis in process and returns the exit code with the parsed rows.
async function diagnose(env, { args = [], alive = false, dbProbeImpl, lsofImpl } = {}) {
  const out = [];
  const ctx = {
    ...defaultContext(),
    env,
    out: (line) => out.push(line),
    err: () => {},
    spawnSyncImpl: fakeGh,
    killImpl: () => {
      if (alive) return true;
      throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
    },
    ...(dbProbeImpl ? { dbProbeImpl } : {}),
    ...(lsofImpl ? { lsofImpl } : {}),
  };
  const code = await run(["doctor", "--json", ...args], ctx);
  assert.equal(out.length, 1, out.join("\n"));
  return { code, checks: JSON.parse(out[0]).checks };
}

// One row of a report by name, or undefined when the report has none.
function rowOf(checks, name) {
  return checks.find((entry) => entry.name === name);
}

// One row of a report by name, failing the test when it is missing.
function requireRow(checks, name) {
  const found = rowOf(checks, name);
  assert.ok(found, `no \`${name}\` row in ${checks.map((entry) => entry.name).join(", ")}`);
  return found;
}

// A host that went through setup, so every row outside the database is healthy.
async function setupHost(t, name) {
  const host = makeHostEnv(t, name);
  await run(SETUP, { ...defaultContext(), env: host.env, out: () => {}, err: () => {} });
  return host;
}

// Writes a few jobs through the writable connection and closes it, which leaves the WAL non-empty behind the pin.
function seedJobs(env, count) {
  const projectId = ensureProject(env, "alpha");
  for (let i = 0; i < count; i += 1) addJob({ projectId, prompt: `job ${i} ${"x".repeat(500)}` }, env);
  closeDb(env);
}

// Number of jobs the store reads back once the diagnosis is over.
async function jobCount(env) {
  const rows = await openStore(env).jobs.listJobs();
  closeDb(env);
  return rows.length;
}

// Size of a file, or null when it is not there.
function sizeOf(path) {
  return statSync(path, { throwIfNoEntry: false })?.size ?? null;
}

// The `_broken-*` quarantines of a home.
function quarantines(env) {
  return readdirSync(homeDir(env)).filter((name) => QUARANTINE_NAME.test(name));
}

// Every database file, backup and quarantine of a home with its bytes, to prove nothing moved.
function databaseFiles(env) {
  const home = homeDir(env);
  const listing = {};
  for (const name of readdirSync(home).sort()) {
    const path = join(home, name);
    if (name.startsWith("_broken-")) {
      for (const inner of readdirSync(path).sort()) listing[`${name}/${inner}`] = readFileSync(join(path, inner), "utf8");
    } else if (name.startsWith("nightqueue.db")) {
      listing[name] = readFileSync(path).toString("base64");
    }
  }
  return listing;
}

test("(iii) a main file replaced by text only warns in a plain doctor, which still exits 0", async (t) => {
  const host = await setupHost(t, "doctor-db-sick-plain");
  seedJobs(host.env, 1);
  makeSickHome(host.env);

  const { code, checks } = await diagnose(host.env);

  const database = requireRow(checks, "database");
  assert.equal(database.status, "warn");
  assert.match(database.detail, /^SQLITE_NOTADB: file is not a database$/);
  assert.equal(database.hint, FIX_HINT);
  assert.deepEqual(checks.filter((entry) => entry.status === "fail"), []);
  assert.equal(code, 0);
  assert.equal(rowOf(checks, "db repair"), undefined, "a plain doctor acted on the database");
});

test("(iii) doctor --fix refuses a main file that fails on its own, names every backup and moves nothing", async (t) => {
  const host = await setupHost(t, "doctor-db-sick-fix");
  seedJobs(host.env, 1);
  makeSickHome(host.env);
  writeFileSync(preV20BackupPath(host.env), "pre-v20 copy");
  const broken = join(homeDir(host.env), "_broken-20260101T000000Z");
  mkdirSync(broken);
  writeFileSync(join(broken, "nightqueue.db"), "quarantined main");
  writeFileSync(join(broken, "nightqueue.db-wal"), "quarantined wal");
  const older = new Date(Date.now() - 60_000);
  utimesSync(preV20BackupPath(host.env), older, older);
  const before = databaseFiles(host.env);

  const { code, checks } = await diagnose(host.env, { args: ["--fix"] });

  assert.equal(code, 1);
  const repair = requireRow(checks, "db repair");
  assert.equal(repair.status, "fail");
  assert.match(repair.detail, /^SQLITE_NOTADB: the main file fails on its own, so nothing was moved; backups: /);
  for (const path of [preV20BackupPath(host.env), join(broken, "nightqueue.db"), join(broken, "nightqueue.db-wal")]) {
    assert.ok(repair.detail.includes(`${path} (`), `the refusal does not name ${path}: ${repair.detail}`);
  }
  assert.match(repair.detail, /\(12 B, \d{4}-\d{2}-\d{2}T/);
  assert.equal(repair.hint, `stop every nightqueue process (runners and MCP clients), then: cp '${join(broken, "nightqueue.db")}' '${dbPath(host.env)}'`);
  assert.deepEqual(checks.filter((entry) => entry.status === "fail").map((entry) => entry.name), ["db repair"]);
  assert.equal(requireRow(checks, "database").status, "warn");
  assert.deepEqual(databaseFiles(host.env), before, "a refused repair moved or changed a file");
});

test("(iii) doctor --fix with no backup at all says so in the refusal", async (t) => {
  const host = makeHostEnv(t, "doctor-db-sick-no-backup");
  seedJobs(host.env, 1);
  makeSickHome(host.env);

  const repair = requireRow((await diagnose(host.env, { args: ["--fix"] })).checks, "db repair");

  assert.equal(repair.status, "fail");
  assert.equal(repair.detail, `SQLITE_NOTADB: the main file fails on its own, so nothing was moved; no backup found in ${homeDir(host.env)}`);
  assert.match(repair.hint, /then: cp <newest backup> /);
});

test("(i) a random -shm is survived: SQLite rebuilds the index, --db reports it and --fix folds the WAL", async (t) => {
  const host = makeHostEnv(t, "doctor-db-random-shm");
  seedJobs(host.env, 3);
  writeFileSync(dbShmPath(host.env), randomBytes(32768));

  const plain = await diagnose(host.env);
  assert.equal(requireRow(plain.checks, "database").status, "ok");
  assert.equal(rowOf(plain.checks, "db files"), undefined, "a plain doctor printed a --db row");
  assert.equal(rowOf(plain.checks, "db checkpoint"), undefined, "a plain doctor folded the WAL");

  const inspected = await diagnose(host.env, { args: ["--db"] });
  const files = requireRow(inspected.checks, "db files");
  assert.equal(files.status, "ok");
  assert.match(files.detail, /^main \d+(\.\d)? (B|KB), wal \d+(\.\d)? (B|KB), shm 32\.0 KB \(inode \d+:\d+\)$/);
  assert.deepEqual(requireRow(inspected.checks, "db integrity"), { name: "db integrity", status: "ok", detail: "quick_check ok", hint: null });
  assert.equal(rowOf(inspected.checks, "db checkpoint"), undefined, "--db changed what --fix does");
  assert.ok(sizeOf(dbWalPath(host.env)) > 0, "the WAL was folded before --fix");

  const fixed = await diagnose(host.env, { args: ["--fix", "--db"] });
  const checkpoint = requireRow(fixed.checks, "db checkpoint");
  assert.equal(checkpoint.status, "ok");
  assert.match(checkpoint.detail, /^folded [1-9]\d* frames \(busy=0\)$/);
  assert.equal(sizeOf(dbWalPath(host.env)), 0);
  assert.equal(requireRow(fixed.checks, "db integrity").detail, "quick_check ok");
  assert.equal(rowOf(fixed.checks, "db repair"), undefined, "a healthy database got a repair row");
  assert.equal(await jobCount(host.env), 3);

  const again = await diagnose(host.env, { args: ["--fix"] });
  assert.equal(rowOf(again.checks, "db checkpoint"), undefined, "an empty WAL still got a checkpoint row");
});

test("(ii) a -wal truncated mid-frame is survived: --fix folds the valid frames and the dropped rows stay dropped", async (t) => {
  const source = makeHome(t, "doctor-db-wal-source");
  const projectId = ensureProject(source, "alpha");
  const held = openDb(source);
  held.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  held.exec("PRAGMA wal_autocheckpoint = 0");
  for (let i = 0; i < 20; i += 1) addJob({ projectId, prompt: `job ${i} ${"x".repeat(2000)}` }, source);
  const host = makeHostEnv(t, "doctor-db-wal-target");
  mkdirSync(homeDir(host.env), { recursive: true });
  copyFileSync(dbPath(source), dbPath(host.env));
  copyFileSync(dbWalPath(source), dbWalPath(host.env));
  const walSize = sizeOf(dbWalPath(host.env));
  assert.ok(walSize > 32 + 4 * 4120, `the WAL is too small to cut mid-frame (${walSize} bytes)`);
  truncateSync(dbWalPath(host.env), walSize - 2000);

  const plain = await diagnose(host.env);
  assert.equal(requireRow(plain.checks, "database").status, "ok");

  const fixed = await diagnose(host.env, { args: ["--fix", "--db"] });
  const checkpoint = requireRow(fixed.checks, "db checkpoint");
  assert.equal(checkpoint.status, "ok");
  assert.match(checkpoint.detail, /^folded [1-9]\d* frames \(busy=0\)$/);
  assert.equal(sizeOf(dbWalPath(host.env)), 0);
  assert.equal(requireRow(fixed.checks, "db integrity").detail, "quick_check ok");
  assert.equal(rowOf(fixed.checks, "db repair"), undefined);
  const count = await jobCount(host.env);
  assert.ok(count < 20, `the truncated frames came back (${count} jobs)`);
});

test("doctor --fix beside a reader holding the WAL only warns busy, and nothing is lost", async (t) => {
  const host = makeHostEnv(t, "doctor-db-checkpoint-busy");
  seedJobs(host.env, 2);
  const reader = new DatabaseSync(dbPath(host.env));
  t.after(() => reader.close());
  reader.exec("BEGIN");
  reader.prepare("SELECT count(*) AS n FROM jobs").get();

  const { checks } = await diagnose(host.env, { args: ["--fix"] });
  reader.exec("COMMIT");

  const checkpoint = requireRow(checks, "db checkpoint");
  assert.equal(checkpoint.status, "warn");
  assert.match(checkpoint.detail, /^busy: a live connection kept \d+ frames$/);
  assert.equal(checkpoint.hint, "stop the runner, then nightqueue doctor --fix");
  assert.equal(await jobCount(host.env), 2);
});

test("NOTADB with an intact main file (declared probe seam): --fix moves -wal and -shm into _broken-<stamp>, and the reopen passes integrity", async (t) => {
  const host = makeHostEnv(t, "doctor-db-notadb-intact");
  seedJobs(host.env, 3);
  const notADatabase = await capturedUnavailableError(t);
  assert.ok(existsSync(dbShmPath(host.env)) && existsSync(dbWalPath(host.env)), "the fixture has no sidecars to move");
  const shmBefore = statSync(dbShmPath(host.env)).ino;
  const walBefore = statSync(dbWalPath(host.env)).ino;

  const { checks } = await diagnose(host.env, { args: ["--fix"], dbProbeImpl: async () => Promise.reject(notADatabase) });

  const [dir] = quarantines(host.env);
  assert.ok(dir, "no _broken-<stamp> directory was created");
  const quarantine = join(homeDir(host.env), dir);
  const repair = requireRow(checks, "db repair");
  assert.deepEqual(repair, {
    name: "db repair",
    status: "ok",
    detail: `moved nightqueue.db-wal, nightqueue.db-shm into ${quarantine}; integrity ok`,
    hint: null,
  });
  assert.deepEqual(readdirSync(quarantine).sort(), ["nightqueue.db-shm", "nightqueue.db-wal"]);
  assert.equal(statSync(join(quarantine, "nightqueue.db-shm")).ino, shmBefore, "the quarantined -shm is not the one that was beside the database");
  assert.equal(statSync(join(quarantine, "nightqueue.db-wal")).ino, walBefore, "the quarantined -wal is not the one that was beside the database");
  assert.notEqual(statSync(dbShmPath(host.env), { throwIfNoEntry: false })?.ino, shmBefore, "the moved -shm is still beside the database");
  assert.equal(await jobCount(host.env), 3);
});

test("NOTADB with an intact main file and a live runner registered: --fix moves nothing", async (t) => {
  const host = makeHostEnv(t, "doctor-db-notadb-live");
  seedJobs(host.env, 2);
  writeRunnerRecord({ pid: process.pid, mode: "watch", jobId: null, intervalS: 5, startedAt: new Date().toISOString(), logPath: null, runtimeDir: null }, host.env);
  const notADatabase = await capturedUnavailableError(t);

  const { checks } = await diagnose(host.env, { args: ["--fix"], alive: true, dbProbeImpl: async () => Promise.reject(notADatabase) });

  const repair = requireRow(checks, "db repair");
  assert.equal(repair.status, "warn");
  assert.match(repair.detail, /^SQLITE_NOTADB with an intact main file; not moved: a live runner is registered \(pid \d+\)$/);
  assert.deepEqual(quarantines(host.env), []);
  assert.equal(existsSync(dbShmPath(host.env)), true, "the -shm a live runner holds was moved");
  assert.equal(existsSync(dbWalPath(host.env)), true, "the -wal a live runner holds was moved");
});

const HOLDER = fileURLToPath(new URL("../test-support/db-holder.mjs", import.meta.url));
const HOLDER_HINT = "stop every nightqueue process (runners and MCP clients), then nightqueue doctor --fix";
const LSOF_SKIP = spawnSync("lsof", ["-v"]).error?.code === "ENOENT" ? "lsof is not on PATH" : false;

// Starts a child that holds a writable connection to the home, registered nowhere, the way an MCP server does; answers its pid and a way to make it write.
function startHolder(t, env) {
  const child = spawn(process.execPath, [HOLDER], { env, stdio: ["pipe", "pipe", "pipe"] });
  t.after(() => child.kill("SIGKILL"));
  let out = "";
  let err = "";
  child.stderr.on("data", (chunk) => (err += chunk));
  const waitFor = (text) =>
    new Promise((resolve, reject) => {
      const seen = () => out.includes(text) && (child.stdout.off("data", onData), resolve(out));
      const onData = (chunk) => {
        out += chunk;
        seen();
      };
      child.stdout.on("data", onData);
      child.once("exit", () => reject(new Error(`the holder exited: ${err}`)));
      seen();
    });
  return waitFor("\n").then((first) => ({
    pid: JSON.parse(first.split("\n")[0]).pid,
    write: (text) => {
      child.stdin.write(`write ${text}\n`);
      return waitFor("written\n");
    },
  }));
}

// The inodes of the two sidecars beside the database.
function sidecarInodes(env) {
  return { wal: statSync(dbWalPath(env)).ino, shm: statSync(dbShmPath(env)).ino };
}

// The prompt of the oldest job, read on a fresh read-only connection.
function oldestPrompt(env) {
  const db = new DatabaseSync(dbPath(env), { readOnly: true });
  try {
    return db.prepare("SELECT prompt FROM jobs ORDER BY id LIMIT 1").get().prompt;
  } finally {
    db.close();
  }
}

test("NOTADB with an intact main file and an unregistered process holding it: --fix moves nothing, names its pid, and its later write stays visible", { skip: LSOF_SKIP }, async (t) => {
  const host = makeHostEnv(t, "doctor-db-notadb-holder");
  seedJobs(host.env, 2);
  const holder = await startHolder(t, host.env);
  const before = sidecarInodes(host.env);
  const notADatabase = await capturedUnavailableError(t);

  const { checks } = await diagnose(host.env, { args: ["--fix"], dbProbeImpl: async () => Promise.reject(notADatabase) });

  assert.deepEqual(requireRow(checks, "db repair"), {
    name: "db repair",
    status: "warn",
    detail: `SQLITE_NOTADB with an intact main file; not moved: pid ${holder.pid} still has the database open`,
    hint: HOLDER_HINT,
  });
  assert.deepEqual(quarantines(host.env), []);
  assert.deepEqual(sidecarInodes(host.env), before, "a sidecar the holder has open was replaced");
  await holder.write("written after the doctor");
  assert.equal(oldestPrompt(host.env), "written after the doctor");
});

test("NOTADB with an intact main file when lsof cannot run: --fix cannot tell who holds the database and moves nothing", async (t) => {
  const host = makeHostEnv(t, "doctor-db-notadb-no-lsof");
  seedJobs(host.env, 2);
  const before = sidecarInodes(host.env);
  const notADatabase = await capturedUnavailableError(t);
  const lsofImpl = () => ({ error: Object.assign(new Error("spawnSync lsof ENOENT"), { code: "ENOENT" }), status: null, stdout: "", stderr: "" });

  const { checks } = await diagnose(host.env, { args: ["--fix"], dbProbeImpl: async () => Promise.reject(notADatabase), lsofImpl });

  const repair = requireRow(checks, "db repair");
  assert.deepEqual(repair, {
    name: "db repair",
    status: "warn",
    detail: "SQLITE_NOTADB with an intact main file; not moved: cannot tell whether a process holds the database (lsof: ENOENT)",
    hint: HOLDER_HINT,
  });
  assert.deepEqual(quarantines(host.env), []);
  assert.deepEqual(sidecarInodes(host.env), before);
});

test("the db shm hint says a copy for inspection is cp, never a second sqlite on the live file", async (t) => {
  const host = makeHostEnv(t, "doctor-db-shm-hint");
  seedJobs(host.env, 1);
  writeFileSync(join(homeDir(host.env), ".fuse_hidden0000000c00000001"), "orphan");

  const row = requireRow((await diagnose(host.env)).checks, "db shm");

  assert.equal(row.status, "warn");
  assert.ok(row.hint.includes("move NIGHTQUEUE_HOME to local disk; a copy for inspection is `cp`, never a second sqlite on the live file"), row.hint);
});

test("doctor --fix still repairs a moved worktree and removes the shm orphans, one row per action beside the db checkpoint", async (t) => {
  const host = makeHostEnv(t, "doctor-db-fix-alongside");
  const checkout = realpathSync(publishedCheckout(t, "doctor-db-fix-alongside").checkout);
  registerCheckout(host.env, { path: checkout, name: "alpha" });
  const projectId = ensureProject(host.env, "alpha");
  const worktree = join(homeDir(host.env), "worktrees", projectId, "moved-run");
  git(["-C", checkout, "worktree", "add", "-q", "--no-track", "-b", "worktree-moved-run", worktree, "main"]);
  const moved = join(makeDir(t, "doctor-db-fix-alongside-new"), "checkout");
  renameSync(checkout, moved);
  moveProject(openDb(host.env), { id: projectId, path: moved });
  seedJobs(host.env, 1);
  const orphan = join(homeDir(host.env), ".nfs0000000000000001");
  writeFileSync(orphan, "orphan");

  const { checks } = await diagnose(host.env, { args: ["--fix"] });

  assert.deepEqual(requireRow(checks, "worktree alpha/moved-run"), { name: "worktree alpha/moved-run", status: "ok", detail: `repaired: git links it to ${moved} again`, hint: null });
  assert.deepEqual(requireRow(checks, "db shm"), { name: "db shm", status: "ok", detail: "removed 1 hidden orphan file(s) beside the database", hint: null });
  assert.equal(requireRow(checks, "db checkpoint").status, "ok");
  for (const name of ["worktree alpha/moved-run", "db shm", "db checkpoint"]) {
    assert.equal(checks.filter((entry) => entry.name === name).length, 1, `more than one \`${name}\` row`);
  }
  assert.equal(existsSync(orphan), false);
});
