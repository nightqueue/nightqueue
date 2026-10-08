import { performance } from "node:perf_hooks";
import { setImmediate as nextTurn } from "node:timers/promises";

const YIELD_EVERY_CHARS = 1024 * 1024;
const YIELD_EVERY_MS = 25;
const CLOCK_CHECK_EVERY_ITEMS = 64;

// A turn-taker for a synchronous loop: called after each item, it answers a promise once a megabyte or 25 ms of work piled up, else null.
export function createTurnTaker() {
  let sinceYield = 0;
  let items = 0;
  let yieldedAt = performance.now();
  const pause = async () => {
    sinceYield = 0;
    await nextTurn();
    yieldedAt = performance.now();
  };
  return (size = 0) => {
    sinceYield += size;
    items += 1;
    const overBytes = sinceYield >= YIELD_EVERY_CHARS;
    const overTime = items % CLOCK_CHECK_EVERY_ITEMS === 0 && performance.now() - yieldedAt >= YIELD_EVERY_MS;
    return overBytes || overTime ? pause() : null;
  };
}

// Calls `onLine` for every `\n`-separated line of a text, handing the event loop back after each megabyte or 25 ms of work so a big log never stalls it.
export async function eachLineYielding(text, onLine) {
  const source = String(text ?? "");
  const turn = createTurnTaker();
  let start = 0;
  while (start <= source.length) {
    const end = source.indexOf("\n", start);
    const stop = end === -1 ? source.length : end;
    onLine(source.slice(start, stop));
    const pause = turn(stop - start + 1);
    start = stop + 1;
    if (pause) await pause;
  }
}
