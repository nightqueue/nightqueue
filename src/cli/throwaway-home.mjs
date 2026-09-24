import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Creates a throwaway NIGHTQUEUE_HOME and CLAUDE_CONFIG_DIR under a fresh temp directory, so a command never reaches the operator's own.
export function makeThrowawayHome(prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const env = { NIGHTQUEUE_HOME: join(root, "home"), CLAUDE_CONFIG_DIR: join(root, "claude") };
  mkdirSync(env.NIGHTQUEUE_HOME, { recursive: true });
  mkdirSync(env.CLAUDE_CONFIG_DIR, { recursive: true });
  return { env, remove: () => rmSync(root, { recursive: true, force: true }) };
}
