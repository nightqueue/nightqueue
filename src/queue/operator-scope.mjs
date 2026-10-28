import { basename, isAbsolute } from "node:path";
import { SHIM_NAME, SHORTCUT_SHIM_NAMES, secretsPath } from "../config/paths.mjs";
import { registeredCheckouts } from "../memory/registry-access.mjs";
import {
  FORBIDDEN_SHELL_CHARS,
  canonicalPath,
  hasControlChar,
  hasUnquotedCaret,
  hasUnquotedForeignBlank,
  hasUnquotedHash,
  hasUnquotedParen,
  insideRoots,
  isDeniedFlag,
  maskQuoted,
  tokenize,
} from "./orchestrator-scope.mjs";

export { hasControlChar, hasUnquotedCaret, hasUnquotedForeignBlank, hasUnquotedHash, hasUnquotedParen };

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
export const GIT_READ_SUBCOMMANDS = new Set(["log", "show", "diff", "blame", "ls-tree", "ls-files", "rev-parse", "branch", "status", "grep"]);
const GREP_LONG_FLAGS = new Set([
  "--cached", "--exclude-standard", "--text", "--no-textconv", "--ignore-case", "--recursive", "--no-recursive", "--word-regexp",
  "--invert-match", "--full-name", "--extended-regexp", "--basic-regexp", "--perl-regexp", "--fixed-strings", "--line-number",
  "--column", "--files-with-matches", "--name-only", "--files-without-match", "--null", "--only-matching", "--count", "--no-color",
  "--break", "--heading", "--show-function", "--function-context", "--and", "--or", "--not", "--all-match", "--quiet",
]);
const GREP_LONG_VALUES = new Set(["--max-depth", "--context", "--after-context", "--before-context", "--max-count", "--threads"]);
const GREP_COLOR = /^--color=(never|always|auto)$/;
const GREP_SHORT_FLAGS = new Set("aiIwvhHEGFPnlLoczpWq0123456789");
const GREP_SHORT_VALUES = new Set("eABCm");
const ANY_VALUE_LETTER = "e";
const INTEGER = /^-?\d+$/;
const OPTIONS_END = "--";
const EXPANSION_CHARS = /[*?[\]{}]/;
const EXTENDED_GLOB_NEGATION = "^";
const GREP_FREE_RULES =
  "`git -C <registered checkout> -c core.fsmonitor=false -c core.hooksPath=/dev/null --no-lazy-fetch grep [--cached] <options> <pattern> -- [<paths>] ':(top,exclude,glob)**/.env*'` " +
  "(only this spelling, `--no-lazy-fetch` and the `.env*` exclusion pathspec required; the working tree or `--cached` only, never a revision (history: `git log -S<text>`, `git show <rev>`); full option names; " +
  "globs, braces and parentheses quoted, as `-- 'src/*.mjs'` and `'('`; no `|`, OR is `-e a -e b`; never -O, -f, --textconv, --no-index or --untracked); " +
  "quote every `* ? [ ] { }`, as `git show 'HEAD@{1}'` (left bare, one takes a command off the free list) and every `( )` or `#` (left bare, one is refused outright)";
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
const GIT_HARDENING_ORDER = Object.freeze(["core.fsmonitor=false", "core.hooksPath=/dev/null"]);
const GIT_HARDENING_VALUES = new Set(GIT_HARDENING_ORDER);
const GIT_SAFE_GLOBALS = new Set(["--no-optional-locks", "--no-pager"]);
export const NO_LAZY_FETCH = "--no-lazy-fetch";
export const GREP_READ_GLOBALS = Object.freeze([...GIT_READ_HARDENING, NO_LAZY_FETCH]);
export const DOTENV_EXCLUDE_PATHSPEC = ":(top,exclude,glob)**/.env*";
export const GREP_HARDENED_SPELLING =
  `${grepDirSpelling("<checkout>")} (or \`cd <checkout> && git -c core.fsmonitor=false -c core.hooksPath=/dev/null --no-lazy-fetch grep … -- ':(top,exclude,glob)**/.env*'\`)`;
