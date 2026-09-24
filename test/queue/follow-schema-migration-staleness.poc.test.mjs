import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { defaultContext, run } from "../../src/cli/index.mjs";
import { dbPath } from "../../src/config/paths.mjs";
import { openDb } from "../../src/memory/db.mjs";
import { addJob, claimJobById, finishJob } from "../../src/memory/jobs.mjs";
import { makeHome, makeProject } from "../../test-support/memory.mjs";

const MAX_TICKS = 20;

// Runs `queue status --follow` in this process with an injected sleep, so the loop ticks without waiting;
// a runaway loop sends itself a real SIGINT after MAX_TICKS so a bug in the scenario cannot hang the suite.
async function runFollow(env, { onTick } = {}) {
  const out = [];
  const err = [];
  let ticks = 0;
  const ctx = {
    ...defaultContext(),
    env,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    stdout: { isTTY: false, columns: 120, write: () => {} },
    sleep: async () => {
      ticks += 1;
      if (ticks > MAX_TICKS) {
        process.kill(process.pid, "SIGINT");
        return;
      }
      await onTick?.(ticks);
    },
    killImpl: () => {
      throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
    },
  };
  const code = await run(["queue", "status", "--follow", "--until-idle"], ctx);
  return { code, out, err, ticks };
}

// Plays a newer nightqueue version's migration (an `ALTER TABLE ADD COLUMN`) from a real, independent process,
// against the same database file, without ever touching this repo's own DB_USER_VERSION constant.
function migrateFromSecondProcess(path, jobId, value) {
  const script = [
    'const { DatabaseSync } = require("node:sqlite");',
    "const db = new DatabaseSync(process.argv[1]);",
    'db.exec("PRAGMA busy_timeout = 5000");',
    'db.exec("ALTER TABLE jobs ADD COLUMN risk_note TEXT");',
    'db.prepare("UPDATE jobs SET risk_note = ? WHERE id = ?").run(process.argv[2], Number(process.argv[3]));',
    "db.close();",
  ].join("\n");
  return spawnSync(process.execPath, ["-e", script, path, value, String(jobId)], { encoding: "utf8" });
}

test("a live `queue status --follow` session keeps seeing fresh data after a concurrent schema migration lands a new column mid-session", async (t) => {
  const env = makeHome(t, "follow-schema-migration");
  makeProject(t, env, "alpha");
  const id = addJob({ project: "alpha", prompt: "fix the worker" }, env).id;
  claimJobById(id, { worker: "host:1", cap: 4 }, env);

  const first = openDb(env);
  assert.equal(first.prepare("SELECT COUNT(*) AS n FROM jobs").get().n, 1, "job setup failed before the attack");

  let migration;
  const result = await runFollow(env, {
    onTick: (tick) => {
      if (tick === 1) migration = migrateFromSecondProcess(dbPath(env), id, "critical-from-migration");
      if (tick === 2) {
        finishJob(id, { worker: "host:1", status: "done", prUrl: "https://github.com/acme/api/pull/7" }, env);
      }
    },
  });

  assert.ok(result.ticks <= MAX_TICKS, "the follow session never reached idle after the job finished — it hung");
  assert.equal(result.code, 0, result.err.join("\n"));
  assert.equal(migration?.status, 0, `the concurrent migration itself failed: ${migration?.stderr}`);
  assert.equal(openDb(env), first, "the follow reopened its connection across the migration");

  const row = first.prepare("SELECT risk_note FROM jobs WHERE id = ?").get(id);
  assert.equal(
    row?.risk_note,
    "critical-from-migration",
    "the follow's long-lived connection did not see the column a concurrent schema migration added — it is reading a stale schema",
  );

  assert.ok(
    !result.err.some((line) => /error/i.test(line)),
    `the follow session errored after the concurrent migration: ${result.err.join("\n")}`,
  );
});
