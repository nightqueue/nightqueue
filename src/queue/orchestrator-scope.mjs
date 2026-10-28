import { existsSync, lstatSync, readdirSync, readlinkSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { homeDir } from "../config/paths.mjs";
import { claudeConfigDir, claudePluginsDir, hostPackageRoot, packageRoot } from "../host/paths.mjs";

export const PLUGIN_DIR_ENV = "NIGHTQUEUE_PLUGIN_DIR";
const JOB_HOME_ENV = "NIGHTQUEUE_JOB_HOME";
const SPILL_DIR = "tool-results";
const MAX_LINK_HOPS = 40;

// Freezes one rule of a closed list, with its argv.
function freezeRule(rule) {
  return Object.freeze({ ...rule, argv: Object.freeze(rule.argv) });
}

// The closed list of commands the orchestrator of a queued job may run: one frozen row per allowed program and subcommand,
// the subcommand right after the bare program name (so a global flag such as `git -C`/`-c`/`--git-dir` never matches a row).
export const ORCHESTRATOR_BASH_RULES = Object.freeze(
  [
    { argv: ["git", "rev-parse"] },
    { argv: ["git", "worktree"] },
    { argv: ["git", "status"], anyOf: ["--short", "-s", "--porcelain"] },
    { argv: ["git", "add"] },
    { argv: ["git", "commit"], noneOf: ["--amend"] },
    {
      argv: ["git", "push"],
      noneOf: ["--force", "-f", "--force-with-lease", "--force-if-includes", "--delete", "-d", "--mirror", "--all", "--prune", "--receive-pack", "--exec"],
      noPrefix: ["+", ":"],
    },
    { argv: ["git", "fetch"], noneOf: ["--upload-pack"] },
    { argv: ["git", "branch"], anyOf: ["--show-current"] },
    { argv: ["git", "diff"], anyOf: ["--stat", "--shortstat", "--name-only", "--name-status"], noneOf: ["-p", "-u", "--patch"] },
    { argv: ["gh", "pr"], next: ["view", "list", "status", "checks", "create"] },
    { argv: ["nightqueue", "run"], next: ["check", "dir", "log", "index-save", "commit", "pr", "start", "publish", "report"] },
  ].map(freezeRule),
);

export const FORBIDDEN_SHELL_CHARS = /[\n\r;&|`<>$]/;
const GLOB_CHARS = /[*?[{]/;
const SHORT_FLAG_CLUSTER = /^-[A-Za-z]{2,}$/;
const SAFE_SESSION_ID = /^[A-Za-z0-9_-]+$/;

const QUOTE_MASK = "_";
const UNQUOTED_EXPANSION_CHARS = /[()*?[\]{}]/;

// Tells whether a character inside a double-quoted run is one zsh still expands there (`$`, a backtick, the `(` of `$(`).
function expandsInDoubleQuotes(command, index) {
  const char = command[index];
  return char === "$" || char === "`" || (char === "(" && command[index - 1] === "$");
}

// The masked text of a quoted run whose body starts at `start`, and the index right after it; an unterminated run masks to the end.
function maskQuotedRun(command, start, { close, escapes, keep }) {
  let text = "";
  let index = start;
  while (index < command.length && command[index] !== close) {
    const escaped = escapes && command[index] === "\\";
    const width = escaped ? Math.min(2, command.length - index) : 1;
    text += keep(command, index) && !escaped ? command[index] : QUOTE_MASK.repeat(width);
    index += width;
  }
  return { text: index < command.length ? `${text}${close}` : text, next: index + 1 };
}

// The masked text of the run that starts at `index` (a quoted run, an escaped character or one plain character) and the index after it.
function maskRunAt(command, index) {
  const char = command[index];
  const never = () => false;
  if (char === "\\") return { text: index + 1 < command.length ? `\\${QUOTE_MASK}` : "\\", next: index + 2 };
  if (char === "'") return prefixed("'", maskQuotedRun(command, index + 1, { close: "'", escapes: false, keep: never }));
  if (char === "$" && command[index + 1] === "'") return prefixed("$'", maskQuotedRun(command, index + 2, { close: "'", escapes: true, keep: never }));
  if (char === '"') return prefixed('"', maskQuotedRun(command, index + 1, { close: '"', escapes: true, keep: expandsInDoubleQuotes }));
  return { text: char, next: index + 1 };
}

// A masked run with the opening quote mark put back in front of it.
function prefixed(opening, run) {
  return { text: `${opening}${run.text}`, next: run.next };
}

// The command with every character zsh reads as quoted replaced by `_`, quote marks kept, so only what zsh reads unquoted stays visible.
export function maskQuoted(command) {
  if (typeof command !== "string") throw new TypeError(`maskQuoted expects a string command, got ${typeof command}`);
  let masked = "";
  let index = 0;
  while (index < command.length) {
    const run = maskRunAt(command, index);
    masked += run.text;
    index = run.next;
  }
  return masked;
}

// Tells whether a command carries a `(` or `)` zsh reads unquoted, through which it can run a program (`=(cmd)`, `*(e:cmd:)`).
export function hasUnquotedParen(command) {
  return typeof command === "string" && /[()]/.test(maskQuoted(command));
}

// Tells whether a command carries a `#` zsh reads unquoted: a comment at word start, a repetition under EXTENDED_GLOB mid-word.
export function hasUnquotedHash(command) {
  return typeof command === "string" && maskQuoted(command).includes("#");
}

// Tells whether a command carries a `^` zsh reads unquoted: a pattern operator under EXTENDED_GLOB anywhere in a word (`^x`, `--^x`, `HEAD^`).
export function hasUnquotedCaret(command) {
  return typeof command === "string" && maskQuoted(command).includes("^");
}

// Every C0 control character but a tab and a newline (a NUL among them, at which zsh cuts the word it passes).
const CONTROL_CHAR = /[\u0000-\u0008\u000b-\u001f]/;

// Tells whether a command carries, quoted or not, a control character other than a tab or a newline; a value that is not a string counts as one.
export function hasControlChar(command) {
  return typeof command !== "string" || CONTROL_CHAR.test(command);
}

// Every blank JavaScript `\s` matches that zsh does not split a command line on (all but space, tab and the two line breaks, which have their own refusal).
const FOREIGN_BLANK = /[^\S \t\n\r]/;

// Tells whether a command carries, outside quotes, a blank zsh keeps inside a word while the guard's tokenizer splits on it (form feed, `\v`, NBSP, U+2028, …).
export function hasUnquotedForeignBlank(command) {
  return typeof command === "string" && FOREIGN_BLANK.test(maskQuoted(command));
}

// Tells whether a command carries a backslash zsh reads as an escape (outside quotes, or inside a double-quoted run), which changes the words zsh passes from the ones the guard judged.
export function hasEscapingBackslash(command) {
  if (typeof command !== "string") return true;
  let index = 0;
  while (index < command.length) {
    const char = command[index];
    if (char === "\\") return true;
    if (char === "'" || char === '"') {
      const close = command.indexOf(char, index + 1);
      const body = close === -1 ? command.slice(index + 1) : command.slice(index + 1, close);
      if (char === '"' && body.includes("\\")) return true;
      if (close === -1) return false;
      index = close + 1;
    } else {
      index += 1;
    }
  }
  return false;
}

// Tells whether zsh would expand a command before it runs: an unquoted `( ) * ? [ ] { }`, or a word opening with `^`.
export function hasUnquotedExpansion(command) {
  if (typeof command !== "string") return true;
  const masked = maskQuoted(command);
  return UNQUOTED_EXPANSION_CHARS.test(masked) || masked.split(/\s+/).some((word) => word.startsWith("^"));
}

// Splits a command into whitespace-separated tokens, keeping a single- or double-quoted run inside one token.
export function tokenize(command) {
  const tokens = command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
  return tokens.map((token) => token.replace(/"([^"]*)"|'([^']*)'/g, (_, double, single) => double ?? single ?? ""));
}

// Tells whether one argument is the flag itself, its `--flag=value` form, or a short-flag cluster (`-fu`) carrying it.
function isFlag(token, flag) {
  if (token === flag || token.startsWith(`${flag}=`)) return true;
  return flag.length === 2 && SHORT_FLAG_CLUSTER.test(token) && token.includes(flag[1]);
}

// Tells whether one argument is a denied flag, including the unambiguous abbreviation git accepts for a long one (`--mir`).
export function isDeniedFlag(token, flag) {
  if (isFlag(token, flag)) return true;
  const name = token.split("=")[0];
  return flag.startsWith("--") && name.length > 2 && name.startsWith("--") && flag.startsWith(name);
}

// Tells whether the arguments after the subcommand satisfy the constraints of one rule.
function ruleAccepts(rule, rest) {
  if (rule.anyOf && !rest.some((token) => rule.anyOf.some((flag) => isFlag(token, flag)))) return false;
  if (rule.noneOf && rest.some((token) => rule.noneOf.some((flag) => isDeniedFlag(token, flag)))) return false;
  if (rule.noPrefix && rest.some((token) => rule.noPrefix.some((prefix) => token.startsWith(prefix)))) return false;
  if (rule.next && !rule.next.includes(rest[0])) return false;
  return true;
}

// The row whose argv opens the command, the longest one when several do; null when none does.
function matchingRule(rules, tokens) {
  const matches = rules.filter(({ argv }) => argv.every((word, index) => tokens[index] === word));
  return matches.reduce((best, rule) => (best === null || rule.argv.length > best.argv.length ? rule : best), null);
}

// Tells whether zsh could run other words than the ones a closed list judges: a shell operator, a control character, an escape, a foreign blank or an unquoted expansion.
function shellRewrites(command) {
  if (FORBIDDEN_SHELL_CHARS.test(command) || hasControlChar(command) || hasEscapingBackslash(command) || hasUnquotedForeignBlank(command)) return true;
  return hasUnquotedExpansion(command) || hasUnquotedHash(command) || hasUnquotedCaret(command);
}

// Tells whether a Bash command is one row of a closed list: no shell operator or unquoted expansion, the bare program name, the row's own constraints.
function bashAllowed(rules, command) {
  if (typeof command !== "string" || shellRewrites(command)) return false;
  const tokens = tokenize(command.trim());
  const rule = matchingRule(rules, tokens);
  return rule ? ruleAccepts(rule, tokens.slice(rule.argv.length)) : false;
}

// Tells whether a Bash command is one of the closed list the orchestrator of a queued job may run.
export function orchestratorBashAllowed(command) {
  return bashAllowed(ORCHESTRATOR_BASH_RULES, command);
}

// Human rendering of one rule: the program and subcommand, what must follow, and what never may.
function describeRule({ argv, anyOf, noneOf, noPrefix, next }) {
  const allowed = next ?? anyOf;
  const never = [...(noneOf ?? []), ...(noPrefix ?? []).map((prefix) => `a ${prefix}refspec`)];
  const head = allowed ? `${argv.join(" ")} ${allowed.join("|")}` : argv.join(" ");
  return never.length ? `${head} (never ${never.join("/")})` : head;
}

// Human rendering of the closed list, one entry per rule, for a deny reason or a document.
export function describeOrchestratorBashRules() {
  return ORCHESTRATOR_BASH_RULES.map(describeRule).join(", ");
}

// The absolute target of a symlink whose target does not exist, or null when the path is no such link.
function danglingLinkTarget(path) {
  try {
    return lstatSync(path).isSymbolicLink() ? resolve(dirname(path), readlinkSync(path)) : null;
  } catch {
    return null;
  }
}

// The canonical form of a path after `hops` dangling symlinks were already followed.
function canonicalAfterHops(path, hops) {
  const absolute = resolve(path);
  let existing = absolute;
  while (!existsSync(existing) && dirname(existing) !== existing) {
    const target = hops < MAX_LINK_HOPS ? danglingLinkTarget(existing) : null;
    if (target !== null) return canonicalAfterHops(join(target, relative(existing, absolute)), hops + 1);
    existing = dirname(existing);
  }
  try {
    return join(realpathSync(existing), relative(existing, absolute));
  } catch {
    return absolute;
  }
}

// Real path of a path, or of its nearest existing ancestor with the missing rest appended, a dangling symlink followed, so no link hides where a path points.
export function canonicalPath(path) {
  return canonicalAfterHops(path, 0);
}

// The home of the job the hook runs for: the one the runtime pinned on the child, else the configuration home.
function jobHome(env) {
  const pinned = typeof env?.[JOB_HOME_ENV] === "string" ? env[JOB_HOME_ENV].trim() : "";
  return pinned ? resolve(pinned) : homeDir(env);
}

// The directory where the host spills a large tool result of one session, next to its transcript; null without both.
export function sessionSpillRoot({ transcriptPath, sessionId } = {}) {
  if (typeof sessionId !== "string" || !SAFE_SESSION_ID.test(sessionId)) return null;
  if (typeof transcriptPath !== "string" || !isAbsolute(transcriptPath)) return null;
  return join(dirname(transcriptPath), sessionId, SPILL_DIR);
}

// The transcript the host wrote for one session under its projects directory; null when none is found.
export function sessionTranscriptPath(env, sessionId) {
  if (typeof sessionId !== "string" || !SAFE_SESSION_ID.test(sessionId)) return null;
  const projects = join(claudeConfigDir(env), "projects");
  try {
    const project = readdirSync(projects, { withFileTypes: true }).find(
      (entry) => entry.isDirectory() && existsSync(join(projects, entry.name, `${sessionId}.jsonl`)),
    );
    return project ? join(projects, project.name, `${sessionId}.jsonl`) : null;
  } catch {
    return null;
  }
}

// Every copy of the plugin a session may load its agents and skills from, canonical.
export function pluginRoots(env = process.env) {
  const pluginEnv = typeof env?.[PLUGIN_DIR_ENV] === "string" ? env[PLUGIN_DIR_ENV].trim() : "";
  const candidates = [pluginEnv, join(packageRoot(), "plugin"), join(hostPackageRoot(env), "plugin"), claudePluginsDir(env)];
  return candidates.filter(Boolean).map(canonicalPath);
}

// Directories the orchestrator of a queued job may read: the runs of its home, every copy of the plugin it may load the skill from, and the host's spill of a large tool result of its own sessions only.
export function orchestratorRoots(env = process.env, sessions = []) {
  const candidates = [
    join(jobHome(env), "runs"),
    ...pluginRoots(env),
    ...(Array.isArray(sessions) ? sessions : []).map(sessionSpillRoot),
  ];
  return [...new Set(candidates.filter(Boolean).map(canonicalPath))];
}

// Static directory prefix of an absolute glob pattern, up to the first segment carrying a glob character.
export function globStaticPrefix(pattern) {
  const segments = pattern.split("/");
  const firstGlob = segments.findIndex((segment) => GLOB_CHARS.test(segment));
  const kept = firstGlob === -1 ? segments : segments.slice(0, firstGlob);
  return kept.join("/") || "/";
}

// Resolves a path value of a tool call against the session cwd; null when it cannot be resolved.
function resolveAgainst(value, cwd) {
  if (typeof value !== "string" || value.trim() === "") return null;
  if (isAbsolute(value)) return resolve(value);
  return typeof cwd === "string" && isAbsolute(cwd) ? resolve(cwd, value) : null;
}

// The Glob target: its path, else the static prefix of an absolute pattern, else the cwd; null for a pattern that climbs with `..`.
function globTarget(toolInput, cwd) {
  const pattern = typeof toolInput?.pattern === "string" ? toolInput.pattern : "";
  if (pattern.split(/[\\/]/).includes("..")) return null;
  if (typeof toolInput?.path === "string" && toolInput.path.trim() !== "") return resolveAgainst(toolInput.path, cwd);
  if (isAbsolute(pattern)) return globStaticPrefix(pattern);
  return resolveAgainst(cwd, cwd);
}

// The absolute path a Read, Grep or Glob call touches; null when the call names none that can be resolved.
export function readTarget(toolName, toolInput, cwd) {
  if (toolName === "Read") return resolveAgainst(toolInput?.file_path, cwd);
  if (toolName === "Grep") return resolveAgainst(toolInput?.path ?? cwd, cwd);
  if (toolName === "Glob") return globTarget(toolInput, cwd);
  return null;
}

// Tells whether a canonical path is the root or lies below it.
function underRoot(root, target) {
  if (typeof root !== "string" || root === "") return false;
  const rest = relative(root, target);
  return rest === "" || (!isAbsolute(rest) && rest.split(sep)[0] !== "..");
}

// Tells whether a path lies inside one of the roots once both are canonical; a null path is never inside.
export function insideRoots(path, roots) {
  if (typeof path !== "string" || !Array.isArray(roots)) return false;
  const target = canonicalPath(path);
  return roots.some((root) => underRoot(root, target));
}

// Tells whether a hook payload comes from the orchestrator's own main thread: only a subagent's call carries an agent_id.
export function isOrchestratorCall(input) {
  return !(typeof input?.agent_id === "string" && input.agent_id !== "");
}
