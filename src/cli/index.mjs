import { UserError } from "../config/errors.mjs";
import { withLock } from "../config/lock.mjs";
import { saveConfig, saveSecrets } from "../config/store.mjs";
import * as connection from "./connection.mjs";
import * as embed from "./embed.mjs";
import * as hook from "./hook.mjs";
import * as init from "./init.mjs";
import * as mcp from "./mcp.mjs";
import * as memory from "./memory.mjs";
import * as org from "./org.mjs";
import * as project from "./project.mjs";
import * as queue from "./queue.mjs";
import * as reflect from "./reflect.mjs";
import * as setup from "./setup.mjs";

const COMMANDS = new Map([
  ["setup", setup.run],
  ["init", init.run],
  ["org", org.run],
  ["project", project.run],
  ["connection", connection.run],
  ["mcp", mcp.run],
  ["hook", hook.run],
  ["reflect", reflect.run],
  ["embed", embed.run],
  ["memory", memory.run],
  ["queue", queue.run],
]);

const HELP_FLAGS = new Set(["--help", "-h", "help"]);

const READ_ONLY_SUBCOMMANDS = new Set(["list", "test"]);

const SELF_LOCKING_COMMANDS = new Set(["mcp", "hook", "reflect", "embed", "memory", "queue"]);

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
  mcp                                       start the stdio MCP server that exposes the six memory tools
  hook session-start|prompt-context|reflect run a hook, reading the event JSON from stdin
  reflect --transcript <path> [--session]   extract the lessons of a transcript now, in the foreground
  embed download                            download the embedding weights into the home (the only network path)
  embed backfill                            compute the embeddings of the lessons that still have none
  memory stats [--json]                     count lessons, memories, index entries and runs per project
  queue add <project> <prompt>              enqueue an unattended /nightshift:resolve run for a project
  queue status [id] [--limit] [--json]      show one job or the tail of the queue plus the counts per status
  queue run [--job] [--max] [--watch]       claim pending jobs and run them; --dry only reports what it would do
  queue cancel <id> [--reason "..."]        cancel a pending or orphaned job
  queue pause | resume                      stop claiming new jobs, or claim again
  queue log <id> [--follow]                 print the accumulated stream of a job

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

// Tells whether the command runs without the configuration write lock: it only reads, or it owns its own concurrency control.
function skipsLock(command, subcommand) {
  if (SELF_LOCKING_COMMANDS.has(command)) return true;
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
  if (skipsLock(command, rest[0])) {
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
