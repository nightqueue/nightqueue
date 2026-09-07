import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const FAKE_CLAUDE = fileURLToPath(new URL("./fake-claude-stream.mjs", import.meta.url));

// Writes the plan of the fake `claude` and points the environment at it, one attempt per entry.
export function useFakeClaude(env, dir, attempts) {
  const planPath = join(dir, "fake-claude-plan.json");
  writeFileSync(planPath, JSON.stringify({ attempts }));
  env.NIGHTSHIFT_CLAUDE_BIN = FAKE_CLAUDE;
  env.NIGHTSHIFT_FAKE_PLAN = planPath;
  return planPath;
}

// Every call the fake `claude` received, with the argv, the job id and the working directory of each one.
export function fakeCalls(planPath) {
  const path = `${planPath}.calls.jsonl`;
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

// Value of an option of a recorded argv, so a test never asserts on a position.
export function argValue(argv, flag) {
  const index = argv.indexOf(flag);
  return index < 0 ? null : (argv[index + 1] ?? null);
}
