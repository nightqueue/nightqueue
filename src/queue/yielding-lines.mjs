import { performance } from "node:perf_hooks";
import { setImmediate as nextTurn } from "node:timers/promises";

const YIELD_EVERY_CHARS = 1024 * 1024;
const YIELD_EVERY_MS = 25;
const CLOCK_CHECK_EVERY_LINES = 64;

// Calls `onLine` for every `\n`-separated line of a text, handing the event loop back after each megabyte or 25 ms of work so a big log never stalls it.
export async function eachLineYielding(text, onLine) {
  const source = String(text ?? "");
  let start = 0;
  let sinceYield = 0;
  let lines = 0;
  let yieldedAt = performance.now();
  while (start <= source.length) {
    const end = source.indexOf("\n", start);
    const stop = end === -1 ? source.length : end;
    onLine(source.slice(start, stop));
    sinceYield += stop - start + 1;
    start = stop + 1;
    lines += 1;
    const overBytes = sinceYield >= YIELD_EVERY_CHARS;
    const overTime = lines % CLOCK_CHECK_EVERY_LINES === 0 && performance.now() - yieldedAt >= YIELD_EVERY_MS;
    if (overBytes || overTime) {
      sinceYield = 0;
      await nextTurn();
      yieldedAt = performance.now();
    }
  }
}
