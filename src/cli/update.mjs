import { ensureHome } from "../config/store.mjs";
import { checkArgs, parseCommand } from "./args.mjs";
import { setupRuntime } from "./install-steps.mjs";
import { makeReport } from "./report.mjs";
import { finish, registerHost } from "./setup.mjs";

const USAGE = "nightshift update [--from <dir>]";

// Runs `nightshift update`: reinstalls the runtime and re-points the host at it, never touching config, secrets or database; a runtime that could not be reinstalled is the whole job of this command, so it is an exit code.
export async function run(argv, ctx) {
  const { values, positionals } = parseCommand(argv, { from: { type: "string" } });
  checkArgs(positionals, { max: 0, usage: USAGE });
  const report = makeReport(ctx);
  ensureHome(ctx.env);
  const ready = setupRuntime(ctx, report, { from: values.from, force: true });
  registerHost(ctx, report, { ready });
  const code = finish(ctx, report);
  return ready ? code : 1;
}
