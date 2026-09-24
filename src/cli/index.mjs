import { spawn, spawnSync } from "node:child_process";
import { UserError } from "../config/errors.mjs";
import { withLock } from "../config/lock.mjs";
import { saveConfig, saveSecrets } from "../config/store.mjs";
import { warmupModel } from "../memory/embedding.mjs";
import { refuseHomeWriteInsideJob } from "../queue/home-guard.mjs";
import * as connection from "./connection.mjs";
import * as decision from "./decision.mjs";
import * as doctor from "./doctor.mjs";
import * as embed from "./embed.mjs";
import * as hook from "./hook.mjs";
import * as init from "./init.mjs";
import * as libs from "./libs.mjs";
import * as mcp from "./mcp.mjs";
import * as memory from "./memory.mjs";
import * as open from "./open.mjs";
import * as org from "./org.mjs";
import * as project from "./project.mjs";
import * as queue from "./queue.mjs";
import * as reflect from "./reflect.mjs";
import * as roadmap from "./roadmap.mjs";
import * as runCommand from "./run.mjs";
import * as sandbox from "./sandbox.mjs";
import * as setup from "./setup.mjs";
import * as update from "./update.mjs";
import * as verify from "./verify.mjs";
import * as version from "./version.mjs";

const COMMANDS = new Map([
  ["setup", setup.run],
  ["doctor", doctor.run],
  ["init", init.run],
  ["open", open.run],
  ["update", update.run],
  ["org", org.run],
  ["project", project.run],
  ["connection", connection.run],
  ["mcp", mcp.run],
  ["hook", hook.run],
  ["reflect", reflect.run],
  ["embed", embed.run],
  ["memory", memory.run],
  ["decision", decision.run],
  ["roadmap", roadmap.run],
  ["queue", queue.run],
  ["verify", verify.run],
  ["sandbox", sandbox.run],
  ["libs", libs.run],
  ["run", runCommand.run],
  ["version", version.run],
]);

const HELP_FLAGS = new Set(["--help", "-h", "help"]);

const HELP_OPTIONS = new Set(["--help", "-h"]);

const READ_ONLY_COMMANDS = new Set(["doctor", "version", "decision", "roadmap", "verify", "sandbox", "libs", "open"]);

const READ_ONLY_SUBCOMMANDS = new Set(["list", "test"]);

const SELF_LOCKING_COMMANDS = new Set(["mcp", "hook", "reflect", "embed", "memory", "queue", "run"]);

const HOME_WRITE_COMMANDS = new Set(["init", "setup", "update"]);

const HOME_WRITE_SUBCOMMANDS = new Map([
  ["org", new Set(["add", "rename", "remove"])],
  ["project", new Set(["add", "remove", "move"])],
  ["connection", new Set(["add", "bind", "remove"])],
  ["embed", new Set(["install", "download", "backfill"])],
  ["queue", new Set(["add", "cancel", "close", "pause", "resume"])],
]);

