import { spawn, spawnSync } from "node:child_process";
import { UserError } from "../config/errors.mjs";
import { withLock } from "../config/lock.mjs";
import { saveConfig, saveSecrets } from "../config/store.mjs";
import { warmupModel } from "../memory/embedding.mjs";
import * as connection from "./connection.mjs";
import * as doctor from "./doctor.mjs";
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
import * as update from "./update.mjs";
import * as version from "./version.mjs";

const COMMANDS = new Map([
  ["setup", setup.run],
  ["doctor", doctor.run],
  ["init", init.run],
  ["update", update.run],
  ["org", org.run],
  ["project", project.run],
  ["connection", connection.run],
  ["mcp", mcp.run],
  ["hook", hook.run],
  ["reflect", reflect.run],
  ["embed", embed.run],
  ["memory", memory.run],
  ["queue", queue.run],
  ["version", version.run],
]);

const HELP_FLAGS = new Set(["--help", "-h", "help"]);

const READ_ONLY_COMMANDS = new Set(["doctor", "version"]);

const READ_ONLY_SUBCOMMANDS = new Set(["list", "test"]);

const SELF_LOCKING_COMMANDS = new Set(["mcp", "hook", "reflect", "embed", "memory", "queue"]);

const USAGE = `nightshift — configuration CLI

usage: nightshift <command> [options]

commands:
  setup [--from <dir>] [--remove]           install the runtime in the home and register the MCP server, hooks and plugin in the host
  doctor [--json] [--check-updates]         check the host and the home, one line per check; exits 1 on any failure
  init [path] [--gh|--no-gh]                install the runtime and register the git repository at [path] (default: .) as a project
  update [<version>] [--from] [--force]     reinstall the runtime at the newest version (or at <version>) and re-point the host at it
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
  mcp                                       start the stdio MCP server that exposes the eleven memory and queue tools
  hook session-start|prompt-context|reflect run a hook, reading the event JSON from stdin
  reflect --transcript <path> [--session]   extract the lessons of a transcript now, in the foreground
  embed install                             install the embedding library into the home and download its weights
  embed download                            download the embedding weights into the home (the only network path)
  embed backfill                            compute the embeddings of the lessons that still have none
  memory stats [--json]                     count lessons, memories, index entries and runs per project
  queue add [project] <prompt...> [--run]   enqueue an unattended /nightshift:resolve run; --run starts it detached
  queue status [id] [--limit] [--json]      show one job or the table of the queue plus the counts per status
  queue status --follow [s] [--until-idle]  keep the table on screen, redrawn every s seconds (default 2)
  queue run [--job | --watch] [--max]       start the runner detached; --foreground runs it here, --stop ends a watcher
  queue cancel <id> [--reason "..."]        cancel a pending, gated or orphaned job
  queue retry <id> [--note] [--fresh]       send a gated, failed or cancelled job back to the queue; --run starts it detached
  queue pause | resume                      stop claiming new jobs, or claim again
  queue log <id> [--follow] [--raw] [--all] narrate the stream of a job; --raw prints it as it was written
  version                                   print the installed nightshift version

options:
  -h, --help                                show this help
  --version                                 print the installed nightshift version and exit

exit codes: 0 ok · 1 user error · 2 unexpected error
configuration home: $NIGHTSHIFT_HOME (default ~/.nightshift)`;

// Creates the default execution context of the CLI.
export function defaultContext() {
  return {
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
    env: process.env,
    cwd: process.cwd(),
    fetchImpl: (...args) => fetch(...args),
    spawnSyncImpl: (file, args, options) => spawnSync(file, args, options),
    spawnImpl: (file, args, options) => spawn(file, args, options),
    killImpl: (pid, signal) => process.kill(pid, signal),
    warmupImpl: (options, env) => warmupModel(options, env),
    stdin: process.stdin,
    stdout: process.stdout,
    saveConfig,
    saveSecrets,
  };
}

// Tells whether the command runs without the configuration write lock: it only reads, or it owns its own concurrency control.
function skipsLock(command, subcommand) {
  if (READ_ONLY_COMMANDS.has(command)) return true;
  if (SELF_LOCKING_COMMANDS.has(command)) return true;
  if (command === "setup" || command === "init" || command === "update") return false;
  return READ_ONLY_SUBCOMMANDS.has(subcommand);
}

// Dispatches the requested command, without handling errors, with the cross-process lock when it writes.
export async function main(argv, ctx) {
  const [command, ...rest] = argv;
  if (!command || HELP_FLAGS.has(command)) {
    ctx.out(USAGE);
    return 0;
  }
  if (command === "--version") {
    ctx.out(version.readVersion());
    return 0;
  }
  const handler = COMMANDS.get(command);
  if (!handler) throw new UserError(`unknown command \`${command}\`; run \`nightshift --help\``);
  if (skipsLock(command, rest[0])) return await handler(rest, ctx);
  return await withLock(ctx.env, () => handler(rest, ctx));
}

// Runs the CLI and returns the exit code: the only place that turns an error into a code.
export async function run(argv, ctx = defaultContext()) {
  try {
    const result = await main(argv, ctx);
    return typeof result === "number" ? result : 0;
  } catch (err) {
    if (err instanceof UserError) {
      ctx.err(`nightshift: ${err.message}`);
      return 1;
    }
    ctx.err(err?.stack ?? String(err));
    return 2;
  }
}
