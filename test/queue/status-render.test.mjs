import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultContext, run } from "../../src/cli/index.mjs";
import { openDb } from "../../src/memory/db.mjs";
import { addJob } from "../../src/memory/jobs.mjs";
import { makeHome, makeProject, seedClosedJob } from "../../test-support/memory.mjs";

// A job written straight into the table with the given status.
function seedJob(env, status) {
  const id = addJob({ project: "alpha", prompt: "fix the worker" }, env).id;
  openDb(env).prepare("UPDATE jobs SET status = ? WHERE id = ?").run(status, id);
  return id;
}

// Runs `queue status` in this process, on a fake terminal when `color` is true.
async function statusLines(env, { color = true } = {}) {
  const out = [];
  const ctx = { ...defaultContext(), env, out: (line) => out.push(line), err: () => {}, stdout: { isTTY: color, columns: 200 } };
  const code = await run(["queue", "status"], ctx);
  return { code, out };
}

// The line of the table that belongs to a job.
function tableLine(out, id) {
  return out.find((line) => line.startsWith(`#${id} `)) ?? "";
}

test("a closed job is painted 38;5;91 on a terminal, and carries no escape when colour is off", async (t) => {
  const env = makeHome(t, "status-render-closed");
  makeProject(t, env, "alpha");
  const id = seedClosedJob(env);

  const withColor = await statusLines(env);
  assert.equal(withColor.code, 0, withColor.out.join("\n"));
  assert.match(tableLine(withColor.out, id), /\u001b\[38;5;91m■ closed\s*\u001b\[0m/);

  const withoutColor = await statusLines(env, { color: false });
  assert.equal(/\u001b\[/.test(tableLine(withoutColor.out, id)), false, "a non-terminal output carried colour");
});

test("a job under a live close is painted as its status and labelled `done · closing`, and a closed one `closed` alone", async (t) => {
  const env = makeHome(t, "status-render-close");
  makeProject(t, env, "alpha");
  const closing = seedJob(env, "done");
  const closed = seedClosedJob(env);
  const db = openDb(env);
  db.prepare("UPDATE jobs SET close_status = 'closing', close_worker = 'close:host:1:aaaa', close_lease_until = datetime('now', '+10 minutes') WHERE id = ?").run(closing);

  const { code, out } = await statusLines(env);
  assert.equal(code, 0, out.join("\n"));
  assert.match(tableLine(out, closing), /\u001b\[32m✓ done · closing\s*\u001b\[0m/);
  assert.match(tableLine(out, closed), /\u001b\[38;5;91m■ closed\s*\u001b\[0m/);
});

test("a row whose status is outside the job status enum renders marked, with one advisory naming it and the row count", async (t) => {
  const env = makeHome(t, "status-render-unknown");
  makeProject(t, env, "alpha");
  const first = seedJob(env, "merged");
  const second = seedJob(env, "merged");

  const { out } = await statusLines(env);
  for (const id of [first, second]) {
    assert.match(tableLine(out, id), /\u001b\[97;41m! merged\s*\u001b\[0m/, `job #${id} did not render marked`);
  }
  assert.deepEqual(
    out.filter((line) => line.includes("unknown status")),
    ["2 jobs carry the unknown status 'merged'; run nightqueue doctor"],
    "the advisory did not fold both rows into one line",
  );
});

// A gate job whose notice is the given text.
function seedGateWithNotice(env, notice) {
  const id = seedJob(env, "gate");
  openDb(env).prepare("UPDATE jobs SET notice_md = ? WHERE id = ?").run(notice, id);
  return id;
}

test("a notice cut by the listing prints no pointer line in the human table, since the table itself never shows the 500-char cut", async (t) => {
  const env = makeHome(t, "status-render-truncated");
  makeProject(t, env, "alpha");
  seedGateWithNotice(env, "x".repeat(1500));

  const cut = await statusLines(env, { color: false });
  assert.equal(cut.code, 0, cut.out.join("\n"));
  assert.equal(cut.out.some((line) => line.includes("text cut at")), false, "the human table printed the truncation pointer");

  const fitsEnv = makeHome(t, "status-render-fits");
  makeProject(t, fitsEnv, "alpha");
  seedGateWithNotice(fitsEnv, "needs a decision");
  const fits = await statusLines(fitsEnv, { color: false });
  assert.equal(fits.code, 0, fits.out.join("\n"));
  const countsLine = "pending=0  running=0  done=0  gate=1  failed=0  cancelled=0  closed=0";
  assert.equal(fits.out.at(-1), countsLine, "a listing where every text fits grew a line after the counts");
  assert.equal(cut.out.at(-1), countsLine, "the cut listing grew a line after the counts, though the pointer is dropped");
  assert.equal(cut.out.length, fits.out.length, "the cut and the fitting listing now differ in line count");
});

test("nine cut notices print no text-cut line in the table, while --json keeps the suggestion", async (t) => {
  const env = makeHome(t, "status-render-nine-cut");
  makeProject(t, env, "alpha");
  for (let i = 0; i < 9; i += 1) seedGateWithNotice(env, "x".repeat(1500));

  const table = await statusLines(env, { color: false });
  assert.equal(table.code, 0, table.out.join("\n"));
  assert.equal(table.out.some((line) => line.includes("text cut at")), false, "the human table printed the truncation pointer");

  const out = [];
  const ctx = { ...defaultContext(), env, out: (line) => out.push(line), err: () => {} };
  assert.equal(await run(["queue", "status", "--json"], ctx), 0);
  const view = JSON.parse(out.join("\n"));
  assert.equal(view.jobs.filter((job) => job.notice_truncated === true).length, 9);
  assert.equal(view.suggestions.filter((line) => line.startsWith("9 jobs have text cut at 500 characters")).length, 1, view.suggestions.join("\n"));
});

test("a single job with an unknown status is worded in the singular", async (t) => {
  const env = makeHome(t, "status-render-unknown-singular");
  makeProject(t, env, "alpha");
  seedJob(env, "weird");

  const { out } = await statusLines(env);
  assert.deepEqual(out.filter((line) => line.includes("unknown status")), ["1 job carries the unknown status 'weird'; run nightqueue doctor"]);
});
