import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { homeDir, secretsPath, userHomeDir } from "../config/paths.mjs";
import { claudeConfigDir } from "../host/paths.mjs";
import { canonicalPath, insideRoots, isDeniedFlag, tokenize } from "./orchestrator-scope.mjs";
import {
  DOTENV_NAME,
  NIGHTQUEUE_PROGRAMS,
  OPERATOR_CLI_COMMANDS,
  bareTokens,
  checkoutRoots,
  gitReadAllowed,
  refusedNightqueueForm,
  registryNote,
} from "./operator-scope.mjs";

const SEGMENT_SEPARATORS = new Set([";", "&", "|", "(", ")", "\n", "\r"]);
const WRAPPERS = new Set(["sudo", "env", "command", "exec", "nohup", "time", "nice", "builtin", "xargs", "timeout"]);
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish"]);
const DELETERS = new Set(["rm", "rmdir", "unlink", "shred"]);
const EXEC_FLAGS = new Set(["-exec", "-execdir", "-ok", "-okdir"]);
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const WRAPPER_ARGUMENT = /^(-.*|\d+(\.\d+)?[smhd]?)$/;
const SCRIPT_EXTENSION = /\.m?js$/;
const SETTINGS_FILE = /^settings.*\.json$/;
const HOME_LITERALS = ["$HOME", "${HOME}", "$NIGHTQUEUE_HOME", "${NIGHTQUEUE_HOME}", "$CLAUDE_CONFIG_DIR", "${CLAUDE_CONFIG_DIR}", "~/.nightqueue"];
const GIT_VALUE_OPTIONS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path"]);
const GIT_UNSCOPED_OPTIONS = ["-c", "--git-dir", "--work-tree", "--namespace", "--exec-path"];
const FORCE_PUSH_FLAGS = ["-f", "-d", "--force", "--delete", "--mirror", "--prune"];
const BRANCH_DELETE_FLAGS = ["-D", "-d", "--delete"];
const CD_ANCHOR = /^cd\s+("[^"]*"|'[^']*'|[^\s"'&;|]+)\s*&&\s*(\S[\s\S]*)$/;
const DURATION = /^\d+(\.\d+)?[smhd]?$/;
const SECRETS_NAME = "secrets.json";
const GIT_DIR_NAME = ".git";
const GLOB_CHARS = /[*?[\]{}]/;
const DOTENV_STEM = ".env";
const MAX_BRACE_WORDS = 64;
const NIGHTQUEUE_NEVER = "a nightqueue command that writes the home or settings, nests a session or starts the runner";

// The program a word names, its directory and a script extension dropped (`bin/nightqueue.mjs` names nightqueue).
function programName(word) {
  return typeof word === "string" ? basename(word).replace(SCRIPT_EXTENSION, "") : "";
}

// The directories whose content is Claude or Codex settings: the Claude configuration directory and the user's `.codex`.
function settingsRoots(env) {
  return [claudeConfigDir(env), join(userHomeDir(env), ".codex")].map(canonicalPath);
}

// Tells whether a canonical path is a Claude settings file of a project (`.claude/settings*.json`) or lies in any `.codex` directory.
function isSettingsPath(target) {
  if (target.split(sep).includes(".codex")) return true;
  return SETTINGS_FILE.test(basename(target)) && basename(dirname(target)) === ".claude";
}

// Why a write to a path is in the never band (the nightqueue home, Claude/Codex settings, a `.git` directory, a `.env*` file), or null when it is not.
export function neverWriteReason(path, env = process.env) {
  if (typeof path !== "string" || path === "") return null;
  const target = canonicalPath(path);
  if (insideRoots(target, [canonicalPath(homeDir(env))])) return "writing under the nightqueue home";
  if (insideRoots(target, settingsRoots(env)) || isSettingsPath(target)) return "Claude/Codex settings";
  if (target.split(sep).includes(GIT_DIR_NAME)) return "a repository's `.git` directory (its config and hooks run commands)";
  if (DOTENV_NAME.test(basename(target))) return "a `.env` file";
  return null;
}

// Tells whether a text carries a glob or brace character the shell would expand.
export function hasGlob(text) {
  return typeof text === "string" && GLOB_CHARS.test(text);
}

