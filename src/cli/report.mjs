// One line of the report, always `<label>: <status>` plus an optional detail.
export function stepLine(label, status, detail) {
  return `${label}: ${status}${detail ? ` (${detail})` : ""}`;
}

// First line of a subprocess error, short enough to sit inside a report line.
export function firstLine(text) {
  return String(text ?? "").trim().split("\n")[0].slice(0, 200);
}

// Reporter of the run: prints every step and counts the ones that could not be finished.
export function makeReport(ctx) {
  let degraded = 0;
  return {
    step: (label, status, detail) => ctx.out(stepLine(label, status, detail)),
    degrade: (label, reason, command) => {
      degraded += 1;
      ctx.out(stepLine(label, "failed", reason));
      if (command) ctx.err(`shift: finish this step by hand: ${command}`);
    },
    count: () => degraded,
  };
}
