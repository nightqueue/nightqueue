import { UserError } from "../config/errors.mjs";
import { childExitCode } from "../host/child-exit.mjs";
import { makeThrowawayHome } from "./throwaway-home.mjs";

const USAGE = "nightqueue sandbox <command> [args...]";

// Runs one command, verbatim, against a throwaway NIGHTQUEUE_HOME and CLAUDE_CONFIG_DIR, forwarding stdio and the exit code unchanged.
export function run(argv, ctx) {
  if (!argv.length) throw new UserError(`missing argument; usage: ${USAGE}`);
  const [command, ...args] = argv;
  const home = makeThrowawayHome("nightqueue-sandbox-");
  try {
    const result = ctx.spawnSyncImpl(command, args, { stdio: "inherit", env: { ...ctx.env, ...home.env }, cwd: ctx.cwd });
    if (result.error) {
      ctx.err(`nightqueue sandbox: failed to run \`${command}\`: ${result.error.message}`);
      return 127;
    }
    return childExitCode(result);
  } finally {
    home.remove();
  }
}