// The words the first `{…}` of a word expands to (`a{b,c}` gives `ab`, `ac`), or null when the word holds no brace pair.
function expandFirstBrace(word) {
  const open = word.indexOf("{");
  const close = open === -1 ? -1 : word.indexOf("}", open);
  if (close === -1) return null;
  const [head, body, tail] = [word.slice(0, open), word.slice(open + 1, close), word.slice(close + 1)];
  return body.split(",").map((choice) => `${head}${choice}${tail}`);
}

// The words a brace expansion of one word yields, the word itself when it holds none; null past MAX_BRACE_WORDS, so the caller fails safe.
function braceExpansions(word) {
  const pending = [word];
  const done = [];
  while (pending.length > 0) {
    if (pending.length + done.length > MAX_BRACE_WORDS) return null;
    const current = pending.pop();
    const expanded = expandFirstBrace(current);
    if (expanded === null) done.push(current);
    else pending.push(...expanded);
  }
  return done;
}

// Tells whether a file name glob could match a `.env*` name: its literal head is one of `.env`'s prefixes or opens with `.env`, or it opens with a class.
function globMatchesDotenv(name) {
  const first = name.search(GLOB_CHARS);
  if (first === -1) return false;
  const head = name.slice(0, first);
  if (head === "") return /^[[{]/.test(name);
  return DOTENV_STEM.startsWith(head) || head.startsWith(DOTENV_STEM);
}

// The segments of a shell command, split on every unquoted separator and on each command substitution, quoted or not.
function shellSegments(command) {
  const segments = [];
  let current = "";
  let quote = null;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (quote === "'") {
      current += char;
      if (char === "'") quote = null;
    } else if (char === "`" || (char === "$" && command[index + 1] === "(")) {
      segments.push(current);
      current = "";
      if (char === "$") index += 1;
    } else if (quote === '"') {
      current += char;
      if (char === '"') quote = null;
    } else if (char === "'" || char === '"') {
      quote = char;
      current += char;
    } else if (SEGMENT_SEPARATORS.has(char)) {
      segments.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  segments.push(current);
  return segments.map((segment) => segment.trim()).filter(Boolean);
}

// The words of one segment, each with its backslashes dropped the way the shell drops them.
function segmentWords(segment) {
  return tokenize(segment).map((word) => word.replace(/\\/g, ""));
}

// The index of the program word of a segment, past its env assignments and its wrappers (`sudo`, `env`, `xargs`, `timeout <n>`, …).
function programIndex(words) {
  let index = 0;
  while (index < words.length) {
    if (ENV_ASSIGNMENT.test(words[index])) {
      index += 1;
    } else if (WRAPPERS.has(programName(words[index]))) {
      index += 1;
      while (index < words.length && (WRAPPER_ARGUMENT.test(words[index]) || ENV_ASSIGNMENT.test(words[index]))) index += 1;
    } else {
      return index;
    }
  }
  return index;
}

// A word as an absolute path, `~` expanded and a relative path with a slash resolved against the segment's directory, or null.
function wordPath(word, { dir, env }) {
  if (word === "~" || word.startsWith("~/")) return join(userHomeDir(env), word.slice(1));
  if (isAbsolute(word)) return word;
  return word.includes("/") && dir ? resolve(dir, word) : null;
}

// The path forms a word may carry: itself and, for a `--flag=value`, its value.
function pathForms(word) {
  const value = word.startsWith("-") && word.includes("=") ? word.slice(word.indexOf("=") + 1) : null;
  return value ? [word, value] : [word];
}

// Tells whether a word names a secret: a `.env*` file or a glob that could match one, the home's secrets file, or a `<rev>:<path>` whose file is one of them.
function namesSecret(word, { dir, env }) {
  const revPath = word.includes(":") ? word.slice(word.indexOf(":") + 1) : null;
  for (const form of [...pathForms(word), ...(revPath ? [revPath] : [])]) {
    const name = basename(form);
    if (DOTENV_NAME.test(name) || globMatchesDotenv(name) || (form === revPath && name === SECRETS_NAME)) return true;
    const path = wordPath(form, { dir, env });
    if (path && canonicalPath(path) === canonicalPath(secretsPath(env))) return true;
  }
  return false;
}

// The words of a segment with every brace expansion spelled out, or null when one expands past the bound.
function expandedWords(words) {
  const expanded = [];
  for (const word of words) {
    const expansions = braceExpansions(word);
    if (expansions === null) return null;
    expanded.push(...expansions);
  }
  return expanded;
}

// Why the words of a segment name a never-band path (secrets, the home, Claude/Codex settings, a `.git` directory), or null.
function pathWordsReason(rawWords, scope) {
  const words = expandedWords(rawWords);
  if (words === null) return "a brace expansion too large to check";
  for (const word of words) {
    if (namesSecret(word, scope)) return "reading or printing secrets";
    if (HOME_LITERALS.some((literal) => word.includes(literal))) return "naming the nightqueue home or the Claude/Codex settings";
    for (const form of pathForms(word)) {
      const path = wordPath(form, scope);
      const reason = path ? neverWriteReason(path, scope.env) : null;
      if (reason) return `naming a never-band path (${reason})`;
    }
  }
  return null;
}

// The git subcommand and its arguments, the global options and their values skipped.
function gitSubcommand(args) {
  for (let index = 0; index < args.length; index += 1) {
    if (GIT_VALUE_OPTIONS.has(args[index])) index += 1;
    else if (!args[index].startsWith("-")) return { subcommand: args[index], rest: args.slice(index + 1) };
  }
  return { subcommand: null, rest: [] };
}

// Tells whether one argument of `git push` forces, deletes, mirrors or prunes (a `+` or `:` refspec included).
function forcePushArg(token) {
  if (token.startsWith("--force") || FORCE_PUSH_FLAGS.some((flag) => isDeniedFlag(token, flag))) return true;
  return !token.startsWith("-") && (token.startsWith("+") || token.startsWith(":"));
}

// Why a git command is in the never band (force push, branch delete, hard reset, clean, rm), or null.
function gitNeverReason(args) {
  const { subcommand, rest } = gitSubcommand(args);
  if (subcommand === "push" && rest.some(forcePushArg)) return "a force push or a remote delete";
  if (subcommand === "branch" && rest.some((token) => BRANCH_DELETE_FLAGS.some((flag) => isDeniedFlag(token, flag)))) return "deleting a branch";
  if (subcommand === "reset" && rest.some((token) => isDeniedFlag(token, "--hard"))) return "a hard reset";
  if (subcommand === "clean") return "discarding untracked files";
  if (subcommand === "rm") return "deleting files";
  return null;
}

// Why a nightqueue command is in the never band, or null; `verify` and `sandbox <command>` are left to the consent band.
function nightqueueNeverReason(words) {
  const [, command, subcommand] = words;
  if (command === "verify") return null;
  if (command === "sandbox") return subcommand === "worktree" ? NIGHTQUEUE_NEVER : null;
  return OPERATOR_CLI_COMMANDS.refused.includes(command) || refusedNightqueueForm(words) ? NIGHTQUEUE_NEVER : null;
}

// Tells whether the words delete files: a deleting program, `find … -delete`, or a deleting program after `-exec`.
function deletes(words) {
  const program = programName(words[0]);
  if (DELETERS.has(program)) return true;
  if (program === "find" && words.includes("-delete")) return true;
  return words.some((word, index) => EXEC_FLAGS.has(word) && DELETERS.has(programName(words[index + 1])));
}

// Why the program words of a segment are in the never band, or null; a shell's `-c` text and `eval` are scanned in turn.
function programReason(words, scope) {
  if (words.length === 0) return null;
  const program = programName(words[0]);
  if (deletes(words)) return "deleting files";
  if (program === "git") return gitNeverReason(words.slice(1));
  if (NIGHTQUEUE_PROGRAMS.has(program)) return nightqueueNeverReason(words);
  if (program === "eval") return neverBashReason(words.slice(1).join(" "), { cwd: scope.dir, env: scope.env });
  const inline = SHELLS.has(program) ? words.indexOf("-c") : -1;
  return inline === -1 ? null : neverBashReason(words[inline + 1] ?? "", { cwd: scope.dir, env: scope.env });
}

// The directory the next segment runs in: the one a `cd <dir>` segment moves to (a relative one from the last known directory), else the same.
function nextDir(words, { scope, base }) {
  if (words[0] !== "cd" || typeof words[1] !== "string") return scope.dir;
  const from = scope.dir ?? base;
  return wordPath(words[1], scope) ?? (from ? resolve(from, words[1]) : scope.dir);
}

// The directory the first segment's relative words resolve against: the cwd, unless it is the nightqueue home where the operator starts.
function firstSegmentDir(base, env) {
  if (base === null) return null;
  return insideRoots(canonicalPath(base), [canonicalPath(homeDir(env))]) ? null : base;
}

// Why a Bash command is in the never band, scanning every segment of it, or null when no segment is; relative words resolve against the cwd, then each `cd`.
export function neverBashReason(command, { cwd = null, env = process.env } = {}) {
  if (typeof command !== "string") return null;
  const base = typeof cwd === "string" && isAbsolute(cwd) ? cwd : null;
  let dir = firstSegmentDir(base, env);
  for (const segment of shellSegments(command)) {
    const words = segmentWords(segment);
    const scope = { dir, env };
    const reason = pathWordsReason(words, scope) ?? programReason(words.slice(programIndex(words)), scope);
    if (reason) return reason;
    dir = nextDir(words, { scope, base });
  }
  return null;
}

// A quoted word without its quotes.
function unquoted(word) {
  return word.replace(/^(["'])(.*)\1$/, "$2");
}

// The words of a command after a leading `timeout <n>`.
function withoutTimeout(words) {
  return words[0] === "timeout" && DURATION.test(words[1] ?? "") ? words.slice(2) : words;
}

// The command a consent scope names, a leading `cd <dir> &&` and `timeout <n>` dropped, as its words; null when it is not one bare command.
export function scopeWords(scope) {
  if (typeof scope !== "string") return null;
  const match = CD_ANCHOR.exec(scope.trim());
  const words = bareTokens(match ? match[2] : scope);
  if (words === null) return null;
  const rest = withoutTimeout(words);
  return rest.length > 0 ? rest : null;
}

// The anchor of a command: `cd <abs dir> && <rest>`, else the command itself in the session's directory.
function commandAnchor(command, cwd) {
  const match = CD_ANCHOR.exec(command);
  if (!match) return { dir: typeof cwd === "string" && isAbsolute(cwd) ? cwd : null, rest: command };
  const dir = unquoted(match[1]);
  return isAbsolute(dir) ? { dir, rest: match[2].trim() } : { shape: "`cd` takes an absolute directory" };
}

// The shape refusal of a directory outside every registered checkout, or null when it lies in one.
function checkoutShape(dir, env) {
  const { roots, error } = checkoutRoots(env);
  if (dir && insideRoots(dir, roots)) return null;
  return { shape: `${dir ?? "the session's directory"} is outside every registered checkout${registryNote(error)}` };
}

// The git consent of a command (`git [-C <dir>] <subcommand> …`), or free for a read of a checkout, or a shape refusal.
function gitConsent(words, { dir, rest }, env) {
  let index = 1;
  let gitDir = dir;
  let noLocks = false;
  while (index < words.length && words[index].startsWith("-")) {
    const option = words[index];
    if (GIT_UNSCOPED_OPTIONS.some((flag) => option === flag || option.startsWith(`${flag}=`))) return { shape: `\`git ${option}\` is refused` };
    if (option === "-C") {
      if (!isAbsolute(words[index + 1] ?? "")) return { shape: "`git -C` takes an absolute directory" };
      gitDir = words[index + 1];
      index += 2;
      continue;
    }
    noLocks = noLocks || option === "--no-optional-locks";
    index += 1;
  }
  const outside = checkoutShape(gitDir, env);
  if (outside) return outside;
  const argv = words.slice(index);
  if (gitReadAllowed(["git", "-C", gitDir, ...(noLocks ? ["--no-optional-locks"] : []), ...argv], checkoutRoots(env).roots)) return { free: true };
  return { kind: "git-write", dir: gitDir, argv, shown: rest };
}

// What consent a Bash command needs (`{ kind, dir, argv, shown }`), `{ free: true }` for a git read of a checkout, or `{ shape }` when it has no consentable form.
export function consentBash(command, { cwd = null, env = process.env } = {}) {
  if (typeof command !== "string" || command.trim() === "") return { shape: "the command is empty" };
  const anchor = commandAnchor(command.trim(), cwd);
  if (anchor.shape) return anchor;
  const words = bareTokens(anchor.rest);
  if (words === null || words.length === 0) return { shape: "the command chains, pipes or redirects, or carries a backslash" };
  if (hasGlob(anchor.rest)) return { shape: "the command carries a glob or brace character (`* ? [ ] { }`), so no consent can name what it touches" };
  if (words[0] === "git") return gitConsent(words, anchor, env);
  const outside = checkoutShape(anchor.dir, env);
  if (outside) return outside;
  return { kind: "run", dir: anchor.dir, argv: withoutTimeout(words), shown: anchor.rest };
}
