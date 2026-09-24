import { existsSync } from "node:fs";
import { isAbsolute, relative } from "node:path";
import { UserError } from "../config/errors.mjs";
import { normalizePath, projectByName, resolveProject } from "../config/projects.mjs";
import { loadConfig } from "../config/store.mjs";
import { launchOperator } from "../host/operator.mjs";
import { isSessionIdSafe } from "../queue/stream.mjs";
import { checkArgs, parseCommand } from "./args.mjs";

const USAGE = "nightqueue open [project] [--resume <session>]";
const OPTIONS = { resume: { type: "string" } };

// The project the session opens: the one named, else the one registered for the current directory.
function openProject(name, ctx) {
  const config = loadConfig(ctx.env, { warn: ctx.err });
  if (name !== undefined) {
    const named = projectByName(config, name);
    if (!named) throw new UserError(`unknown project \`${name}\`; run \`nightqueue project list\` to see the registered ones`);
    return named;
  }
  const cwd = normalizePath(ctx.cwd);
  const found = resolveProject(config, { cwd });
  if (!found) throw new UserError(`no project is registered for ${cwd}; run \`nightqueue setup\` there first`);
  return found;
}

// Tells whether a directory is the checkout itself or lies inside it (a worktree of it included).
function insideCheckout(checkout, dir) {
  const rest = relative(checkout, dir);
  return rest === "" || (!isAbsolute(rest) && rest.split(/[\\/]/)[0] !== "..");
}

// The directory the session runs in: the current one when resuming from inside the checkout (a session is found only where it was born), else the checkout.
function sessionCwd({ checkout, resumeSession, cwd }) {
  const current = normalizePath(cwd);
  return resumeSession !== null && insideCheckout(checkout, current) ? current : checkout;
}

// Runs `nightqueue open`: the operator of the project as the main thread of an interactive `claude`, under the operator guard.
export function run(argv, ctx) {
  const { values, positionals } = parseCommand(argv, OPTIONS);
  checkArgs(positionals, { max: 1, usage: USAGE });
  const resumeSession = values.resume ?? null;
  if (resumeSession !== null && !isSessionIdSafe(resumeSession)) {
    throw new UserError(`\`--resume ${resumeSession}\` is not a session id; usage: ${USAGE}`);
  }
  const project = openProject(positionals[0], ctx);
  const checkout = normalizePath(project.path);
  if (!existsSync(checkout)) throw new UserError(`the checkout of \`${project.name}\` is gone (${checkout}); run \`nightqueue project list\``);
  return launchOperator({ cwd: sessionCwd({ checkout, resumeSession, cwd: ctx.cwd }), resumeSession, ctx });
}
