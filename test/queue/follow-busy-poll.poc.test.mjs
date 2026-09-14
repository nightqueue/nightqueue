import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { defaultContext, run } from "../../src/cli/index.mjs";
import { dbPath } from "../../src/config/paths.mjs";
import { openDb, openDbReadOnly } from "../../src/memory/db.mjs";
import { addJob, claimJobById } from "../../src/memory/jobs.mjs";
import { makeHome, makeProject } from "../../test-support/memory.mjs";

// Group A hypothesis (05a-qa-analyst.md): `openDbReadOnly` never sets `busy_timeout`, unlike the cached
// write connection `openDb` sets up via `initConnection`. The question is whether that absence is actually
// reachable: does a runner's write transaction (always `BEGIN IMMEDIATE`, see `src/memory/jobs.mjs`'s
// `inTransaction`) ever block a plain read on a WAL read-only connection? WAL's entire design point is that
// readers do not block on writers - the two tests below measure that directly against this repo's own code,
// then against the full `queue status --follow` loop, instead of assuming either way.

test("openDbReadOnly succeeds while a writer holds an uncommitted BEGIN IMMEDIATE transaction (WAL readers are not blocked by a writer's lock)", (t) => {
  const env = makeHome(t, "follow-busy-poll-direct");
  makeProject(t, env, "alpha");
  const job = addJob({ project: "alpha", prompt: "fix the worker" }, env);

  const writer = openDb(env);
  writer.exec("BEGIN IMMEDIATE");
  writer.prepare("UPDATE jobs SET priority = priority WHERE id = ?").run(job.id);

  // Self-check the lock is real (not a no-op setup): a second, independent writer connection trying to grab
  // its own BEGIN IMMEDIATE right now must be refused with SQLITE_BUSY, or this "contention" proves nothing.
  const rival = new DatabaseSync(dbPath(env));
  assert.throws(
    () => rival.exec("BEGIN IMMEDIATE"),
    /SQLITE_BUSY|database is locked/i,
    "a rival writer was not refused; the first writer's transaction never actually took the lock, so this test cannot prove anything about reader contention",
  );
  rival.close();

  // The actual question: does the read-only path this diff introduced throw under that same held lock?
  const reader = openDbReadOnly(env);
  let row;
  assert.doesNotThrow(() => {
    row = reader.prepare("SELECT id, status FROM jobs WHERE id = ?").get(job.id);
  }, "openDbReadOnly threw under a writer's uncommitted BEGIN IMMEDIATE transaction; WAL readers should not block on a writer's lock");
  assert.equal(row.id, job.id);
  reader.close();

  writer.exec("COMMIT");
});

// Runs `queue status --follow --until-idle` in this process with an injected sleep, exactly the entry point an operator watches.
async function runFollow(env, onTick) {
  const out = [];
  const err = [];
  const ctx = {
    ...defaultContext(),
    env,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    stdout: { isTTY: false, columns: 200, write: () => {} },
    sleep: async () => await onTick(),
    killImpl: () => {
      throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
    },
  };
  const code = await run(["queue", "status", "--follow", "--until-idle"], ctx);
  return { code, out, err };
}

// The snapshots a piped follow printed, one entry per redraw: on a pipe each one is closed by an empty line.
function snapshots(out) {
  const groups = [];
  let current = [];
  for (const line of out) {
    if (line !== "") {
      current.push(line);
      continue;
    }
    groups.push(current.join("\n"));
    current = [];
  }
  if (current.length) groups.push(current.join("\n"));
  return groups;
}

test("a queue status --follow session survives and finishes correctly while a runner-style writer holds its claim/finish transaction open across several polls", async (t) => {
  const env = makeHome(t, "follow-busy-poll-session");
  makeProject(t, env, "alpha");
  const id = addJob({ project: "alpha", prompt: "fix the worker" }, env).id;
  claimJobById(id, { worker: "host:1", cap: 4 }, env);

  // A separate connection, exactly the shape a runner process holds: a real `BEGIN IMMEDIATE` transaction
  // (the same statement `src/memory/jobs.mjs`'s `inTransaction` issues for every claim/finish/sweepOrphans),
  // opened before a poll and left uncommitted across it - never through `openDb(env)`, which would hit this
  // process's own cache instead of acting like an independent connection.
  const rival = new DatabaseSync(dbPath(env));
  let lockOpen = false;
  let sawGenuineBusyOnRival = false;

  let ticks = 0;
  const result = await runFollow(env, () => {
    ticks += 1;
    if (ticks === 1) {
      rival.exec("BEGIN IMMEDIATE");
      rival.prepare("UPDATE jobs SET worker = worker WHERE id = ?").run(id);
      lockOpen = true;
      // Prove the lock is genuinely held right when the next poll's reads will run: a second independent
      // writer must be refused right now, or "holding a lock across the poll" below is not actually true.
      const probe = new DatabaseSync(dbPath(env));
      try {
        probe.exec("BEGIN IMMEDIATE");
        probe.exec("ROLLBACK");
      } catch (err) {
        sawGenuineBusyOnRival = /SQLITE_BUSY|database is locked/i.test(String(err?.message ?? ""));
      } finally {
        probe.close();
      }
      return;
    }
    if (ticks === 2) {
      // The lock is still open for this poll's reads (tick 2's `withReadOnlyStore` calls already ran, right
      // before the loop called `wait()` to reach this callback). Finish the job through the same held
      // transaction, then release it, so the next poll can observe the terminal state.
      rival.prepare(
        "UPDATE jobs SET status = 'done', pr_url = ?, finished_at = ?, worker = NULL, lease_until = NULL WHERE id = ?",
      ).run("https://github.com/acme/api/pull/9", "2026-01-01 00:00:00", id);
      rival.exec("COMMIT");
      lockOpen = false;
    }
  });

  assert.equal(lockOpen, false, "the test's own lock was left open; this run cannot be trusted");
  assert.ok(sawGenuineBusyOnRival, "the held transaction never actually blocked a rival writer; the contention this test relies on was not real");
  // Reaching tick 2's callback proves iteration 2's own `withReadOnlyStore` reads (repairFromWitness +
  // queueViewLines) already ran and rendered successfully WHILE tick 1's lock was still open - `wait()`
  // (which is what invokes this callback) only runs after that iteration's render completed without throwing.
  assert.ok(ticks >= 2, `the follow loop only reached tick ${ticks}; it never polled while the rival writer's lock was open, so this run proves nothing about contention`);

  assert.equal(result.code, 0, `the follow session did not exit cleanly while a writer held a lock across its polls: ${result.err.join("\n")}`);
  assert.deepEqual(result.err, [], `the follow session wrote to stderr while a writer held a lock across its polls: ${result.err.join("\n")}`);

  const views = snapshots(result.out);
  assert.ok(views.length >= 2, `the follow redrew only ${views.length} time(s); it never rendered a final snapshot after the contended tick`);
  assert.match(views[0], /running/, "the first poll did not render the claimed job as running");
  const last = views.at(-1);
  assert.match(last, /done/, "the follow never rendered the job as done after the writer released its lock");
  assert.ok(last.includes("https://github.com/acme/api/pull/9"), `the final snapshot carries no pull request URL: ${last}`);
});
