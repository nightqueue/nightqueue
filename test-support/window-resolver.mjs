import { resolveWindow } from "../src/queue/window.mjs";

// Resolves the window the JSON on argv[2] describes and reports it together with the local wall-clock time of each
// instant and this process's own UTC offset, so the parent proves TZ actually reached this child.
function main() {
  const { from, until, nowMs } = JSON.parse(process.argv[2]);
  const window = resolveWindow({ from, until, nowMs });
  const wallClock = (ms) => {
    const date = new Date(ms);
    return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  };
  process.stdout.write(
    `${JSON.stringify({ ...window, fromClock: wallClock(window.fromMs), untilClock: wallClock(window.untilMs), offsetMinutes: new Date().getTimezoneOffset() })}\n`,
  );
}

main();
