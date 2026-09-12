import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { statSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { defaultContext, run } from "../../src/cli/index.mjs";
import { dbShmPath } from "../../src/config/paths.mjs";
import { openDb } from "../../src/memory/db.mjs";
import { addJob } from "../../src/memory/jobs.mjs";
import { makeHome, makeProject } from "../../test-support/memory.mjs";

const CLI = fileURLToPath(new URL("../../bin/nightshift.mjs", import.meta.url));
const HOLDER = fileURLToPath(new URL("../../test-support/db-holder.mjs", import.meta.url));

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

// Runs `queue status --follow --until-idle` in this process with an injected sleep.
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

test("a follow session never moves the shared-memory file another process is attached to, and still sees what that process wrote", async (t) => {
  const env = makeHome(t, "follow-shm-stability");
  makeProject(t, env, "alpha");
  const id = addJob({ project: "alpha", prompt: "fix the worker" }, env).id;
  openDb(env);

  const holder = await startHolder(t, env);
  const before = shmIdentity(env);
  assert.equal(before, `${holder.dev}:${holder.ino}`, "the holder opened a shared-memory file other than the one on disk");

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
  assert.ok(ticks >= 2, "the loop stopped before the write of the other process");
  assert.deepEqual([...new Set(duringTicks)], [before], "the shared-memory file moved while a second process was attached to it");
  assert.equal(shmIdentity(env), before, "the shared-memory file moved by the end of the follow session");
  assert.match(result.out.join("\n"), /cancelled/, "the follow never rendered the row a third process wrote");
  assert.equal(holder.child.exitCode, null, "the holder died during the follow session");
});
