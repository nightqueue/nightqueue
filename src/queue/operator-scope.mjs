import { basename, isAbsolute } from "node:path";
import { SHIM_NAME, SHORTCUT_SHIM_NAMES, secretsPath } from "../config/paths.mjs";
import { registeredCheckouts } from "../memory/registry-access.mjs";
import { FORBIDDEN_SHELL_CHARS, canonicalPath, insideRoots, isDeniedFlag, tokenize } from "./orchestrator-scope.mjs";

export const OPERATOR_GUARD = "operator guard";

// Every top-level command of the CLI, classified for the operator's main thread: the allowed ones read or record through the
// registry and the queue, the refused ones install, serve, run code, nest a session or act on a run; a new command must land in one.
export const OPERATOR_CLI_COMMANDS = Object.freeze({
  allowed: Object.freeze(["queue", "project", "org", "connection", "doctor", "memory", "lesson", "libs", "version"]),
  refused: Object.freeze(["setup", "init", "open", "update", "mcp", "studio", "hook", "embed", "verify", "sandbox", "run"]),
});

// The subcommands of the allowed families that write files or widen the operator's own scope, refused one by one; a new subcommand
// of one of these families must land in one list.
export const OPERATOR_SUBCOMMANDS = Object.freeze({
  queue: Object.freeze({
    allowed: Object.freeze(["add", "status", "run", "cancel", "close", "retry", "repair", "pause", "resume", "log"]),
    refused: Object.freeze(["session"]),
  }),
  project: Object.freeze({
    allowed: Object.freeze(["list", "rename", "key", "remove", "integrations", "models"]),
    refused: Object.freeze(["add", "move"]),
  }),
});

// The flags refused on an otherwise allowed command: `queue add --run` starts the runner, `doctor --fix` writes.
export const OPERATOR_REFUSED_FLAGS = Object.freeze([
  Object.freeze({ argv: Object.freeze(["queue", "add"]), flags: Object.freeze(["--run"]) }),
  Object.freeze({ argv: Object.freeze(["doctor"]), flags: Object.freeze(["--fix"]) }),
]);

const ANY_SUBCOMMAND = "*";

// The nightqueue commands a subagent of the operator may run with no consent, each with the subcommands that only read.
export const READONLY_SUBAGENT_COMMANDS = new Map([
  ["queue", Object.freeze(["status", "log"])],
  ["project", Object.freeze(["list"])],
  ["org", Object.freeze(["list"])],
  ["connection", Object.freeze(["list"])],
  ["memory", Object.freeze(["stats"])],
  ["doctor", ANY_SUBCOMMAND],
  ["libs", ANY_SUBCOMMAND],
  ["version", ANY_SUBCOMMAND],
]);

// The plugin agents the operator may launch: every one but the operator itself.
export const PIPELINE_AGENTS = Object.freeze([
  "architect", "coder", "explore", "merger", "qa-guardian", "reflector", "reviewer", "triager", "verifier",
]);

const PLUGIN_NAME = "nightqueue";
export const NIGHTQUEUE_PROGRAMS = new Set([SHIM_NAME, ...SHORTCUT_SHIM_NAMES]);
const BLOCKING_FLAGS = ["--follow", "--foreground"];
export const GIT_READ_SUBCOMMANDS = new Set(["log", "show", "diff", "blame", "ls-tree", "ls-files", "rev-parse", "branch", "status"]);
const GIT_DENIED_FLAGS = ["--output", "--ext-diff", "--no-index", "--exec"];
const BRANCH_DENIED_FLAGS = [
  "-d", "-D", "-m", "-M", "-c", "-C", "--delete", "--move", "--copy", "-u", "--set-upstream-to", "--unset-upstream",
  "--edit-description", "-f", "--force",
];
const GH_READS = new Map([
  ["pr", ["view", "diff", "checks", "list", "status"]],
  ["issue", ["view", "list"]],
]);

// The pipeline agent a subagent type names under a plugin-scoped spelling (`nightqueue:<name>`, `plugin_nightqueue_<name>`), or null.
export function pipelineAgent(agentType) {
  const type = typeof agentType === "string" ? agentType.trim() : "";
  const spellings = (name) => [`${PLUGIN_NAME}:${name}`, `plugin_${PLUGIN_NAME}_${name}`];
  return PIPELINE_AGENTS.find((name) => spellings(name).includes(type)) ?? null;
}

// The canonical checkout of every registered project, with the registry's error message when it could not be read.
export function checkoutRoots(env = process.env) {
  try {
    return { roots: registeredCheckouts(env).map((project) => canonicalPath(project.path)), error: null };
  } catch (err) {
    return { roots: [], error: err?.message ?? String(err) };
  }
}

// The file names the operator never reads wherever they lie: `.env` and its variants (`.env.local`, `.env.production`).
export const DOTENV_NAME = /^\.env(\..+)?$/;

// Why the operator and its subagents may not read a path, or null when they may: everything on disk is readable but the home's
// secrets file and every `.env*` file. A path that cannot be resolved is refused too.
export function readRefusal(target, env = process.env) {
  if (typeof target !== "string" || target === "") return "unresolved";
  const canonical = canonicalPath(target);
  if (canonical === canonicalPath(secretsPath(env))) return "secrets";
  return DOTENV_NAME.test(basename(canonical)) ? "dotenv" : null;
}

