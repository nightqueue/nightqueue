import { constants } from "node:os";
import { UserError } from "../config/errors.mjs";
import { makeThrowawayHome } from "./throwaway-home.mjs";

const USAGE = "nightshift sandbox <command> [args...]";

// Exit code of a spawned child: its own status, or 128 plus the signal number that killed it.
function exitCodeOf(result) {
  if (typeof result.signal === "string") return 128 + (constants.signals[result.signal] ?? 0);
  return typeof result.status === "number" ? result.status : 0;
}

// Runs one command, verbatim, against a throwaway NIGHTSHIFT_HOME and CLAUDE_CONFIG_DIR, forwarding stdio and the exit code unchanged.
export function run(argv, ctx) {
  if (!argv.length) throw new UserError(`missing argument; usage: ${USAGE}`);
  const [command, ...args] = argv;
  const home = makeThrowawayHome("nightshift-sandbox-");
  try {
    const result = ctx.spawnSyncImpl(command, args, { stdio: "inherit", env: { ...ctx.env, ...home.env }, cwd: ctx.cwd });
    if (result.error) {
      ctx.err(`nightshift sandbox: failed to run \`${command}\`: ${result.error.message}`);
      return 127;
    }
    return exitCodeOf(result);
  } finally {
    home.remove();
  }
}
