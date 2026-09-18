import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultContext, run } from "../../src/cli/index.mjs";
import { openDb } from "../../src/memory/db.mjs";
import { addJob } from "../../src/memory/jobs.mjs";
import { makeHome, makeProject } from "../../test-support/memory.mjs";

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
  const id = seedJob(env, "closed");

  const withColor = await statusLines(env);
  assert.equal(withColor.code, 0, withColor.out.join("\n"));
  assert.match(tableLine(withColor.out, id), /\u001b\[38;5;91m■ closed\s*\u001b\[0m/);

  const withoutColor = await statusLines(env, { color: false });
  assert.equal(/\u001b\[/.test(tableLine(withoutColor.out, id)), false, "a non-terminal output carried colour");
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
    ["2 jobs carry the unknown status 'merged'; run nightshift doctor"],
    "the advisory did not fold both rows into one line",
  );
});

test("a single job with an unknown status is worded in the singular", async (t) => {
  const env = makeHome(t, "status-render-unknown-singular");
  makeProject(t, env, "alpha");
  seedJob(env, "weird");

  const { out } = await statusLines(env);
  assert.deepEqual(out.filter((line) => line.includes("unknown status")), ["1 job carries the unknown status 'weird'; run nightshift doctor"]);
});