// Tells whether a directory a Grep sweeps holds the secrets file below it, so the sweep would read it: the home or any of its parents.
export function sweepsSecrets(target, env = process.env) {
  if (typeof target !== "string" || target === "") return false;
  const secrets = canonicalPath(secretsPath(env));
  return canonicalPath(target) !== secrets && insideRoots(secrets, [canonicalPath(target)]);
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

// Tells whether nightqueue tokens (`nightqueue <command> …`) spell a refused subcommand or carry a refused or blocking flag.
export function refusedNightqueueForm(tokens) {
  const [, command, subcommand] = tokens;
  const family = Object.hasOwn(OPERATOR_SUBCOMMANDS, command) ? OPERATOR_SUBCOMMANDS[command] : null;
  if (family?.refused.includes(subcommand)) return true;
  return tokens.some(isBlockingFlag) || refusedFlagUsed(tokens);
}

// The subcommands the main thread may run under an allowed command: the classified ones of a family, else any; undefined when the command is refused.
function mainSubcommands(command) {
  if (!OPERATOR_CLI_COMMANDS.allowed.includes(command)) return undefined;
  return Object.hasOwn(OPERATOR_SUBCOMMANDS, command) ? OPERATOR_SUBCOMMANDS[command].allowed : ANY_SUBCOMMAND;
}

// The subcommands a subagent may run under a command with no consent; undefined when the command is refused.
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
export function gitReadAllowed(tokens, checkouts) {
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
export function bareTokens(command) {
  if (typeof command !== "string" || FORBIDDEN_SHELL_CHARS.test(command) || command.includes("\\")) return null;
  return tokenize(command.trim());
}

// Tells whether `gh` arguments are one of its read-only subcommands.
function ghReadAllowed(args) {
  return GH_READS.get(args[0])?.includes(args[1]) === true;
}

// Tells whether a Bash command is one the operator's main thread may run with no consent.
export function mainBashAllowed(command, checkouts = []) {
  const tokens = bareTokens(command);
  return tokens !== null && (nightqueueAllowed(tokens, mainSubcommands) || gitReadAllowed(tokens, checkouts));
}

// Tells whether a Bash command is one a subagent of the operator may run with no consent: nightqueue reads, git reads of a checkout, gh reads.
export function readonlySubagentBashAllowed(command, checkouts = []) {
  const tokens = bareTokens(command);
  if (tokens === null) return false;
  if (tokens[0] === "gh") return ghReadAllowed(tokens.slice(1));
  return nightqueueAllowed(tokens, readonlySubcommands) || gitReadAllowed(tokens, checkouts);
}

// The note a reason carries when the registry could not be read, so no checkout is in scope.
export function registryNote(error) {
  return error ? `; the registry could not be read (${error}), so no checkout is in scope: run \`nightqueue doctor\`` : "";
}

// Reason of a read the operator may not make: the secrets file, a `.env*` file, a Grep that would sweep the secrets file, or an unresolvable path.
export function describeReadDenial({ target, refusal, env = process.env }) {
  const shown = typeof target === "string" && target ? target : "a path that cannot be resolved";
  const because = {
    secrets: `${shown} is the home's secrets file (${secretsPath(env)}), which no operator session reads`,
    dotenv: `${shown} is a \`.env\` file, and no operator session reads one`,
    sweep: `a Grep over ${shown} would read the home's secrets file (${secretsPath(env)}) below it; narrow \`path\` to the directory you need`,
    unresolved: `${shown} cannot be resolved; pass an absolute \`path\``,
  }[refusal] ?? `${shown} is refused`;
  return `${OPERATOR_GUARD}: the operator and its subagents read anything on disk but the secrets file and \`.env*\` files, and ${because}`;
}

// The refused subcommands and flags of the main thread, as a reason shows them (`queue session`, `doctor --fix`, …).
function describeMainRefusals() {
  const subcommands = Object.entries(OPERATOR_SUBCOMMANDS).flatMap(([command, { refused }]) => refused.map((subcommand) => `${command} ${subcommand}`));
  const flags = OPERATOR_REFUSED_FLAGS.flatMap(({ argv, flags: refused }) => refused.map((flag) => `${argv.join(" ")} ${flag}`));
  return [...subcommands, ...flags].map((shown) => `\`${shown}\``).join(", ");
}

// The nightqueue reads of a subagent, as a reason shows them (`queue status|log`, `project list`, …).
function describeReadonlyCommands() {
  return [...READONLY_SUBAGENT_COMMANDS]
    .map(([command, subcommands]) => (subcommands === ANY_SUBCOMMAND ? command : `${command} ${subcommands.join("|")}`))
    .join(", ");
}

// The free Bash list of the operator's main thread, as a reason shows it.
export function describeMainBashList() {
  return (
    `\`nightqueue|nq ${OPERATOR_CLI_COMMANDS.allowed.join("|")} …\` (never ${describeMainRefusals()}, \`--follow\` or \`--foreground\`) and ` +
    "`git -C <registered checkout> [--no-optional-locks] log|show|diff|blame|ls-tree|ls-files|rev-parse|branch --list|status` " +
    "(status only after --no-optional-locks; never --output, --ext-diff, --no-index or --exec)"
  );
}

// The free Bash list of a subagent of the operator, as a reason shows it.
export function describeSubagentBashList() {
  return (
    `\`nightqueue|nq ${describeReadonlyCommands()}\` (never \`doctor --fix\`, \`--follow\` or \`--foreground\`), the operator's \`git -C <registered checkout>\` reads, ` +
    "`gh pr view|diff|checks|list|status` and `gh issue view|list`"
  );
}

// Reason of a main-thread subagent launch of a type the operator does not delegate to.
export function describeAgentDenial(subagentType) {
  const shown = typeof subagentType === "string" && subagentType.trim() ? subagentType : "a subagent with no type";
  const names = PIPELINE_AGENTS.map((name) => `${PLUGIN_NAME}:${name}`).join(", ");
  return `${OPERATOR_GUARD}: the operator delegates only to the pipeline agents (${names}); ${shown} is refused`;
}
