import { spawnSync } from "node:child_process";

export const PS_TIMEOUT_MS = 5000;
const PS_LINE = /^\s*(\S+\s+\S+\s+\d+\s+\d\d:\d\d:\d\d\s+\d{4})\s+(.+)$/;

// Reads one `ps -o lstart= -o command=` line into the start time and the command line, or null when it is not one.
export function parsePsLine(text) {
  const match = PS_LINE.exec(String(text ?? "").split("\n")[0]);
  return match ? { lstart: match[1].replace(/\s+/g, " "), command: match[2] } : null;
}

// The start time and command line of a live process, or null when ps does not know the pid.
export function readProcess(pid) {
  const result = spawnSync("ps", ["-ww", "-p", String(pid), "-o", "lstart=", "-o", "command="], { encoding: "utf8", timeout: PS_TIMEOUT_MS });
  if (result.error || result.status !== 0) return null;
  return parsePsLine(result.stdout);
}
