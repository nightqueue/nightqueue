import { basename, isAbsolute, join, relative, sep } from "node:path";
import { isId } from "../config/ids.mjs";
import { SHIM_NAME, SHORTCUT_SHIM_NAMES, qaDir, runsDir, worktreesDir } from "../config/paths.mjs";
import { registeredCheckouts } from "../memory/registry-access.mjs";
import {
  FORBIDDEN_SHELL_CHARS,
  canonicalPath,
  insideRoots,
  isDeniedFlag,
  pluginRoots,
  sessionSpillRoot,
  tokenize,
} from "./orchestrator-scope.mjs";

export const OPERATOR_DECISION = "D-58";

// Every top-level command of the CLI, classified for the operator's main thread: the allowed ones read or record through the
// registry and the queue, the refused ones install, serve, run code, nest a session or act on a run; a new command must land in one.
export const OPERATOR_CLI_COMMANDS = Object.freeze({
  allowed: Object.freeze(["queue", "issues", "decision", "project", "org", "connection", "doctor", "memory", "libs", "version"]),
  refused: Object.freeze(["setup", "init", "open", "update", "mcp", "studio", "hook", "reflect", "embed", "verify", "sandbox", "run"]),
});

// The subcommands of the allowed families that write files or widen the operator's own scope, refused one by one; a new subcommand
// of one of these families must land in one list.
export const OPERATOR_SUBCOMMANDS = Object.freeze({
  queue: Object.freeze({
    allowed: Object.freeze(["add", "status", "run", "cancel", "close", "retry", "repair", "pause", "resume", "log"]),
    refused: Object.freeze(["session"]),
  }),
  decision: Object.freeze({ allowed: Object.freeze(["list", "show", "update"]), refused: Object.freeze(["export", "import"]) }),
  project: Object.freeze({
    allowed: Object.freeze(["list", "rename", "key", "remove", "integrations"]),
    refused: Object.freeze(["add", "move"]),
  }),
});

// The flags refused on an otherwise allowed command: `queue add --run` starts the runner, `doctor --fix` writes.
export const OPERATOR_REFUSED_FLAGS = Object.freeze([
  Object.freeze({ argv: Object.freeze(["queue", "add"]), flags: Object.freeze(["--run"]) }),
  Object.freeze({ argv: Object.freeze(["doctor"]), flags: Object.freeze(["--fix"]) }),
]);

const ANY_SUBCOMMAND = "*";

// The nightqueue commands a read-only subagent (triage, reviewer) may run, each with the subcommands that only read.
export const READONLY_SUBAGENT_COMMANDS = new Map([
  ["queue", Object.freeze(["status", "log"])],
  ["issues", ANY_SUBCOMMAND],
  ["project", Object.freeze(["list"])],
  ["decision", Object.freeze(["list", "show"])],
  ["org", Object.freeze(["list"])],
  ["connection", Object.freeze(["list"])],
  ["memory", Object.freeze(["stats"])],
  ["doctor", ANY_SUBCOMMAND],
  ["version", ANY_SUBCOMMAND],
]);

export const OPERATOR_ROLES = Object.freeze(["triage", "qa", "reviewer"]);

