import { UserError } from "../config/errors.mjs";
import { ensureHome } from "../config/store.mjs";
import { checkArgs, parseCommand } from "./args.mjs";
import { guardIdleRuntime } from "./install-guard.mjs";
import { setupRuntime } from "./install-steps.mjs";
import { makeReport } from "./report.mjs";
import { finish, registerHost } from "./setup.mjs";

const USAGE = "nightshift update [<version>] [--from <dir>] [--force]";

const VERSION_SHAPE = /^[A-Za-z0-9][A-Za-z0-9.+-]*$/;

// Version the user asked the registry for, refusing anything that would reach npm as another package or as a flag.
function wantedVersion(positionals, from) {
  const asked = (positionals[0] ?? "").trim();
  if (!asked) return undefined;
  if (typeof from === "string" && from.trim()) {
    throw new UserError(`\`--from\` installs a local source, so it cannot be combined with a version; usage: ${USAGE}`);
  }
  if (!VERSION_SHAPE.test(asked)) throw new UserError(`\`${asked}\` is not a version or a tag; usage: ${USAGE}`);
  return asked;
}

// Runs `nightshift update`: reinstalls the runtime and re-points the host at it, never touching config, secrets or database; a runtime that could not be reinstalled is the whole job of this command, so it is an exit code.
export async function run(argv, ctx) {
  const { values, positionals } = parseCommand(argv, { from: { type: "string" }, force: { type: "boolean" } });
  checkArgs(positionals, { max: 1, usage: USAGE });
  const version = wantedVersion(positionals, values.from);
  guardIdleRuntime(ctx, { force: values.force });
  const report = makeReport(ctx);
  ensureHome(ctx.env);
  const ready = setupRuntime(ctx, report, { from: values.from, force: true, version });
  registerHost(ctx, report, { ready });
  const code = finish(ctx, report);
  return ready ? code : 1;
}
