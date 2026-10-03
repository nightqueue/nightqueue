import { setImmediate as nextTurn } from "node:timers/promises";

const YIELD_EVERY_CHARS = 1024 * 1024;

// Calls `onLine` for every `\n`-separated line of a text, handing the event loop back after each megabyte so a big log never stalls it.
export async function eachLineYielding(text, onLine) {
  const source = String(text ?? "");
  let start = 0;
  let sinceYield = 0;
  while (start <= source.length) {
    const end = source.indexOf("\n", start);
    const stop = end === -1 ? source.length : end;
    onLine(source.slice(start, stop));
    sinceYield += stop - start + 1;
    start = stop + 1;
    if (sinceYield >= YIELD_EVERY_CHARS) {
      sinceYield = 0;
      await nextTurn();
    }
  }
}
