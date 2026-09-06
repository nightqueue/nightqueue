import { UserError } from "../config/errors.mjs";
import { withLock } from "../config/lock.mjs";
import { saveConfig, saveSecrets } from "../config/store.mjs";
import * as connection from "./connection.mjs";
import * as init from "./init.mjs";
import * as org from "./org.mjs";
import * as project from "./project.mjs";
import * as setup from "./setup.mjs";

const COMMANDS = new Map([
  ["setup", setup.run],
  ["init", init.run],
  ["org", org.run],
  ["project", project.run],
  ["connection", connection.run],
]);

const HELP_FLAGS = new Set(["--help", "-h", "help"]);

const READ_ONLY_SUBCOMMANDS = new Set(["list", "test"]);

const USAGE = `shift — nightshift configuration

usage: shift <command> [options]

commands:
  setup                                     create the configuration home (0700), config.json and secrets.json (0600)
  init [path] [--org <n>] [--name <n>]      register the git repository at [path] (default: .) as a project
  org add <name> [--display-name "..."]     create an org
  org list [--json]                         list orgs, their connection slots and project counts
  org rename <old> <new>                    rename an org and every project pointing at it
  org remove <name>                         remove an empty, non-default org
  project add <path> [--org] [--name]       register a project (same behaviour as init)
  project list [--json]                     list projects, their org and whether the path still exists
  project remove <name>                     unregister a project
  project move <name> <org>                 move a project to another org
  connection add <name> --type <type>       store a secret read from stdin and bind it to a free org slot
  connection bind <name> --org <name>       bind (or rebind) a stored connection to an org slot
  connection test <name>                    check a stored connection against its service
  connection list [--json]                  list connections, their type and the orgs using them
  connection remove <name>                  unbind a connection from every org and delete its secret

options:
  -h, --help                                show this help

exit codes: 0 ok · 1 user error · 2 unexpected error
configuration home: $NIGHTSHIFT_HOME (default ~/.nightshift)`;

// Creates the default execution context of the CLI.
export function defaultContext() {
  return {
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
    env: process.env,
    fetchImpl: (...args) => fetch(...args),
    stdin: process.stdin,
    stdout: process.stdout,
    saveConfig,
    saveSecrets,
  };
}

// Tells whether the command only reads the configuration and therefore skips the write lock.
function isReadOnly(command, subcommand) {
  if (command === "setup" || command === "init") return false;
  return READ_ONLY_SUBCOMMANDS.has(subcommand);
}

// Dispatches the requested command, without handling errors, with the cross-process lock when it writes.
export async function main(argv, ctx) {
  const [command, ...rest] = argv;
  if (!command || HELP_FLAGS.has(command)) {
    ctx.out(USAGE);
    return;
  }
  const handler = COMMANDS.get(command);
  if (!handler) throw new UserError(`unknown command \`${command}\`; run \`shift --help\``);
  if (isReadOnly(command, rest[0])) {
    await handler(rest, ctx);
    return;
  }
  await withLock(ctx.env, () => handler(rest, ctx));
}

// Runs the CLI and returns the exit code: the only place that turns an error into a code.
export async function run(argv, ctx = defaultContext()) {
  try {
    await main(argv, ctx);
    return 0;
  } catch (err) {
    if (err instanceof UserError) {
      ctx.err(`shift: ${err.message}`);
      return 1;
    }
    ctx.err(err?.stack ?? String(err));
    return 2;
  }
}
