import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { run } from "../src/cli/index.mjs";
import { UserError } from "../src/config/errors.mjs";
import { lockPath, withLock } from "../src/config/lock.mjs";
import { assertIsolatedEnv, isolatedHostVars } from "../test-support/host.mjs";

const CLI = fileURLToPath(new URL("../bin/nightqueue.mjs", import.meta.url));
const RACE_ATTEMPTS = 8;
const HOST_DIR = mkdtempSync(join(tmpdir(), "nightqueue-lock-host-"));
const HOST_VARS = isolatedHostVars(HOST_DIR);

after(() => rmSync(HOST_DIR, { recursive: true, force: true }));

// Creates an isolated temporary home and removes it at the end of the test.
function makeEnv(t) {
  const base = mkdtempSync(join(tmpdir(), "nightqueue-lock-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  return { NIGHTQUEUE_HOME: join(base, "home") };
}

// Builds a CLI context that captures the output instead of writing to the terminal.
function makeContext(env) {
  const out = [];
  const err = [];
  return { ctx: { env, out: (line) => out.push(line), err: (line) => err.push(line) }, out, err };
}

// Runs the CLI as a real child process; stays async (never spawnSync) so the Promise.all in `runRace` really overlaps the writes.
function shiftAsync(home, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: assertIsolatedEnv({ ...process.env, ...HOST_VARS, NIGHTQUEUE_HOME: home }),
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("exit", (code) => resolve({ code, stderr }));
  });
}

// Runs one round of two concurrent `org add` and reports what survived in config.json.
async function runRace(t) {
  const home = makeEnv(t).NIGHTQUEUE_HOME;
  const setup = spawnSync(process.execPath, [CLI, "setup"], {
    env: assertIsolatedEnv({ ...process.env, ...HOST_VARS, NIGHTQUEUE_HOME: home }),
    encoding: "utf8",
  });
  assert.equal(setup.status, 0, `setup failed (stderr: ${setup.stderr})`);
  const [a, b] = await Promise.all([shiftAsync(home, ["org", "add", "proc-a"]), shiftAsync(home, ["org", "add", "proc-b"])]);
  const config = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
  return { a, b, hasA: Object.hasOwn(config.orgs, "proc-a"), hasB: Object.hasOwn(config.orgs, "proc-b") };
}

test("withLock excludes a second holder and releases the lock even when the action throws", async (t) => {
  const env = makeEnv(t);
  await assert.rejects(
    withLock(env, async () => {
      await assert.rejects(withLock(env, async () => "never", { timeoutMs: 100 }), (err) => {
        assert.ok(err instanceof UserError);
        assert.match(err.message, /another nightqueue command is writing to the configuration home/);
        assert.match(err.message, /remove `.*home\.lock`/);
        return true;
      });
      throw new Error("action failed");
    }),
    /action failed/,
  );
  assert.equal(existsSync(lockPath(env)), false);
});

test("a lock abandoned by a dead process is taken over after the age limit", async (t) => {
  const env = makeEnv(t);
  const path = lockPath(env);
  mkdirSync(path, { recursive: true });
  const longAgo = new Date(Date.now() - 600000);
  utimesSync(path, longAgo, longAgo);
  assert.equal(await withLock(env, async () => "acquired", { timeoutMs: 100, staleAfterMs: 300000 }), "acquired");
  assert.equal(existsSync(path), false);
});

test("a read-only command runs while another process holds the write lock", async (t) => {
  const env = makeEnv(t);
  const { ctx, out } = makeContext(env);
  mkdirSync(lockPath(env), { recursive: true });
  t.after(() => rmSync(lockPath(env), { recursive: true, force: true }));
  assert.equal(await run(["project", "list"], ctx), 0);
  assert.deepEqual(out, ["no projects registered"]);
  assert.equal(await run(["--help"], ctx), 0);
  assert.equal(existsSync(join(env.NIGHTQUEUE_HOME, "config.json")), false);
});

test("two concurrent `nightqueue org add` processes both keep their write", async (t) => {
  for (let attempt = 1; attempt <= RACE_ATTEMPTS; attempt += 1) {
    const { a, b, hasA, hasB } = await runRace(t);
    assert.equal(a.code, 0, `attempt ${attempt}: process A exited ${a.code} (stderr: ${a.stderr})`);
    assert.equal(b.code, 0, `attempt ${attempt}: process B exited ${b.code} (stderr: ${b.stderr})`);
    assert.equal(hasA, true, `attempt ${attempt}: org \`proc-a\` was lost (lost update)`);
    assert.equal(hasB, true, `attempt ${attempt}: org \`proc-b\` was lost (lost update)`);
  }
});
