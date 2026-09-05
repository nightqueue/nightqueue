import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { run } from "../src/cli/index.mjs";
import { UserError } from "../src/config/errors.mjs";
import { lockPath, withLock } from "../src/config/lock.mjs";

// Cria um home temporario isolado e o remove ao fim do teste.
function makeEnv(t) {
  const base = mkdtempSync(join(tmpdir(), "nightshift-lock-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  return { NIGHTSHIFT_HOME: join(base, "home") };
}

// Monta um contexto de CLI que captura a saida em vez de escrever no terminal.
function makeContext(env) {
  const out = [];
  const err = [];
  return { ctx: { env, out: (line) => out.push(line), err: (line) => err.push(line) }, out, err };
}

test("withLock excludes a second holder and releases the lock even when the action throws", async (t) => {
  const env = makeEnv(t);
  await assert.rejects(
    withLock(env, async () => {
      await assert.rejects(withLock(env, async () => "never", { timeoutMs: 100 }), (err) => {
        assert.ok(err instanceof UserError);
        assert.match(err.message, /another shift command is writing to the configuration home/);
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
  assert.equal(existsSync(join(env.NIGHTSHIFT_HOME, "config.json")), false);
});
