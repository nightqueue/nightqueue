import { ensureHome } from "../config/store.mjs";
import { checkArgs, parseCommand } from "./args.mjs";
import { setupRuntime } from "./install-steps.mjs";
import { makeReport } from "./report.mjs";
import { finish, registerHost } from "./setup.mjs";

const USAGE = "shift update [--from <dir>]";

// Runs `shift update`: reinstalls the runtime and re-points the host at it, never touching config, secrets or database.
export async function run(argv, ctx) {
  const { values, positionals } = parseCommand(argv, { from: { type: "string" } });
  checkArgs(positionals, { max: 0, usage: USAGE });
  const report = makeReport(ctx);
  ensureHome(ctx.env);
  const ready = setupRuntime(ctx, report, { from: values.from, force: true });
  registerHost(ctx, report, { ready });
  return finish(ctx, report);
}
