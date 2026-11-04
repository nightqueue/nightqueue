import { UserError } from "../config/errors.mjs";
import { childExitCode } from "../host/child-exit.mjs";
import { makeThrowawayHome } from "./throwaway-home.mjs";

const USAGE = "nightqueue sandbox <command> [args...]";
const WORKTREE_REMOVED =
  "`sandbox worktree` was removed: a job's worktree (`queue add`) or a run's own worktree covers it; `nightqueue sandbox <command>` still runs one command against a throwaway home";

// Runs one command, verbatim, against a throwaway NIGHTQUEUE_HOME and CLAUDE_CONFIG_DIR, forwarding stdio and the exit code unchanged.
export function run(argv, ctx) {
  if (!argv.length) throw new UserError(`missing argument; usage: ${USAGE}`);
  const [command, ...args] = argv;
  if (command === "worktree") throw new UserError(WORKTREE_REMOVED);
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