const GREP_UNHARDENED =
  `\`git grep\` runs only hardened and with no lazy fetch from a promisor remote, so no program planted in the shared \`.git/config\` runs: ${GREP_HARDENED_SPELLING}`;
const GREP_UNEXCLUDED =
  `\`git grep\` always ends with \`-- … ':(top,exclude,glob)**/.env*'\`, so no tracked \`.env*\` file the Read rule refuses is printed: ${GREP_HARDENED_SPELLING}`;
const GREP_OUTSIDE_TRACKED = ["--no-index", "--untracked", "--no-exclude-standard"];
const GREP_REFUSALS = Object.freeze([
  { refuses: (word) => shortClusterHas(word, "O") || word.startsWith("--open-files-in-pager"), reason: "`git grep` opening files in a pager (`-O`, `--open-files-in-pager`) runs a program" },
  { refuses: (word) => word.startsWith("--te"), reason: "`git grep --textconv` runs the textconv filters a repository configures" },
  { refuses: (word) => shortClusterHas(word, "f"), reason: "`git grep -f` reads its patterns from a file" },
  { refuses: (word) => GREP_OUTSIDE_TRACKED.some((flag) => isDeniedFlag(word, flag)), reason: "`git grep --no-index|--untracked|--no-exclude-standard` searches outside the tracked files" },
  { refuses: (word) => isDeniedFlag(word, "--ext-grep"), reason: "`git grep --ext-grep` hands the search to an external program" },
  { refuses: isSubmoduleArg, reason: "`git grep` into submodules reads repositories no guard judged" },
]);
const PAREN_OPERATORS = new Set(["(", ")"]);
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
  if (option === NO_LAZY_FETCH) return { width: 1, noLazyFetch: true };
  return null;
}

// Tells whether the hardening values of git's global options are both pairs, once each, in the hardened spelling's order.
function hardeningInOrder(values) {
  return values.length === GIT_HARDENING_ORDER.length && GIT_HARDENING_ORDER.every((value, index) => values[index] === value);
}

