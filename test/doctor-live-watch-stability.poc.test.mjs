import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runnerPidPath } from "../src/config/paths.mjs";
import { makeHome } from "../test-support/memory.mjs";

// This is the architect's own R1 recipe (real `queue run --watch --foreground` + repeated real `doctor --json` +
// a real `PRAGMA wal_checkpoint(TRUNCATE)` from a third process), turned into a committed, deterministic test.
// It never existed as anything but the untracked scratch script `tmp/inode-stability.mjs`.

const CLI = fileURLToPath(new URL("../bin/nightshift.mjs", import.meta.url));
const DB_MODULE_URL = pathToFileURL(fileURLToPath(new URL("../src/memory/db.mjs", import.meta.url))).href;
const WITNESS_TIMEOUT_MS = 15000;

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

// Runs a real `nightshift doctor --json` as its own process against the given home, and returns the `db shm` check.
function realDoctorDbShmLine(env) {
  const result = spawnSync(process.execPath, [CLI, "doctor", "--json"], { env, encoding: "utf8", timeout: 10000 });
  assert.equal(result.error, undefined, `doctor did not run: ${result.error}`);
  const parsed = JSON.parse(result.stdout);
  const line = parsed.checks.find((entry) => entry.name === "db shm");
  assert.ok(line, `no \`db shm\` check in ${parsed.checks.map((entry) => entry.name).join(", ")}`);
  return line;
}

// Runs a real `PRAGMA wal_checkpoint(TRUNCATE)` from a short-lived third process, exactly as a second `nightshift`
// invocation touching the same home would.
function realThirdPartyCheckpoint(env) {
  const code = `import(${JSON.stringify(DB_MODULE_URL)}).then(({ openDb }) => { openDb(process.env).prepare("PRAGMA wal_checkpoint(TRUNCATE)").get(); process.exit(0); }).catch((err) => { console.error(err); process.exit(1); });`;
  const result = spawnSync(process.execPath, ["-e", code], { env, encoding: "utf8", timeout: 10000 });
  assert.equal(result.status, 0, `the checkpoint process failed: ${result.stderr}`);
}

test("a live `queue run --watch --foreground` keeps reporting `db shm: ok` across repeated real `doctor` runs and a real wal checkpoint", async (t) => {
  const env = makeHome(t, "doctor-live-watch-stability");
  const child = spawn(process.execPath, [CLI, "queue", "run", "--watch", "2", "--foreground"], { env, stdio: "ignore" });
  t.after(() => child.kill("SIGKILL"));

  await waitForWitness(env, child);

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const line = realDoctorDbShmLine(env);
    assert.equal(line.status, "ok", `attempt ${attempt}: db shm reported ${line.status} (${line.detail})`);
    assert.match(line.detail, /attached to the file on disk/, `attempt ${attempt}: db shm did not report a real comparison (${line.detail})`);
  }

  realThirdPartyCheckpoint(env);

  const afterCheckpoint = realDoctorDbShmLine(env);
  assert.equal(afterCheckpoint.status, "ok", `after a real wal_checkpoint(TRUNCATE): db shm reported ${afterCheckpoint.status} (${afterCheckpoint.detail})`);
  assert.match(afterCheckpoint.detail, /attached to the file on disk/, `after checkpoint: db shm did not report a real comparison (${afterCheckpoint.detail})`);
});
