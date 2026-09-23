import { constants } from "node:os";

// Exit code of a spawned child: its own status, or 128 plus the signal number that killed it.
export function childExitCode(result) {
  if (typeof result?.signal === "string") return 128 + (constants.signals[result.signal] ?? 0);
  return typeof result?.status === "number" ? result.status : 0;
}
