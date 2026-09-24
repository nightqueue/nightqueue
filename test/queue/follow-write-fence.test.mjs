import assert from "node:assert/strict";
import { chmodSync, existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { defaultContext, run } from "../../src/cli/index.mjs";
import { dbPath, runnerRegistryPath } from "../../src/config/paths.mjs";
import { closeDb, hasCachedWriteConnection, openDb, openDbReadOnly } from "../../src/memory/db.mjs";
import { addJob, claimJobById } from "../../src/memory/jobs.mjs";
import { writeRunnerRecord } from "../../src/queue/registry.mjs";
import { writeRunTerminal } from "../../src/queue/resume.mjs";
import { makeHome, makeProject } from "../../test-support/memory.mjs";

// ACCEPTANCE of decision #24: `queue status --follow` writes nothing, on a read-only home where a repair and a prune WOULD write.

const QUEUE_SRC = fileURLToPath(new URL("../../src/cli/queue.mjs", import.meta.url));
const REDRAW = "\u001b[0J";
const HEADER = /ID\s+STATUS\s+DURATION/;
const TICKS = 3;
const DEAD_PID = 999_998;
const SLUG = "lost-finish";

// A kill double that says no process answers for any pid, the way a registration of a dead runner looks.
function deadKill() {
  throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
}

// A job left `running` by a dead runner whose witness already says it finished: a repair would rewrite the row.
function lostFinish(env) {
  const id = addJob({ project: "alpha", prompt: "fix the worker" }, env).id;
  claimJobById(id, { worker: "host:1", cap: 4 }, env);
  openDb(env).prepare("UPDATE jobs SET slug = ?, lease_until = datetime('now', '-120 seconds') WHERE id = ?").run(SLUG, id);
  const terminal = { status: "done", prUrl: "https://github.com/acme/api/pull/7", finishedAt: "2026-09-11T03:15:00Z", writtenBy: "/tmp/runtime", pid: 4242 };
  assert.equal(writeRunTerminal({ project: "alpha", slug: SLUG, terminal, env }).status, "written", "setup: the witness was not written");
  return id;
}

// A job delivered with a pull request, the row a merge sweep used to rewrite.
function delivered(env) {
  const id = addJob({ project: "alpha", prompt: "deliver it" }, env).id;
  openDb(env).prepare("UPDATE jobs SET status = 'done', pr_url = ? WHERE id = ?").run("https://github.com/acme/api/pull/8", id);
  return id;
}

// Makes the database file read-only for the rest of the test, unless the process is root and would write through it anyway.
function fenceDatabase(t, env) {
  if (process.getuid?.() === 0) return false;
  chmodSync(dbPath(env), 0o444);
  t.after(() => chmodSync(dbPath(env), 0o644));
  return true;
}

// Runs `queue status --follow 1` in this process on a fake terminal, stopping itself with a real SIGINT after a few ticks.
async function runFollow(env) {
  const frames = [];
  const err = [];
  let ticks = 0;
  const ctx = {
    ...defaultContext(),
    env,
    out: () => {},
    err: (line) => err.push(line),
    stdout: { isTTY: true, columns: 200, write: (text) => text.includes(REDRAW) && frames.push(text) },
    killImpl: deadKill,
    sleep: async () => {
      ticks += 1;
      if (ticks >= TICKS) process.kill(process.pid, "SIGINT");
      await new Promise((done) => setTimeout(done, 20));
    },
  };
  const code = await run(["queue", "status", "--follow", "1"], ctx);
  return { code, frames, err };
}

// The source of one top-level function of a file, from its header to its closing brace, so a pin never reads the comment of the next one.
function functionSource(path, header) {
  const text = readFileSync(path, "utf8");
  const start = text.indexOf(header);
  assert.ok(start >= 0, `\`${header}\` moved or was renamed; update this pin`);
  const end = text.indexOf("\n}\n", start);
  assert.ok(end > start, `\`${header}\` has no closing brace at column 0; update this pin`);
  return text.slice(start, end + 2);
}

test("a follow running against a write-fenced store never throws, renders normally and writes nothing", async (t) => {
  const env = makeHome(t, "follow-write-fence");
  makeProject(t, env, "alpha");
  const lost = lostFinish(env);
  delivered(env);
  writeRunnerRecord({ pid: DEAD_PID, startedAt: new Date().toISOString(), mode: "watch", intervalS: 30, logPath: "/tmp/dead.log" }, env);
  const pidfile = runnerRegistryPath(DEAD_PID, env);
  closeDb(env);
  assert.equal(hasCachedWriteConnection(env), false, "setup: a write connection is still cached");
  const fenced = fenceDatabase(t, env);
  t.diagnostic(fenced ? "database file fenced read-only (0444)" : "running as root: the chmod fence is skipped, the other assertions carry the proof");

  const result = await runFollow(env);

  assert.equal(result.code, 0, result.err.join("\n"));
  assert.deepEqual(result.err, [], "the follow printed a warning: something on its path tried to write");
  assert.ok(result.frames.length >= TICKS, `the follow drew ${result.frames.length} frames`);
  for (const frame of result.frames) assert.match(frame, HEADER, "a frame came out without the table");
  assert.equal(hasCachedWriteConnection(env), false, "the follow opened a write connection");
  assert.equal(existsSync(pidfile), true, "the follow pruned a dead registration");
  const reader = openDbReadOnly(env);
  try {
    assert.equal(reader.prepare("SELECT status FROM jobs WHERE id = ?").get(lost).status, "running", "the follow repaired the row");
  } finally {
    reader.close();
  }
});

test("the body of followStatus holds no maintenance: no repair, no prune, no write store", () => {
  const source = functionSource(QUEUE_SRC, "async function followStatus");
  for (const token of ["runMaintenance", "Maintenance", "repair", "prune", "openStore(", "migrateIfOutdated"]) {
    assert.equal(source.includes(token), false, `followStatus mentions \`${token}\`: the follow writes again`);
  }
});
