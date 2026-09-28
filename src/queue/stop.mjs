import { STOP_TIMEOUT_MS, stopAllRunners, stopRunner } from "./registry.mjs";

// What the operator reads after a stop, and the exit code it answers with: only a runner that stays behind fails.
export function stopReport({ outcome, pid, path }) {
  if (outcome === "absent") return { line: "runner is not running", code: 0 };
  if (outcome === "stale") return { line: "runner was not running (stale registration removed)", code: 0 };
  if (outcome === "stopped") return { line: `runner stopped (pid ${pid})`, code: 0 };
  if (outcome === "foreign") {
    return { line: `runner (pid ${pid}) belongs to another user; nightqueue will not signal it - check that pid and remove ${path} by hand`, code: 1 };
  }
  const seconds = STOP_TIMEOUT_MS / 1000;
  return { line: `runner (pid ${pid}) did not stop within ${seconds}s; it finishes the job it is running and exits by itself`, code: 1 };
}

// Ends every registered runner when no pid is given, or only the runner registered under that pid.
export async function stopRunners({ pid = null, env = process.env, killImpl } = {}) {
  const stop = { env, killImpl };
  if (pid === null) return await stopAllRunners(stop);
  return [await stopRunner({ pid, ...stop })];
}