// git's global options read against the allowlist: the last `-C` dir, whether the hardening pairs (in order, once each) and `--no-optional-locks` are there, the subcommand's index, and the first refused option (null when none; `--no-lazy-fetch` is refused on every subcommand but grep).
export function gitGlobals(args) {
  const list = Array.isArray(args) ? args : [];
  const found = { dir: null, noLocks: false, noLazyFetch: false, hardening: [] };
  let index = 0;
  let refused = null;
  while (index < list.length && list[index].startsWith("-")) {
    const step = gitGlobalStep(list[index], list[index + 1]);
    if (step === null) {
      refused = list[index];
      break;
    }
    if (step.dir !== undefined) found.dir = step.dir;
    if (step.hardening) found.hardening.push(step.hardening);
    found.noLocks = found.noLocks || step.noLocks === true;
    found.noLazyFetch = found.noLazyFetch || step.noLazyFetch === true;
    index += step.width;
  }
  if (refused === null && found.noLazyFetch && list[index] !== "grep") refused = NO_LAZY_FETCH;
  return { dir: found.dir, noLocks: found.noLocks, hardened: hardeningInOrder(found.hardening), index, refused };
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

// Tells whether the tokens are a read-only git command on a registered checkout: `git -C <checkout> [<read hardening>] [--no-optional-locks] <read> …`, or the one hardened grep spelling.
export function gitReadAllowed(tokens, checkouts) {
  const [program, option, dir, ...after] = tokens;
  if (program !== "git" || option !== "-C" || typeof dir !== "string" || !isAbsolute(dir)) return false;
  if (!insideRoots(dir, checkouts)) return false;
  const globals = gitGlobals(after);
  if (globals.refused === null && after[globals.index] === "grep") return grepReadAllowed(after);
  const rest = opensWithHardening(after) ? after.slice(GIT_READ_HARDENING.length) : after;
  const noLocks = rest[0] === "--no-optional-locks";
  const [subcommand, ...args] = noLocks ? rest.slice(1) : rest;
  if (!GIT_READ_SUBCOMMANDS.has(subcommand) || args.some(isDeniedGitArg)) return false;
  if (subcommand === "status") return noLocks;
  if (subcommand === "branch") return branchListOnly(args);
  if (subcommand === "grep") return grepReadAllowed(after);
  return true;
}

// Tells whether a git grep past `-C <dir>` is the one free spelling `grepSpellingNever` accepts.
function grepReadAllowed(after) {
  return grepSpellingNever(after) === null;
}

// Tells whether a word is a short option cluster (`-nO`) carrying a letter.
function shortClusterHas(word, letter) {
  return word.startsWith("-") && !word.startsWith("--") && word.includes(letter);
}

// The never reason of a git grep option off the allow list: the named hazard it opens, else the allow list itself.
function grepOptionNever(word) {
  const named = GREP_REFUSALS.find(({ refuses }) => refuses(word));
  return `${named?.reason ?? "an option off the git grep allow list; spell every option by its full name"} (\`${word}\`)`;
}

// The never reason of a git grep global option but `-C <dir>`, the hardening pair and `--no-lazy-fetch`.
function grepGlobalNever(word) {
  return `\`git grep\` takes no global option but \`-C <dir>\`, the hardening pair and \`${NO_LAZY_FETCH}\` (\`${word}\`); run it as ${GREP_HARDENED_SPELLING}`;
}

// The one free spelling of a hardened git grep in a directory given by `-C`, shown with the label of that directory.
export function grepDirSpelling(label) {
  return `\`git -C ${label} -c core.fsmonitor=false -c core.hooksPath=/dev/null --no-lazy-fetch grep [--cached] <options> <pattern> -- [<paths>] ':(top,exclude,glob)**/.env*'\``;
}

// The never reason of a git grep given a revision or a path before `--`.
function grepRevisionNever(word) {
  return `\`git grep\` searches only the working tree or the index (\`--cached\`), never a revision: a ref, \`HEAD\`, \`HEAD~n\`, \`'HEAD@{n}'\`, an object id or \`<rev>:<path>\` can name a blob no pathspec filters, and paths go after \`--\`; search history with \`git -C <dir> log -S<text>\` or read a commit with \`git -C <dir> show <rev>\` (\`${word}\`)`;
}

// The global words of a git grep that are neither a hardening `-c` pair nor `--no-lazy-fetch` (`--no-pager`, a second `-C`).
function grepExtraGlobals(globals) {
  return globals.filter((word, index) => word !== "-c" && globals[index - 1] !== "-c" && word !== NO_LAZY_FETCH);
}

// Tells whether two word lists are the same words in the same order.
function sameWords(words, expected) {
  return words.length === expected.length && expected.every((word, index) => words[index] === word);
}

// Tells whether a short git grep option cluster gives the pattern (`-e foo`, `-ne foo`).
function givesPattern(word) {
  if (!shortClusterHas(word, "e")) return false;
  return [...word.slice(1)].find((letter) => GREP_SHORT_VALUES.has(letter)) === ANY_VALUE_LETTER;
}

// Tells whether git grep still parses a word as an option: a dash word or a paren operator.
function isGrepOptionWord(word) {
  return typeof word === "string" && (word.startsWith("-") || PAREN_OPERATORS.has(word));
}

// The positional words of git grep arguments before the real `--` (revisions or misplaced paths), the pattern dropped when no `-e` gave it; any one makes the grep never.
export function grepRevisions(args) {
  const list = Array.isArray(args) ? args : [];
  const { terminator } = grepArgs(list);
  const end = terminator === -1 ? list.length : terminator;
  let index = 0;
  let patternGiven = false;
  while (index < end && isGrepOptionWord(list[index])) {
    patternGiven = patternGiven || givesPattern(list[index]);
    index += Math.max(1, grepWordWidth(list[index], list[index + 1]));
  }
  const positional = list.slice(index, end);
  return patternGiven ? positional : positional.slice(1);
}

// Why the words of a git grep past `-C <dir>` (or past `git` in the cd form) are not the one free spelling, or null when they are.
export function grepSpellingNever(afterDir) {
  const words = Array.isArray(afterDir) ? afterDir : [];
  const { index, refused } = gitGlobals(words);
  if (refused !== null || words[index] !== "grep") return grepGlobalNever(refused ?? words[index] ?? "no grep subcommand");
  const globals = words.slice(0, index);
  const [extra] = grepExtraGlobals(globals);
  if (extra !== undefined) return grepGlobalNever(extra);
  if (!sameWords(globals, GREP_READ_GLOBALS)) return GREP_UNHARDENED;
  const args = words.slice(index + 1);
  const { refused: option, terminator } = grepArgs(args);
  if (option !== null) return grepOptionNever(option);
  const [revision] = grepRevisions(args);
  if (revision !== undefined) return grepRevisionNever(revision);
  const excluded = terminator !== -1 && args.slice(terminator + 1).includes(DOTENV_EXCLUDE_PATHSPEC);
  return excluded ? null : GREP_UNEXCLUDED;
}

// How many words a short value letter of git grep takes (its glued value, else the next word), 0 when `-A|-B|-C|-m` get no integer.
function shortValueWidth(letter, glued, next) {
  const value = glued !== "" ? glued : next;
  if (typeof value !== "string") return 0;
  if (letter !== ANY_VALUE_LETTER && !INTEGER.test(value)) return 0;
  return glued !== "" ? 1 : 2;
}

// How many words one short git grep option cluster takes (`-nC3`, `-e foo`), 0 when a letter or its value is off the allow list.
function grepShortWidth(word, next) {
  for (let index = 1; index < word.length; index += 1) {
    const letter = word[index];
    if (GREP_SHORT_VALUES.has(letter)) return shortValueWidth(letter, word.slice(index + 1), next);
    if (!GREP_SHORT_FLAGS.has(letter)) return 0;
  }
  return word.length > 1 ? 1 : 0;
}

// How many words one long git grep option takes (`--context 3`, `--context=3`), 0 when its exact name or its value is off the allow list.
function grepLongWidth(word, next) {
  if (GREP_LONG_FLAGS.has(word) || GREP_COLOR.test(word)) return 1;
  const equals = word.indexOf("=");
  const name = equals === -1 ? word : word.slice(0, equals);
  if (!GREP_LONG_VALUES.has(name)) return 0;
  if (equals !== -1) return INTEGER.test(word.slice(equals + 1)) ? 1 : 0;
  return INTEGER.test(next ?? "") ? 2 : 0;
}

// How many words one git grep argument takes: 1 for a pattern, revision or paren operator, an option's own width, 0 when refused.
function grepWordWidth(word, next) {
  if (typeof word !== "string") return 0;
  if (!word.startsWith("-")) return 1;
  return word.startsWith(OPTIONS_END) ? grepLongWidth(word, next) : grepShortWidth(word, next);
}

// git grep arguments read against the exact-name allow list: the first refused word (null when none) and the index of the real `--` (-1 when none).
export function grepArgs(args) {
  const list = Array.isArray(args) ? args : [];
  let index = 0;
  while (index < list.length) {
    if (list[index] === OPTIONS_END) return { refused: null, terminator: index };
    const width = grepWordWidth(list[index], list[index + 1]);
    if (width === 0) return { refused: list[index], terminator: -1 };
    index += width;
  }
  return { refused: null, terminator: -1 };
}

// The index of `grep` in git words (`git [<global options>] grep …`), or -1 when the words are no git grep.
export function gitGrepIndex(words) {
  if (!Array.isArray(words) || programName(words[0]) !== "git") return -1;
  const { index, refused } = gitGlobals(words.slice(1));
  return refused === null && words[1 + index] === "grep" ? 1 + index : -1;
}

// The end of the words zsh expansion is judged on: the words before the real `--` of a git grep, else every word.
export function expansionJudgedEnd(words) {
  const list = Array.isArray(words) ? words : [];
  const grep = gitGrepIndex(list);
  if (grep === -1) return list.length;
  const { terminator } = grepArgs(list.slice(grep + 1));
  return terminator === -1 ? list.length : grep + 1 + terminator;
}

// For each word of a command, whether zsh expands it: an unquoted `* ? [ ] { }` or a leading `^`; null when the masked words do not align.
export function expansionFlags(command) {
  if (typeof command !== "string") return null;
  const words = tokenize(command);
  const masked = tokenize(maskQuoted(command));
  if (masked.length !== words.length) return null;
  return masked.map((word) => EXPANSION_CHARS.test(word) || word.startsWith(EXTENDED_GLOB_NEGATION));
}

// Tells whether zsh would expand a judged word of a command whose tokens are given, or whether its words cannot be aligned to tell.
export function expandsUnquoted(command, tokens) {
  const flags = expansionFlags(command);
  if (flags === null || !Array.isArray(tokens) || flags.length !== tokens.length) return true;
  return flags.slice(0, expansionJudgedEnd(tokens)).some(Boolean);
}

// The tokens of a single bare command, or null when it carries a shell operator, a backslash, an unquoted paren, `#` or foreign blank, or is not a string.
export function bareTokens(command) {
  if (typeof command !== "string" || FORBIDDEN_SHELL_CHARS.test(command) || command.includes("\\")) return null;
  if (hasUnquotedParen(command) || hasUnquotedHash(command) || hasUnquotedForeignBlank(command)) return null;
  return tokenize(command.trim());
}

// Tells whether `gh` arguments are one of its read-only subcommands.
function ghReadAllowed(args) {
  return GH_READS.get(args[0])?.includes(args[1]) === true;
}

// Tells whether a Bash command is one the operator's main thread may run with no consent.
export function mainBashAllowed(command, checkouts = []) {
  const tokens = bareTokens(command);
  if (tokens === null || expandsUnquoted(command, tokens)) return false;
  return nightqueueAllowed(tokens, mainSubcommands) || gitReadAllowed(tokens, checkouts);
}

// Tells whether a Bash command is one a subagent of the operator may run with no consent: nightqueue reads, git reads of a checkout, gh reads.
export function readonlySubagentBashAllowed(command, checkouts = []) {
  const tokens = bareTokens(command);
  if (tokens === null || expandsUnquoted(command, tokens)) return false;
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
    `(status only after --no-optional-locks; never --output, --ext-diff, --no-index or --exec) and ${GREP_FREE_RULES}`
  );
}

// The free Bash list of a subagent of the operator, as a reason shows it.
export function describeSubagentBashList() {
  return (
    `\`nightqueue|nq ${describeReadonlyCommands()}\` (never \`doctor --fix\`, \`--follow\` or \`--foreground\`), the operator's \`git -C <registered checkout>\` reads, ` +
    `\`gh pr view|diff|checks|list|status\`, \`gh issue view|list\` and ${GREP_FREE_RULES}`
  );
}

// Reason of a main-thread subagent launch of a type the operator does not delegate to.
export function describeAgentDenial(subagentType) {
  const shown = typeof subagentType === "string" && subagentType.trim() ? subagentType : "a subagent with no type";
  const names = PIPELINE_AGENTS.map((name) => `${PLUGIN_NAME}:${name}`).join(", ");
  return `${OPERATOR_GUARD}: the operator delegates only to the pipeline agents (${names}); ${shown} is refused`;
}
