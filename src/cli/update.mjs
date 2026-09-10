import { UserError } from "../config/errors.mjs";
import { ensureHome } from "../config/store.mjs";
import { countActiveJobs } from "../memory/jobs.mjs";
import { runnerPidfileState } from "../queue/pidfile.mjs";
import { checkArgs, parseCommand } from "./args.mjs";
import { setupRuntime } from "./install-steps.mjs";
import { makeReport } from "./report.mjs";
import { finish, registerHost } from "./setup.mjs";

const USAGE = "nightshift update [<version>] [--from <dir>] [--force]";

const BUSY_REFUSAL = "a job is running - update after it finishes, or stop the runner first (nightshift queue run --stop)";

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

// Jobs holding a live lease, or null when the queue database could not be read: an update is the repair path, so a database it cannot open never blocks it.
function activeJobs(env) {
  try {
    return countActiveJobs(env);
  } catch {
    return null;
  }
}

// Refuses to swap the runtime under a queue that is working: a live lease or a registered watcher both mean somebody is mid-run.
function guardIdleQueue(ctx, force) {
  if (force === true) return;
  const running = activeJobs(ctx.env);
  const watcher = runnerPidfileState(ctx.env, ctx.killImpl).status === "alive";
  if (watcher || (running !== null && running > 0)) throw new UserError(BUSY_REFUSAL);
}

// Runs `nightshift update`: reinstalls the runtime and re-points the host at it, never touching config, secrets or database; a runtime that could not be reinstalled is the whole job of this command, so it is an exit code.
export async function run(argv, ctx) {
  const { values, positionals } = parseCommand(argv, { from: { type: "string" }, force: { type: "boolean" } });
  checkArgs(positionals, { max: 1, usage: USAGE });
  const version = wantedVersion(positionals, values.from);
  guardIdleQueue(ctx, values.force);
  const report = makeReport(ctx);
  ensureHome(ctx.env);
  const ready = setupRuntime(ctx, report, { from: values.from, force: true, version });
  registerHost(ctx, report, { ready });
  const code = finish(ctx, report);
  return ready ? code : 1;
}