const PLUGIN_NAME = "nightqueue";
const NIGHTQUEUE_PROGRAMS = new Set([SHIM_NAME, ...SHORTCUT_SHIM_NAMES]);
const BLOCKING_FLAGS = ["--follow", "--foreground"];
const SCRIPT_EXTENSION = /\.m?js$/;
const QA_GIT_REFUSED = new Set(["push", "remote", "config"]);
const GIT_VALUE_OPTIONS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path"]);
const QA_WORD_SEPARATORS = /[\s;&|()<>]+/;
const GIT_READ_SUBCOMMANDS = new Set(["log", "show", "diff", "blame", "ls-tree", "ls-files", "rev-parse", "branch", "status"]);
const GIT_DENIED_FLAGS = ["--output", "--ext-diff", "--no-index", "--exec"];
const BRANCH_DENIED_FLAGS = [
  "-d", "-D", "-m", "-M", "-c", "-C", "--delete", "--move", "--copy", "-u", "--set-upstream-to", "--unset-upstream",
  "--edit-description", "-f", "--force",
];
const GH_READS = new Map([
  ["pr", ["view", "diff", "checks", "list", "status"]],
  ["issue", ["view", "list"]],
]);
const QA_ANCHOR = /^cd\s+("[^"]*"|'[^']*'|[^\s"'&;|]+)\s*&&\s*(\S[\s\S]*)$/;
const QA_RAW_ESCAPES = [/\\/, /\$['"]/];
const QA_ESCAPES = [
  /[\n\r`]/,
  /\$[A-Za-z_({]/,
  /(^|[\s=<>(){}|&;,:])~/,
  /(^|[\s;&|(){}])(cd|pushd|popd)(?=$|[\s;&|()])/,
  /(^|[\s/=<>(){}|&;,:])\.\.(?=$|[\s/<>(){}|&;,:])/,
  /(^|[\s/=<>(){}|&;,:])(\.[^\s/]*[*?[]|\[)/,
  /[{}]\.|\.[{},]/,
];
const ABSOLUTE_PATH = /(?:^|[\s=<>(){}|&;,])(\/[^\s<>|&;(){},]*)/g;
const OPTION_ABSOLUTE_PATH = /(?:^|\s)-[A-Za-z]+(\/[^\s<>|&;(){},]*)/g;
const NULL_DEVICE = "/dev/null";

// The role of a subagent type the operator may delegate to, under any of the spellings the host gives a plugin agent, or null.
export function agentRole(agentType) {
  const type = typeof agentType === "string" ? agentType.trim() : "";
  const spellings = (role) => [role, `${PLUGIN_NAME}:${role}`, `plugin_${PLUGIN_NAME}_${role}`];
  return OPERATOR_ROLES.find((role) => spellings(role).includes(type)) ?? null;
}

// The canonical checkout of every registered project, with the registry's error message when it could not be read.
export function checkoutRoots(env = process.env) {
  try {
    return { roots: registeredCheckouts(env).map((project) => canonicalPath(project.path)), error: null };
  } catch (err) {
    return { roots: [], error: err?.message ?? String(err) };
  }
}

// Directories the operator and its subagents may read: the registered checkouts, the qa worktrees, the runs, the jobs' worktrees, the plugin and its own spilled tool results.
export function operatorReadRoots(env = process.env, session = {}) {
  const { roots: checkouts, error } = checkoutRoots(env);
  const candidates = [...checkouts, qaDir(env), runsDir(env), worktreesDir(env), ...pluginRoots(env), sessionSpillRoot(session)];
  return { roots: [...new Set(candidates.filter(Boolean).map(canonicalPath))], registryError: error };
}

// Tells whether a token asks a nightqueue command to hold the shell (a follow or a foreground run).
function isBlockingFlag(token) {
  return BLOCKING_FLAGS.some((flag) => token === flag || token.startsWith(`${flag}=`));
}

// Tells whether the tokens carry a flag refused on the command they spell (`queue add --run`, `doctor --fix`).
function refusedFlagUsed(tokens) {
  const rule = OPERATOR_REFUSED_FLAGS.find(({ argv }) => argv.every((word, index) => tokens[index + 1] === word));
  if (!rule) return false;
  return tokens.some((token) => rule.flags.some((flag) => token === flag || token.startsWith(`${flag}=`)));
}

// The subcommands the main thread may run under an allowed command: the classified ones of a family, else any; undefined when the command is refused.
function mainSubcommands(command) {
  if (!OPERATOR_CLI_COMMANDS.allowed.includes(command)) return undefined;
  return Object.hasOwn(OPERATOR_SUBCOMMANDS, command) ? OPERATOR_SUBCOMMANDS[command].allowed : ANY_SUBCOMMAND;
}

// The subcommands a read-only subagent may run under a command; undefined when the command is refused.
function readonlySubcommands(command) {
  return READONLY_SUBAGENT_COMMANDS.get(command);
}

// Tells whether the tokens are an allowed nightqueue command for a list: an allowed command and subcommand, no blocking or refused flag.
function nightqueueAllowed(tokens, subcommandsOf) {
  const [program, command, subcommand] = tokens;
  if (!NIGHTQUEUE_PROGRAMS.has(program)) return false;
  const subcommands = subcommandsOf(command);
  if (subcommands === undefined) return false;
  if (subcommands !== ANY_SUBCOMMAND && !subcommands.includes(subcommand)) return false;
  return !tokens.some(isBlockingFlag) && !refusedFlagUsed(tokens);
}

// Tells whether a git argument is one that writes a file or runs a program (`--output*`, `--ext-diff`, `--no-index`, `--exec`).
function isDeniedGitArg(token) {
  return GIT_DENIED_FLAGS.some((flag) => token.startsWith(flag) || isDeniedFlag(token, flag));
}

// Tells whether `git branch` arguments only list: `--list` present and no flag that deletes, moves, copies or retargets.
function branchListOnly(args) {
  if (!args.includes("--list")) return false;
  return !args.some((token) => BRANCH_DENIED_FLAGS.some((flag) => isDeniedFlag(token, flag)));
}

// Tells whether the tokens are a read-only git command on a registered checkout: `git -C <checkout> [--no-optional-locks] <read> …`.
function gitReadAllowed(tokens, checkouts) {
  const [program, option, dir, ...rest] = tokens;
  if (program !== "git" || option !== "-C" || typeof dir !== "string" || !isAbsolute(dir)) return false;
  if (!insideRoots(dir, checkouts)) return false;
  const noLocks = rest[0] === "--no-optional-locks";
  const [subcommand, ...args] = noLocks ? rest.slice(1) : rest;
  if (!GIT_READ_SUBCOMMANDS.has(subcommand) || args.some(isDeniedGitArg)) return false;
  if (subcommand === "status") return noLocks;
  if (subcommand === "branch") return branchListOnly(args);
  return true;
}

// The tokens of a single bare command, or null when it carries a shell operator or a backslash, or is not a string.
function bareTokens(command) {
  if (typeof command !== "string" || FORBIDDEN_SHELL_CHARS.test(command) || command.includes("\\")) return null;
  return tokenize(command.trim());
}

// Tells whether `gh` arguments are one of its read-only subcommands.
function ghReadAllowed(args) {
  return GH_READS.get(args[0])?.includes(args[1]) === true;
}

// Tells whether a Bash command is one the operator's main thread may run under D-58.
export function mainBashAllowed(command, checkouts = []) {
  const tokens = bareTokens(command);
  return tokens !== null && (nightqueueAllowed(tokens, mainSubcommands) || gitReadAllowed(tokens, checkouts));
}

// Tells whether a Bash command is one a read-only subagent (triage, reviewer) may run: nightqueue reads, git reads of a checkout, gh reads.
export function readonlySubagentBashAllowed(command, checkouts = []) {
  const tokens = bareTokens(command);
  if (tokens === null) return false;
  if (tokens[0] === "gh") return ghReadAllowed(tokens.slice(1));
  return nightqueueAllowed(tokens, readonlySubcommands) || gitReadAllowed(tokens, checkouts);
}

// The canonical root `<qa>/<project id>/<id>` of the qa worktree an absolute path lies in, or null when it lies in none.
export function qaWorktreeOf(path, env = process.env) {
  if (typeof path !== "string" || !isAbsolute(path)) return null;
  const root = canonicalPath(qaDir(env));
  const rest = relative(root, canonicalPath(path));
  if (rest === "" || isAbsolute(rest)) return null;
  const [projectId, id] = rest.split(sep);
  return isId(projectId) && isId(id) ? join(root, projectId, id) : null;
}

// Tells whether a path lies inside a qa worktree of this home, the only place the qa subagent writes.
export function qaPathAllowed(path, env = process.env) {
  return qaWorktreeOf(path, env) !== null;
}

// Tells whether a command is the bare `nightqueue sandbox worktree <project>` or `… --drop <qa worktree>`.
function sandboxWorktreeCommand(command, env) {
  const tokens = bareTokens(command);
  if (tokens === null) return false;
  const [program, sandbox, worktree, ...rest] = tokens;
  if (!NIGHTQUEUE_PROGRAMS.has(program) || sandbox !== "sandbox" || worktree !== "worktree") return false;
  if (rest.length === 1) return !rest[0].startsWith("-");
  return rest.length === 2 && rest[0] === "--drop" && qaPathAllowed(rest[1], env);
}

// Every absolute path a quote-stripped command names, an option glued to one (`-C/etc`) included.
function absolutePaths(plain) {
  return [...plain.matchAll(ABSOLUTE_PATH), ...plain.matchAll(OPTION_ABSOLUTE_PATH)].map((match) => match[1]);
}

// Tells whether a command text stays in one worktree: no escape construct, and every absolute path inside it or the null device.
function staysInside(text, worktree) {
  if (QA_RAW_ESCAPES.some((pattern) => pattern.test(text))) return false;
  const plain = text.replace(/["']/g, "");
  if (QA_ESCAPES.some((pattern) => pattern.test(plain))) return false;
  return absolutePaths(plain).every((path) => path === NULL_DEVICE || insideRoots(path, [worktree]));
}

// The program a word names, its directory and a script extension dropped (`bin/nightqueue.mjs` names nightqueue).
function programName(word) {
  return basename(word).replace(SCRIPT_EXTENSION, "");
}

// The git subcommand among the arguments after `git`, its global options and their values skipped.
function gitSubcommand(args) {
  for (let index = 0; index < args.length; index += 1) {
    if (GIT_VALUE_OPTIONS.has(args[index])) index += 1;
    else if (!args[index].startsWith("-")) return args[index];
  }
  return null;
}

// Tells whether the word at an index is a nightqueue program run inside `nightqueue sandbox`, against its throwaway home.
function insideSandbox(words, index) {
  return words[index - 1] === "sandbox" && NIGHTQUEUE_PROGRAMS.has(programName(words[index - 2] ?? ""));
}

// Tells whether the qa subagent may run the program a word names: nightqueue only through `sandbox`, gh only to read, git never to push or reconfigure.
function qaProgramAllowed(words, index) {
  const program = programName(words[index]);
  const rest = words.slice(index + 1);
  if (NIGHTQUEUE_PROGRAMS.has(program)) return rest[0] === "sandbox" || insideSandbox(words, index);
  if (program === "gh") return ghReadAllowed(rest);
  if (program === "git") return !QA_GIT_REFUSED.has(gitSubcommand(rest));
  return true;
}

// Tells whether every program a quote-stripped command names, in any segment of its chain, is one the qa subagent may run.
function qaProgramsAllowed(text) {
  const words = text.replace(/["']/g, "").split(QA_WORD_SEPARATORS).filter(Boolean);
  return words.every((_, index) => qaProgramAllowed(words, index));
}

// Tells whether a command is `cd <qa worktree path> && …` with nothing that leaves that worktree.
function anchoredCommand(command, env) {
  const match = QA_ANCHOR.exec(command);
  if (!match) return false;
  const anchor = match[1].replace(/^(["'])(.*)\1$/, "$2");
  const worktree = qaWorktreeOf(anchor, env);
  return worktree !== null && staysInside(`${match[1]} ${match[2]}`, worktree) && qaProgramsAllowed(match[2]);
}

// Tells whether a Bash command is one the qa subagent may run: anchored in its qa worktree, or the bare sandbox worktree command.
export function qaBashAllowed(command, env = process.env) {
  if (typeof command !== "string") return false;
  const trimmed = command.trim();
  return sandboxWorktreeCommand(trimmed, env) || anchoredCommand(trimmed, env);
}

// The qa worktree pattern as a reason shows it, with this home's qa directory.
function qaShown(env) {
  return `${qaDir(env)}/<project_id>/<id>`;
}

// The note a reason carries when the registry could not be read, so no checkout is in scope.
function registryNote(error) {
  return error ? `; the registry could not be read (${error}), so no checkout is in scope: run \`nightqueue doctor\`` : "";
}

// Reason of a main-thread edit: the operator never edits.
export function describeMainWriteDenial(toolName) {
  return (
    `${OPERATOR_DECISION}: the operator never edits - ${toolName} is refused on its main thread; ` +
    "queue the change with queue_add after the person's go, or hand a reproduction to nightqueue:qa"
  );
}

// Reason of a main-thread read outside the operator's roots.
export function describeReadDenial({ target, roots, registryError }) {
  const shown = target ?? "a path that cannot be resolved";
  return (
    `${OPERATOR_DECISION}: the operator and its subagents read only the registered checkouts, the qa worktrees, the runs, the jobs' worktrees ` +
    `and the plugin (${roots.join(", ")}), and ${shown} is outside them; pass an absolute \`path\` inside one of them, ` +
    `or hand the search to nightqueue:triage${registryNote(registryError)}`
  );
}

// The refused subcommands and flags of the main thread, as a reason shows them (`queue session`, `doctor --fix`, …).
function describeMainRefusals() {
  const subcommands = Object.entries(OPERATOR_SUBCOMMANDS).flatMap(([command, { refused }]) => refused.map((subcommand) => `${command} ${subcommand}`));
  const flags = OPERATOR_REFUSED_FLAGS.flatMap(({ argv, flags: refused }) => refused.map((flag) => `${argv.join(" ")} ${flag}`));
  return [...subcommands, ...flags].map((shown) => `\`${shown}\``).join(", ");
}

// The nightqueue reads of a read-only subagent, as a reason shows them (`queue status|log`, `issues …`, …).
function describeReadonlyCommands() {
  return [...READONLY_SUBAGENT_COMMANDS]
    .map(([command, subcommands]) => (subcommands === ANY_SUBCOMMAND ? command : `${command} ${subcommands.join("|")}`))
    .join(", ");
}

// Reason of a main-thread Bash command outside the operator's list.
export function describeMainBashDenial(registryError = null) {
  return (
    `${OPERATOR_DECISION}: the operator runs only \`nightqueue|nq ${OPERATOR_CLI_COMMANDS.allowed.join("|")} …\` ` +
    `(never ${describeMainRefusals()}, \`--follow\` or \`--foreground\`) and ` +
    "`git -C <registered checkout> [--no-optional-locks] log|show|diff|blame|ls-tree|ls-files|rev-parse|branch --list|status` " +
    "(status only after --no-optional-locks; never --output, --ext-diff, --no-index or --exec), " +
    `each one bare command with no shell operator or backslash; hand anything else to nightqueue:triage or nightqueue:qa${registryNote(registryError)}`
  );
}

// Reason of a main-thread subagent launch of a type the operator does not delegate to.
export function describeAgentDenial(subagentType) {
  const shown = typeof subagentType === "string" && subagentType.trim() ? subagentType : "a subagent with no type";
  return `${OPERATOR_DECISION}: the operator delegates only to nightqueue:triage, nightqueue:qa and nightqueue:reviewer; ${shown} is refused`;
}

// Reason of an edit by a subagent other than qa.
export function describeSubagentWriteDenial(agentType) {
  const shown = typeof agentType === "string" && agentType.trim() ? agentType : "this";
  return `${OPERATOR_DECISION}: the ${shown} subagent never edits; only nightqueue:qa writes, inside its qa worktree`;
}

// Reason of a read-only subagent's Bash command outside its list.
export function describeReadonlySubagentBashDenial(agentType, registryError = null) {
  const shown = typeof agentType === "string" && agentType.trim() ? agentType : "this";
  return (
    `${OPERATOR_DECISION}: the ${shown} subagent runs only read-only commands: \`nightqueue|nq ${describeReadonlyCommands()}\` ` +
    "(never `doctor --fix`, `--follow` or `--foreground`), the operator's `git -C <registered checkout>` reads, " +
    "`gh pr view|diff|checks|list|status` and `gh issue view|list`, " +
    `each one bare command with no shell operator or backslash${registryNote(registryError)}`
  );
}

// Reason of a qa subagent edit outside its qa worktree.
export function describeQaWriteDenial(path, env = process.env) {
  const shown = typeof path === "string" && path ? path : "a path that cannot be resolved";
  return `${OPERATOR_DECISION}: the qa subagent writes only inside its qa worktree (${qaShown(env)}), and ${shown} is outside it`;
}

// Reason of a qa subagent Bash command outside its anchor.
export function describeQaBashDenial(env = process.env) {
  return (
    `${OPERATOR_DECISION}: the qa subagent runs every command as \`cd <qa worktree> && …\` (${qaShown(env)}), with no cd/pushd/popd after it, ` +
    "no `..`, no `$(…)`, `$'…'`, backtick, backslash or variable, no `~`, no glob or brace next to a dot, " +
    "and no absolute path outside that worktree but /dev/null (`-C/x` included); after it nightqueue runs only as `nightqueue sandbox <command>`, " +
    "gh only as `gh pr view|diff|checks|list|status` or `gh issue view|list`, and git never as push, remote or config; " +
    "only `nightqueue sandbox worktree <project>` and `nightqueue sandbox worktree --drop <path>` run bare"
  );
}
