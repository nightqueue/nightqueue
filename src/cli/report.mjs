// One line of the report, always `<label>: <status>` plus an optional detail.
export function stepLine(label, status, detail) {
  return `${label}: ${status}${detail ? ` (${detail})` : ""}`;
}

// First line of a subprocess error, short enough to sit inside a report line.
export function firstLine(text) {
  return String(text ?? "").trim().split("\n")[0].slice(0, 200);
}

// Statuses of a step that changed nothing on disk, the only ones a collapsing report may hold back.
const NO_OP_STATUSES = new Set(["already present", "ok", "skipped", "kept"]);

// Reporter of the run: prints every step and counts the ones that could not be finished; in collapsing mode a step that changed nothing waits until a line that changed something needs it printed first.
export function makeReport(ctx, { collapse = false } = {}) {
  let degraded = 0;
  let printed = 0;
  const held = [];
  const write = (line) => {
    printed += 1;
    ctx.out(line);
  };
  const flush = () => {
    while (held.length) write(held.shift());
  };
  return {
    step: (label, status, detail) => {
      const line = stepLine(label, status, detail);
      if (collapse && NO_OP_STATUSES.has(status)) {
        held.push(line);
        return;
      }
      flush();
      write(line);
    },
    degrade: (label, reason, command) => {
      degraded += 1;
      flush();
      write(stepLine(label, "failed", reason));
      if (command) ctx.err(`nightqueue: finish this step by hand: ${command}`);
    },
    note: (line) => {
      flush();
      write(line);
    },
    flush,
    quiet: () => printed === 0 && held.length > 0,
    count: () => degraded,
  };
}
