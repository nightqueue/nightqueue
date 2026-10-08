import assert from "node:assert/strict";
import { test } from "node:test";
import { eachLineYielding } from "../../src/queue/yielding-lines.mjs";

// Blocks the thread for the given number of milliseconds
function busyWait(ms) {
  const until = performance.now() + ms;
  while (performance.now() < until) {}
}

test("a slow onLine hands the event loop back before the byte budget is reached", async () => {
  const text = Array.from({ length: 200 }, (_, index) => `line ${index}`).join("\n");
  let loopRan = false;
  setImmediate(() => {
    loopRan = true;
  });
  let handled = 0;
  await eachLineYielding(text, () => {
    handled += 1;
    if (handled <= 50) busyWait(5);
  });
  assert.equal(handled, 200);
  assert.ok(loopRan, "the event loop never ran while the lines were being handled");
});
