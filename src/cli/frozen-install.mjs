import { spawnSync } from "node:child_process";
import { bashTimeoutS } from "../queue/claim.mjs";

const TAIL_LINES = 10;

// Per package manager: the frozen install the runtime runs, and the command that regenerates the lockfile.
const FROZEN = {
  npm: { file: "npm", args: ["ci", "--ignore-scripts"], regenerate: "npm install" },
  yarn: { file: "yarn", args: ["install", "--frozen-lockfile", "--ignore-scripts"], regenerate: "yarn install" },
  pnpm: { file: "pnpm", args: ["install", "--frozen-lockfile", "--ignore-scripts"], regenerate: "pnpm install" },
  bun: { file: "bun", args: ["install", "--frozen-lockfile", "--ignore-scripts"], regenerate: "bun install" },
};

// The command that regenerates the lockfile of a manager, as the refusal tells the agent to run it.
export function regenerateCommand(manager) {
  return FROZEN[manager].regenerate;
}

// The last lines of an install's output, on one line so a refusal stays one `REFUSED:` entry.
function tailOf(text) {
  const lines = String(text ?? "").split("\n").map((line) => line.trim()).filter(Boolean);
  return lines.slice(-TAIL_LINES).join(" | ");
}

// Runs the manager's frozen install in a directory under the run's Bash default timeout; answers `{ ok, command, tail }` and never throws.
export function frozenInstall({ manager, cwd, env, spawnSyncImpl = spawnSync }) {
  const { file, args } = FROZEN[manager];
  const command = `${file} ${args.join(" ")}`;
  let result;
  try {
    result = spawnSyncImpl(file, args, { cwd, encoding: "utf8", timeout: bashTimeoutS(env).default * 1000, env });
  } catch (error) {
    return { ok: false, command, tail: error?.message ?? String(error) };
  }
  if (result?.status === 0 && !result?.error) return { ok: true, command, tail: "" };
  const output = [result?.stdout, result?.stderr, result?.error?.message].filter((part) => typeof part === "string" && part).join("\n");
  return { ok: false, command, tail: tailOf(output) || `exited with ${result?.status ?? "no status"}` };
}
