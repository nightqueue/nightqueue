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
    refused: Object.freeze(["add", "move", "demo-repo"]),
  }),
});

// The flags refused on an otherwise allowed command: `queue add --run` starts the runner.
export const OPERATOR_REFUSED_FLAGS = Object.freeze([
  Object.freeze({ argv: Object.freeze(["queue", "add"]), flags: Object.freeze(["--run"]) }),
]);

// The flags that take an otherwise free command off the free list into the consent band: `doctor --fix` writes, as a `run` consent.
export const OPERATOR_CONSENT_FLAGS = Object.freeze([
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
const SCRIPT_EXTENSION = /\.m?js$/;
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
const WRAPPERS = new Set(["sudo", "env", "command", "exec", "nohup", "time", "nice", "builtin", "xargs", "timeout"]);
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const WRAPPER_ARGUMENT = /^(-.*|\d+(\.\d+)?[smhd]?)$/;
const DURATION = /^\d+(\.\d+)?[smhd]?$/;
const WRAPPER_VALUE_OPTIONS = new Map([
  ["sudo", ["-C", "-D", "-g", "-h", "-p", "-R", "-r", "-T", "-t", "-U", "-u", "--close-from", "--chdir", "--group", "--host", "--prompt", "--chroot", "--role", "--command-timeout", "--type", "--other-user", "--user"]],
  ["env", ["-u", "-C", "-P", "-S", "--unset", "--chdir", "--split-string"]],
  ["timeout", ["-s", "-k", "--signal", "--kill-after"]],
  ["nice", ["-n", "--adjustment"]],
  ["xargs", ["-a", "-d", "-E", "-I", "-J", "-L", "-n", "-P", "-R", "-S", "-s", "--arg-file", "--delimiter", "--max-args", "--max-procs", "--max-chars", "--process-slot-var"]],
  ["time", ["-f", "-o", "--format", "--output"]],
  ["exec", ["-a"]],
].map(([wrapper, options]) => [wrapper, new Set(options)]));
const ENV_SPLIT_OPTIONS = new Set(["-S", "--split-string"]);
const NO_VALUE_OPTIONS = new Set();
export const GIT_READ_HARDENING = Object.freeze(["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null"]);
const GIT_HARDENING_VALUES = new Set(["core.fsmonitor=false", "core.hooksPath=/dev/null"]);
const GIT_SAFE_GLOBALS = new Set(["--no-optional-locks", "--no-pager"]);
export const IGNORE_SUBMODULES = "--ignore-submodules=all";
const SUBMODULE_OPTIONS = ["submodule", "recurse-submodules", "ignore-submodules"];
const NEGATION = /^no-/;

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

// Tells whether the tokens carry a flag one of the rules lists on the command they spell (`queue add --run`, `doctor --fix`).
function flagUsed(tokens, rules) {
  const rule = rules.find(({ argv }) => argv.every((word, index) => tokens[index + 1] === word));
  if (!rule) return false;
  return tokens.some((token) => rule.flags.some((flag) => token === flag || token.startsWith(`${flag}=`)));
}

// Tells whether nightqueue tokens (`nightqueue <command> …`) spell a refused subcommand or carry a refused or blocking flag.
export function refusedNightqueueForm(tokens) {
  const [, command, subcommand] = tokens;
  const family = Object.hasOwn(OPERATOR_SUBCOMMANDS, command) ? OPERATOR_SUBCOMMANDS[command] : null;
  if (family?.refused.includes(subcommand)) return true;
  return tokens.some(isBlockingFlag) || flagUsed(tokens, OPERATOR_REFUSED_FLAGS);
}

// The program a word names, its directory and a script extension dropped (`bin/nightqueue.mjs` names nightqueue).
export function programName(word) {
  return typeof word === "string" ? basename(word).replace(SCRIPT_EXTENSION, "") : "";
}

// The value-taking option a wrapper's option word opens (`-u`, `-Eu`, `--user`) and whether its value is attached to it, or null when it takes none.
function valueOption(word, valueOptions) {
  if (word.startsWith("--")) {
    const name = word.split("=")[0];
    return valueOptions.has(name) ? { name, attached: word.includes("=") } : null;
  }
  for (let letter = 1; letter < word.length; letter += 1) {
    const name = `-${word[letter]}`;
    if (valueOptions.has(name)) return { name, attached: letter < word.length - 1 };
  }
  return null;
}

// The index past one wrapper word and the options (with their values), durations and env assignments it takes, and whether one splits a command line no parse can follow (`env -S`).
function wrapperEnd(words, index) {
  const wrapper = programName(words[index]);
  const valueOptions = WRAPPER_VALUE_OPTIONS.get(wrapper) ?? NO_VALUE_OPTIONS;
  let end = index + 1;
  let unparsed = false;
  while (end < words.length && (WRAPPER_ARGUMENT.test(words[end]) || ENV_ASSIGNMENT.test(words[end]))) {
    const option = words[end].startsWith("-") ? valueOption(words[end], valueOptions) : null;
    unparsed = unparsed || (wrapper === "env" && ENV_SPLIT_OPTIONS.has(option?.name));
    end += option && !option.attached ? 2 : 1;
  }
  return { end, unparsed };
}

// Tells whether the words before a program leave it bare: nothing, or only `timeout <n>`.
export function isBarePrefix(prefix) {
  return Array.isArray(prefix) && (prefix.length === 0 || (prefix.length === 2 && prefix[0] === "timeout" && DURATION.test(prefix[1])));
}

// The words of a command after a leading `timeout <n>`, every other wrapper kept.
export function withoutTimeout(words) {
  if (!Array.isArray(words)) return [];
  return words[0] === "timeout" && DURATION.test(words[1] ?? "") ? words.slice(2) : words;
}

// The program of a segment's words past its env assignments and wrappers (`sudo -u root`, `env -C <dir>`, `timeout -s KILL <n>`, …): its index, its words, whether the prefix leaves it bare, and whether a wrapper hides it in a split string (`env -S`).
export function commandPrefix(words) {
  const list = Array.isArray(words) ? words : [];
  let index = 0;
  let unparsed = false;
  while (index < list.length) {
    if (ENV_ASSIGNMENT.test(list[index])) index += 1;
    else if (WRAPPERS.has(programName(list[index]))) {
      const wrapper = wrapperEnd(list, index);
      index = wrapper.end;
      unparsed = unparsed || wrapper.unparsed;
    } else break;
  }
  return { index, bare: isBarePrefix(list.slice(0, index)), program: list.slice(index), unparsed };
}

// What one git global option is on the allowlist (`-C <dir>`, `--no-optional-locks`, `--no-pager`, the read hardening `-c` pairs), or null when it is off it.
function gitGlobalStep(option, value) {
  if (option === "-C") return typeof value === "string" ? { width: 2, dir: value } : null;
  if (option === "-c") return GIT_HARDENING_VALUES.has(value) ? { width: 2, hardening: value } : null;
  if (GIT_SAFE_GLOBALS.has(option)) return { width: 1, noLocks: option === "--no-optional-locks" };
  return null;
}

// git's global options read against the allowlist: the last `-C` dir, whether both hardening pairs and `--no-optional-locks` are there, the subcommand's index, and the first refused option (null when none).
export function gitGlobals(args) {
  const list = Array.isArray(args) ? args : [];
  const found = { dir: null, noLocks: false, hardening: new Set() };
  let index = 0;
  let refused = null;
  while (index < list.length && list[index].startsWith("-")) {
    const step = gitGlobalStep(list[index], list[index + 1]);
    if (step === null) {
      refused = list[index];
      break;
    }
    if (step.dir !== undefined) found.dir = step.dir;
    if (step.hardening) found.hardening.add(step.hardening);
    found.noLocks = found.noLocks || step.noLocks === true;
    index += step.width;
  }
  return { dir: found.dir, noLocks: found.noLocks, hardened: found.hardening.size === GIT_HARDENING_VALUES.size, index, refused };
}

// Tells whether the words spell `doctor --fix` of nightqueue by any spelling of its program (`/abs/bin/nightqueue`, `bin/nightqueue.mjs`).
export function isDoctorFixForm(words) {
  return Array.isArray(words) && NIGHTQUEUE_PROGRAMS.has(programName(words[0])) && flagUsed(words, OPERATOR_CONSENT_FLAGS);
}

// Tells whether the words are the consentable `nightqueue doctor --fix`: the home's own cleanup, its program spelled bare.
export function isDoctorFix(words) {
  return isDoctorFixForm(words) && NIGHTQUEUE_PROGRAMS.has(words[0]);
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
  return !tokens.some(isBlockingFlag) && !flagUsed(tokens, OPERATOR_REFUSED_FLAGS) && !flagUsed(tokens, OPERATOR_CONSENT_FLAGS);
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

// Tells whether words open with the exact read hardening block `-c core.fsmonitor=false -c core.hooksPath=/dev/null`.
export function opensWithHardening(words) {
  return Array.isArray(words) && GIT_READ_HARDENING.every((word, index) => words[index] === word);
}

// Tells whether a git argument steers how submodules are read (`--submodule*`, `--recurse-submodules*`, `--ignore-submodules*`), by any abbreviation or negation git accepts (`--ignore-submod=none`, `--no-recurse-submodules`).
export function isSubmoduleArg(token) {
  if (typeof token !== "string" || !token.startsWith("--")) return false;
  const name = token.slice(2).split("=")[0].replace(NEGATION, "");
  return name !== "" && SUBMODULE_OPTIONS.some((option) => option.startsWith(name));
}

// Tells whether the tokens are a read-only git command on a registered checkout: `git -C <checkout> [<read hardening>] [--no-optional-locks] <read> …`.
export function gitReadAllowed(tokens, checkouts) {
  const [program, option, dir, ...after] = tokens;
  if (program !== "git" || option !== "-C" || typeof dir !== "string" || !isAbsolute(dir)) return false;
  if (!insideRoots(dir, checkouts)) return false;
  const rest = opensWithHardening(after) ? after.slice(GIT_READ_HARDENING.length) : after;
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

// The refused subcommands and flags of the main thread, as a reason shows them (`queue session`, `queue add --run`, …).
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
    `\`nightqueue|nq ${OPERATOR_CLI_COMMANDS.allowed.join("|")} …\` (never ${describeMainRefusals()}, \`--follow\` or \`--foreground\`; ` +
    "`doctor --fix` only after a `run` consent) and " +
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