const USAGE = `nightshift — configuration CLI

usage: nightshift <command> [options]

commands:
  setup [--from <dir>] [--remove]           install the runtime in the home and register the MCP server, hooks and plugin in the host
  doctor [--json] [--check-updates]         check the host and the home, one line per check; exits 1 on any failure
  init [path] [--gh|--no-gh]                install the runtime and register the git repository at [path] (default: .) as a project
  open [project] [--resume <session>]       open the operator in a terminal: it investigates, plans and queues jobs, and never edits the code
  update [<version>] [--from] [--force]     reinstall the runtime at the newest version (or at <version>) and re-point the host at it
  org add <name> [--display-name "..."]     create an org
  org list [--json]                         list orgs, their connection slots and project counts
  org rename <old> <new>                    rename an org and every project pointing at it
  org remove <name>                         remove an empty, non-default org
  org repair [--to <org>]                   settle an interrupted rename; move orphan org rows under --to
  project add <path> [--org] [--name]       register a project (same behaviour as init)
  project list [--json]                     list projects, their org and whether the path still exists
  project remove <name>                     unregister a project
  project move <name> <org>                 move a project to another org
  connection add <name> --type <type>       store a secret read from stdin and bind it to a free org slot
  connection bind <name> --org <name>       bind (or rebind) a stored connection to an org slot
  connection test <name>                    check a stored connection against its service
  connection list [--json]                  list connections, their type and the orgs using them
  connection remove <name>                  unbind a connection from every org and delete its secret
  mcp                                       start the stdio MCP server that exposes the twenty-five memory and queue tools
  mcp --http [--port <n>] [--token <t>]     serve the same tools over Streamable HTTP on 127.0.0.1
  hook session-start|prompt-context|reflect run a hook, reading the event JSON from stdin
  reflect --transcript <path> [--session]   extract the lessons of a transcript now, in the foreground
  embed install                             install the embedding library into the home and download its weights
  embed download                            download the embedding weights into the home (the only network path)
  embed backfill                            compute the embeddings of the lessons and decisions that still have none
  memory stats [--json]                     count lessons, memories, index entries and runs per project
  decision list [--project|--org] [--status]  list the architecture decisions of a project and of its org
  decision show <number> [--project|--org]  print one decision in full
  decision export <number> [--dir] [--force]  write one decision as a markdown file (default: docs, folder decisions, of the current directory); never writes the database
  decision import <file.md> [--status] [--superseded-by <n>] [--supersedes <n,...>] [--unrelated <n,...>]  save a markdown decision file, reviewed like decision_save, and stamp its row number into it
  decision update <number> --status accepted|rejected|superseded [--superseded-by <n>]  accept, reject or supersede a decision, same as decision_update
  roadmap [--project|--org]                 print the now/next/later roadmap of a project and of its org
  queue add [project] <prompt...> [--run]   enqueue an unattended /nightshift:resolve run; --run starts it detached
  queue status [id] [--limit] [--json]      show one job or the table of the queue plus the counts per status
  queue status --follow [s] [--until-idle]  keep the table on screen, redrawn every s seconds (default 2)
  queue run [--job | --watch] [--max]       start the runner detached, one job at a time; --max <n> exits after n jobs, --foreground runs it here, --stop ends a watcher
  queue cancel <id> [--reason "..."]        cancel a pending, gated, done, failed or orphaned job; a done or failed one also releases its worktree
  queue close <id> | --merged               merge a done job's pull request and close the job: preflight, conflict, merge, settle; detached unless --foreground; --merged closes every done job whose pull request is merged; --decisions accept|reject|keep settles the decisions they proposed
  queue retry <id> [--note] [--fresh]       send a gated, failed or cancelled job back to the queue; --run starts it detached
  queue repair <id> [--json]                re-classify a gated or failed job from its own log; corrects a lost PR link
  queue pause | resume                      stop claiming new jobs, or claim again
  queue log <id> [--follow] [--raw] [--all] narrate the stream of a job; --raw prints it as it was written
  queue session <id> [--print] [--json]     resume the claude session of a job's last attempt as the operator (nightshift open --resume); --print shows it without exec'ing
  verify [--scope touched|full|+poc]        run the project's own checks in a fixed order, one line per check; exits 1 on any failure
  verify [--files <list>]                   narrow the checks that accept a file list to those paths (comma-separated, repeatable)
  sandbox <command> [args...]               run one command against a throwaway NIGHTSHIFT_HOME and CLAUDE_CONFIG_DIR
  libs <name>...                            print the version of each lib INSTALLED here, read from the lockfile, never the range
  run index-save <artifact> [--project]     save the \`## File map\` and \`## Third-party libraries\` of an explore artifact in the index
  run index-save [--repo-root <path>]       index the artifact's paths relative to <path>, the repository root (default: .)
  run secrets-sweep --files <list>          print the log lines whose arguments reference a token/secret/password/key value
  version                                   print the installed nightshift version

inside a job — each acts on the run of the job it is called from, never on the queue:
  run check <NN>                            check the artifact of a phase of THIS run: OK, MISSING or GENERATED
  run log [--json]                          one line per phase of THIS run: model, status and duration
  run commit --message-file <path>          stage what 04-implementation.md listed and commit it; --extra adds a pathspec
  run pr --body-file <path>                 check the body, push THIS run's branch under its final name and open the PR

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

// Tells whether the command writes the configuration home, and whether it registers the host too.
function writesOperatorHome(command, subcommand) {
  if (HOME_WRITE_COMMANDS.has(command)) return { writes: true, host: true };
  return { writes: HOME_WRITE_SUBCOMMANDS.get(command)?.has(subcommand) === true, host: false };
}

// Tells whether the destination command reads what is left of its arguments as a request for help: only a lone flag is one, never a word of free text.
function asksForHelp(args) {
  return args.length === 1 && HELP_OPTIONS.has(args[0]);
}

// Refuses a write aimed at the operator's own home before the lock creates anything there; asking for help is never a write.
function guardOperatorHome(command, rest, env) {
  const { writes, host } = writesOperatorHome(command, rest[0]);
  if (!writes) return;
  if (asksForHelp(HOME_WRITE_COMMANDS.has(command) ? rest : rest.slice(1))) return;
  refuseHomeWriteInsideJob(env, { host });
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
  guardOperatorHome(command, rest, ctx.env);
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
