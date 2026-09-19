import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultContext, run } from "../../src/cli/index.mjs";
import { addJob } from "../../src/memory/jobs.mjs";
import { makeHome, makeProject } from "../../test-support/memory.mjs";

const ESC = "\u001b";

// Runs `queue status --follow` on a fake terminal for a number of ticks and keeps every write as it came.
async function follow(env, { ticks, columns = 200, rows = 40 }) {
  const writes = [];
  let count = 0;
  const ctx = {
    ...defaultContext(),
    env,
    out: () => {},
    err: () => {},
    stdout: { isTTY: true, columns, rows, write: (text) => writes.push(text) },
    sleep: async () => {
      count += 1;
      if (count >= ticks) process.emit("SIGINT");
    },
  };
  const code = await run(["queue", "status", "--follow"], ctx);
  return { code, writes };
}

test("a follow on a terminal redraws the table over itself and never clears the screen", async (t) => {
  const env = makeHome(t, "follow-redraw");
  makeProject(t, env, "alpha");
  addJob({ project: "alpha", prompt: "fix the worker" }, env);

  const { code, writes } = await follow(env, { ticks: 3 });
  assert.equal(code, 0);
  const frames = writes.filter((text) => text.includes(`${ESC}[0J`));
  assert.ok(frames.length >= 3, `drew ${frames.length} frames`);
  for (const text of writes) assert.equal(text.includes(`${ESC}[2J`), false, "a frame cleared the whole screen, which piles one table per tick in the scrollback");
  assert.ok(frames[0].startsWith(`${ESC}[?25l\r${ESC}[0J`), "the first frame did not hide the cursor and draw where it stood");
  const drawn = frames[0].split("\n").length - 1;
  assert.ok(frames[1].startsWith(`${ESC}[${drawn}A\r${ESC}[0J`), `the second frame did not climb the ${drawn} rows of the first`);
  assert.equal(writes.at(-1), `${ESC}[?25h`, "the cursor was not given back on the way out");
});

test("a frame taller or wider than the terminal is cut to it, so the climb back never misses", async (t) => {
  const env = makeHome(t, "follow-redraw-fit");
  makeProject(t, env, "alpha");
  for (let index = 0; index < 12; index += 1) addJob({ project: "alpha", prompt: `job ${index}` }, env);

  const { writes } = await follow(env, { ticks: 1, columns: 60, rows: 8 });
  const frame = writes.find((text) => text.includes(`${ESC}[0J`));
  const rows = frame.split("\n").slice(0, -1);
  assert.ok(rows.length <= 7, `the frame took ${rows.length} rows of a terminal of 8`);
  assert.match(frame, /… \+\d+ more lines/);
  for (const row of rows) {
    const visible = [...row.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "").replace("\r", "")].length;
    assert.ok(visible <= 60, `a row is ${visible} columns wide on a terminal of 60`);
  }
});
