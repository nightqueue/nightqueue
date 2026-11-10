import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { homeDir, secretsPath, userHomeDir } from "../config/paths.mjs";
import { canonicalPath, insideRoots, isDeniedFlag, tokenize } from "../queue/orchestrator-scope.mjs";
import {
  WORKTREE_MAINTENANCE,
  WORKTREE_READ_SPELLING,
  deletes,
  homeSegment,
  isWorktreeEntry,
  prefetchPrStates,
  programName,
  wordPath,
  worktreeArgJudged,
} from "../queue/operator-home.mjs";
import { withPrBudget } from "../queue/operator-pr-budget.mjs";
import {
  DOTENV_EXCLUDE_PATHSPEC,
  DOTENV_NAME,
  GIT_READ_SUBCOMMANDS,
  NIGHTQUEUE_PROGRAMS,
  OPERATOR_CLI_COMMANDS,
  commandPrefix,
  expansionFlags,
  expansionJudgedEnd,
  gitGlobals,
  gitGrepIndex,
  grepSpellingNever,
  isDoctorFix,
  isDoctorFixForm,
  refusedNightqueueForm,
  withoutTimeout,
} from "../queue/operator-scope.mjs";
import { claudeConfigDir } from "./paths.mjs";

const SEGMENT_SEPARATORS = new Set([";", "&", "|", "(", ")", "\n", "\r"]);
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish"]);
const SETTINGS_FILE = /^settings.*\.json$/;
const SHELL_HOME_LITERALS = ["$HOME", "${HOME}", "$NIGHTQUEUE_HOME", "${NIGHTQUEUE_HOME}", "$CLAUDE_CONFIG_DIR", "${CLAUDE_CONFIG_DIR}"];
const HOME_LITERALS = [...SHELL_HOME_LITERALS, "~/.nightqueue"];
const NO_WORDS = new Set();
const FORCE_PUSH_FLAGS = ["-f", "-d", "--force", "--delete", "--mirror", "--prune"];
const BRANCH_DELETE_FLAGS = ["-D", "-d", "--delete"];
const SECRETS_NAME = "secrets.json";
const GIT_DIR_NAME = ".git";
const GLOB_CHARS = /[*?[\]{}]/;
const DOTENV_STEM = ".env";
const MAX_BRACE_WORDS = 64;
const NIGHTQUEUE_NEVER = "a nightqueue command that writes the home or settings, nests a session or starts the runner";
const DOCTOR_FIX_SPELLING = "`doctor --fix` is consented only as `nightqueue doctor --fix`";
export const WRAPPED_GUARDED =
  "git, `nightqueue doctor --fix` and home maintenance run as one bare command, never behind `env`, `nice`, `sudo`, an env assignment or another wrapper, nor git spelled by its path; only `timeout <n>` may lead";
const WRAPPER_SPLIT_NEVER = "`env -S`/`--split-string` hides a command line in one word, so no guard can judge the program it runs";
const WORKTREE_TARGETED = new Set(["remove", "move"]);
const WORKTREE_BY_ABSOLUTE_PATH = "`git worktree remove|move` names its worktree by its absolute path, never relative to where git runs nor through a link";
const HOME_PATH_NEVER = "naming a never-band path (writing under the nightqueue home)";
const GREP_UNQUOTED =
  "an unquoted glob, brace or leading `^` before the `--` of a `git grep`, which zsh expands before git runs: quote the pattern (`'foo.*bar'`, `-- 'src/*.mjs'`)";
const GREP_BACKSLASH = "a backslash in a `git grep`, which no guard can read the way zsh does: quote the pattern instead";
const GREP_DOLLAR = "a `$` in a `git grep`, which the free list refuses even quoted: drop it from the pattern";
const GREP_UNALIGNED = "a `git grep` whose quoting no guard can align with its words: quote each pattern as one word";
const WORKTREE_CD_NEVER = `a worktree under the nightqueue home is read only through \`git -C <worktree>\`, never after a \`cd\` into it: ${WORKTREE_READ_SPELLING}`;
const DELETING_FILES = "deleting files";
const CHAT_DELETE_NEVER = "deleting the nightqueue home or the session worktree";
const SHELL_NO_SCRIPT = "a shell's -c with no command text";
const SHELL_SCRIPT_FLAG = /^-[A-Za-z]*c[A-Za-z]*$/;
const SHELL_STDIN_FLAG = /^-[A-Za-z]*s[A-Za-z]*$/;
const SHELL_OPTION = /^[-+]/;
const CHAT_WRAPPERS = new Set(["setsid", "stdbuf", "ionice", "doas", "chrt", "taskset", "caffeinate", "unbuffer"]);
const CHAT_GIT_GLOB_NEVER = "deleting a glob that could match a `.git` directory";
const SPACED_WORD = /\s/;

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
  return protectedPathReason(target, env);
}

// Why a canonical path is in the never band wherever it lies (Claude/Codex settings, a `.git` directory, a `.env*` file), or null.
export function protectedPathReason(target, env) {
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

// Tells whether a path component glob could match `.git`: its literal head is one of `.git`'s prefixes or opens with `.git`, or it opens with a class.
function globMatchesGitDir(name) {
  const first = name.search(GLOB_CHARS);
  if (first === -1) return false;
  const head = name.slice(0, first);
  if (head === "") return /^[[{]/.test(name);
  return GIT_DIR_NAME.startsWith(head) || head.startsWith(GIT_DIR_NAME);
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
  return commandPrefix(words).index;
}

// Tells whether words are a bare git read (`log`, `diff`, `blame`, …), whose arguments are patterns and paths, never a program it runs.
function isBareGitRead(argv) {
  return argv[0] === "git" && GIT_READ_SUBCOMMANDS.has(gitSubcommand(argv.slice(1)).subcommand);
}

// Tells whether a word may run git itself: `git` or a path to it, never a file that only shares the name (`src/host/git.mjs`).
function namesGit(word) {
  return typeof word === "string" && basename(word) === "git";
}

// The index of the first word past the leading program that opens git or a `doctor --fix` form, whatever wrapper runs it, or -1.
function hiddenGuardedIndex(argv) {
  const scansGit = !isBareGitRead(argv);
  return argv.findIndex((word, index) => index > 0 && ((scansGit && namesGit(word)) || isDoctorFixForm(argv.slice(index))));
}

// Why a segment hides git or `doctor --fix` past its bare leading program (only `timeout <n>` may lead), or null.
function hiddenGuardedReason(words) {
  const argv = withoutTimeout(words);
  const index = hiddenGuardedIndex(argv);
  if (index === -1) return null;
  const hidden = argv.slice(index);
  if (isDoctorFixForm(hidden)) return DOCTOR_FIX_SPELLING;
  return gitNeverReason(hidden.slice(1)) ?? WRAPPED_GUARDED;
}

// Tells whether a command runs git, `doctor --fix` or home maintenance through anything but a bare command (or `timeout <n>`): any wrapper, known or not, or git spelled by a path.
export function isWrappedGuarded(words) {
  if (hiddenGuardedIndex(withoutTimeout(words)) !== -1) return true;
  const { bare, program, unparsed } = commandPrefix(words);
  if (programName(program[0]) === "git") return !(bare && program[0] === "git");
  return !bare && (unparsed || isHomeMaintenance(program));
}

// The path forms a word may carry: itself and, for a `--flag=value`, its value.
function pathForms(word) {
  const value = word.startsWith("-") && word.includes("=") ? word.slice(word.indexOf("=") + 1) : null;
  return value ? [word, value] : [word];
}

// A path form of a word as a path; in chat mode a bare whole word also resolves against the segment's directory, the way the shell reads it.
function scopeWordPath(form, { word, scope }) {
  const path = wordPath(form, scope);
  if (path !== null || !scope.chat || !scope.dir || form !== word || form === "" || form.startsWith("-")) return path;
  return resolve(scope.dir, form);
}

// Tells whether a path lies in the chat session's own worktree, its root included.
function inChatWorktree(path, chat) {
  return typeof chat?.worktree === "string" && insideRoots(canonicalPath(path), [chat.worktree]);
}

// Tells whether a word names a secret: a `.env*` file or a glob that could match one, the home's secrets file, or a `<rev>:<path>` whose file is one of them.
function namesSecret(word, scope) {
  const { env } = scope;
  const revPath = word.includes(":") ? word.slice(word.indexOf(":") + 1) : null;
  for (const form of [...pathForms(word), ...(revPath ? [revPath] : [])]) {
    const name = basename(form);
    if (DOTENV_NAME.test(name) || globMatchesDotenv(name) || (form === revPath && name === SECRETS_NAME)) return true;
    const path = scopeWordPath(form, { word, scope });
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

// Why a path a word carries is in the never band; a home entry the segment's home use accepted is judged on everything but the home itself.
function pathFormReason(path, { accepted, env, chat }) {
  return accepted || inChatWorktree(path, chat) ? protectedPathReason(canonicalPath(path), env) : neverWriteReason(path, env);
}

// Why the expanded words of a segment name a never-band path (secrets, the home, Claude/Codex settings, a `.git` directory), or null.
function pathWordsReason(words, scope, accepted = NO_WORDS) {
  for (const word of words) {
    if (word === DOTENV_EXCLUDE_PATHSPEC) continue;
    if (namesSecret(word, scope)) return "reading or printing secrets";
    const literals = accepted.has(word) ? SHELL_HOME_LITERALS : HOME_LITERALS;
    if (literals.some((literal) => word.includes(literal))) return "naming the nightqueue home or the Claude/Codex settings";
    for (const form of pathForms(word)) {
      const path = scopeWordPath(form, { word, scope });
      const reason = path ? pathFormReason(path, { accepted: accepted.has(form), env: scope.env, chat: scope.chat }) : null;
      if (reason) return `naming a never-band path (${reason})`;
    }
  }
  return null;
}

// The git subcommand and its arguments past the allowed global options; no subcommand when a global option is off the allowlist.
function gitSubcommand(args) {
  const { index, refused } = gitGlobals(args);
  if (refused !== null || index >= args.length) return { subcommand: null, rest: [] };
  return { subcommand: args[index], rest: args.slice(index + 1) };
}

// The never reason of a git global option off the allowlist.
export function gitGlobalNever(option) {
  return `a git global option other than \`-C <dir>\`, \`--no-optional-locks\`, \`--no-pager\` (\`${option}\`) injects config, hooks or paths`;
}

// Tells whether one argument of `git push` forces, deletes, mirrors or prunes (a `+` or `:` refspec included).
function forcePushArg(token) {
  if (token.startsWith("--force") || FORCE_PUSH_FLAGS.some((flag) => isDeniedFlag(token, flag))) return true;
  return !token.startsWith("-") && (token.startsWith("+") || token.startsWith(":"));
}

// Why a git command is in the never band (a global option off the allowlist, force push, branch delete, hard reset, clean, rm, a worktree removal by an unjudged path), or null.
function gitNeverReason(args) {
  const { refused, index } = gitGlobals(args);
  if (refused !== null) return gitGlobalNever(refused);
  const { subcommand, rest } = gitSubcommand(args);
  if (subcommand === "grep") return grepNeverReason(args.slice(0, index), rest);
  if (subcommand === "worktree" && WORKTREE_TARGETED.has(rest[0]) && !rest.slice(1).every(worktreeArgJudged)) return WORKTREE_BY_ABSOLUTE_PATH;
  if (subcommand === "push" && rest.some(forcePushArg)) return "a force push or a remote delete";
  if (subcommand === "branch" && rest.some((token) => BRANCH_DELETE_FLAGS.some((flag) => isDeniedFlag(token, flag)))) return "deleting a branch";
  if (subcommand === "reset" && rest.some((token) => isDeniedFlag(token, "--hard"))) return "a hard reset";
  if (subcommand === "clean") return "discarding untracked files";
  if (subcommand === "rm") return DELETING_FILES;
  return null;
}

// Why a git grep is in the never band, its leading `-C <dir>` dropped: any spelling but the one free hardened one; null for it.
function grepNeverReason(globals, rest) {
  const afterDir = globals[0] === "-C" ? globals.slice(2) : globals;
  return grepSpellingNever([...afterDir, "grep", ...rest]);
}

// Why the raw text of a git grep segment is in the never band: a backslash, a `$`, words the mask cannot align, or an unquoted expansion before the real `--`; null otherwise.
function grepRawReason(raw, words) {
  const { index, program } = commandPrefix(words);
  if (gitGrepIndex(program) === -1) return null;
  if (raw.includes("\\")) return GREP_BACKSLASH;
  if (raw.includes("$")) return GREP_DOLLAR;
  const flags = expansionFlags(raw);
  if (flags === null || flags.length !== words.length) return GREP_UNALIGNED;
  return flags.slice(0, index + expansionJudgedEnd(program)).some(Boolean) ? GREP_UNQUOTED : null;
}

// Why a nightqueue command is in the never band, or null; `verify` and `sandbox <command>` are left to the consent band.
function nightqueueNeverReason(words) {
  const [, command, subcommand] = words;
  if (isDoctorFixForm(words) && !isDoctorFix(words)) return DOCTOR_FIX_SPELLING;
  if (command === "verify") return null;
  if (command === "sandbox") return subcommand === "worktree" ? NIGHTQUEUE_NEVER : null;
  return OPERATOR_CLI_COMMANDS.refused.includes(command) || refusedNightqueueForm(words) ? NIGHTQUEUE_NEVER : null;
}

// Why a git command is never under the scope's delete allowance: `git rm` is not when deletes are allowed, every other reason stays.
function scopedGitReason(args, scope) {
  const reason = gitNeverReason(args);
  return scope.allowDeletes && reason === DELETING_FILES ? null : reason;
}

// Why the program words of a segment are in the never band, or null; a home maintenance delete is left to the consent band, a shell's `-c` text and `eval` are scanned in turn.
function programReason(words, { scope, maintenance }) {
  if (words.length === 0) return null;
  const program = programName(words[0]);
  if (deletes(words) && !maintenance && !scope.allowDeletes) return DELETING_FILES;
  if (program === "git") return scopedGitReason(words.slice(1), scope);
  if (NIGHTQUEUE_PROGRAMS.has(program)) return nightqueueNeverReason(words);
  const nested = { cwd: scope.dir, env: scope.env, nested: true, allowDeletes: scope.allowDeletes, chat: scope.chat };
  if (program === "eval") return neverBashReason(words.slice(1).join(" "), nested);
  return SHELLS.has(program) ? shellScriptReason(words, { scope, nested }) : null;
}

// The words that may be a shell's inline script: every non-option word past `-c` or a one-dash flag cluster holding `c` (`-lc`, `-xec`, `-c -x '…'`), or null when there is no such flag.
function shellScriptWords(words) {
  const flag = words.findIndex((word, index) => index > 0 && SHELL_SCRIPT_FLAG.test(word));
  return flag === -1 ? null : words.slice(flag + 1).filter((word) => !SHELL_OPTION.test(word));
}

// The first never reason of the texts, each judged as a nested command, or null.
function firstScriptReason(texts, nested) {
  for (const text of texts) {
    const reason = neverBashReason(text, nested);
    if (reason) return reason;
  }
  return null;
}

// Why a shell's inline script is in the never band, or null; in chat mode a flag cluster opens it too, every candidate script word is judged and a script flag with no text is never.
function shellScriptReason(words, { scope, nested }) {
  if (!scope.chat) {
    const flag = words.indexOf("-c");
    return flag === -1 ? null : neverBashReason(words[flag + 1] ?? "", nested);
  }
  const scripts = shellScriptWords(words);
  if (scripts === null) return null;
  return scripts.length === 0 ? SHELL_NO_SCRIPT : firstScriptReason(scripts, nested);
}

// The program words a chat segment may run: its program and, behind a wrapper the operator's list lacks (`setsid`, `stdbuf`, `doas`, …), every later word as a program.
function chatPrograms(program) {
  if (!CHAT_WRAPPERS.has(programName(program[0]))) return [program];
  return [program, ...program.slice(1).map((_, index) => commandPrefix(program.slice(index + 1)).program)];
}

// Tells whether program words are a shell reading its script from stdin: no `-c` text, and a `-s` flag, no operand, or a `<` redirect first.
function readsStdinScript(words) {
  const first = String(words[0] ?? "");
  if (!SHELLS.has(programName(first.split("<")[0])) || shellScriptWords(words) !== null) return false;
  if (first.includes("<")) return true;
  const operand = words.slice(1).find((word) => !SHELL_OPTION.test(word));
  return operand === undefined || operand.startsWith("<") || words.slice(1).some((word) => SHELL_STDIN_FLAG.test(word));
}

// Tells whether any segment of a Bash command runs a shell that reads its script from stdin (`… | sh`, `bash <<< …`, `sh < file`), past every wrapper.
export function commandFeedsShell(command) {
  if (typeof command !== "string") return false;
  return shellSegments(command).some((raw) => chatPrograms(commandPrefix(segmentWords(raw)).program).some(readsStdinScript));
}

// Why a command feeding a shell its script through stdin is never in chat mode: each word holding a space is judged as the script it may be.
function fedScriptReason(command, segments, nested) {
  if (!commandFeedsShell(command)) return null;
  const texts = segments.flatMap(({ words }) => words).filter((word) => SPACED_WORD.test(word) && word.length < command.length);
  return firstScriptReason(texts, nested);
}

// Why a git segment run with no `-C` inside a job worktree (reached by `cd`) is never, or null when it is not one, is a `git worktree` call or runs in the chat session's own worktree.
function worktreeCdReason(words, scope) {
  const { program } = commandPrefix(words);
  if (programName(program[0]) !== "git") return null;
  const { dir, index } = gitGlobals(program.slice(1));
  if (dir !== null || program[1 + index] === "worktree") return null;
  if (typeof scope?.dir !== "string" || inChatWorktree(scope.dir, scope.chat)) return null;
  return isWorktreeEntry(scope.dir, scope.env) ? WORKTREE_CD_NEVER : null;
}

// Tells whether a delete target is the nightqueue home, holds it, or is the session worktree root.
function homeOrWorktreeTarget(path, { home, worktree }) {
  const target = canonicalPath(path);
  return insideRoots(home, [target]) || target === worktree;
}

// Why a delete segment in chat mode is never: a glob that could match `.git`, or a target that is the nightqueue home, holds it, or is the session worktree itself.
function chatDeleteReason(words, scope) {
  if (!scope.chat || !chatPrograms(commandPrefix(words).program).some(deletes)) return null;
  if (words.some((word) => word.split("/").some(globMatchesGitDir))) return CHAT_GIT_GLOB_NEVER;
  const roots = { home: canonicalPath(homeDir(scope.env)), worktree: scope.chat.worktree };
  const paths = words.map((word) => scopeWordPath(word, { word, scope })).filter((path) => path !== null);
  return paths.some((path) => homeOrWorktreeTarget(path, roots)) ? CHAT_DELETE_NEVER : null;
}

// Why one segment is in the never band: its home use first, then the paths its words name, then its program.
function segmentReason(words, { scope, nested }) {
  const expanded = expandedWords(words);
  if (expanded === null) return "a brace expansion too large to check";
  const home = homeSegment(expanded, { start: programIndex(expanded), env: scope.env, nested });
  if (home?.never) return home.never;
  const worktreeCd = worktreeCdReason(words, scope);
  if (worktreeCd) return worktreeCd;
  const pathReason = pathWordsReason(expanded, scope, home?.accepted) ?? chatDeleteReason(expanded, scope);
  if (pathReason) return pathReason;
  if (home?.unclassified) return HOME_PATH_NEVER;
  const prefix = commandPrefix(words);
  if (prefix.unparsed) return WRAPPER_SPLIT_NEVER;
  if (isDoctorFixForm(prefix.program) && (nested || !prefix.bare)) return DOCTOR_FIX_SPELLING;
  const programs = scope.chat ? chatPrograms(prefix.program) : [prefix.program];
  return programsReason(programs, { scope, maintenance: home?.kind === "maintenance" }) ?? hiddenGuardedReason(expanded);
}

// The first never reason of the program words a segment may run, or null.
function programsReason(programs, options) {
  for (const program of programs) {
    const reason = programReason(program, options);
    if (reason) return reason;
  }
  return null;
}

// The directory the next segment runs in: the one a `cd <dir>` segment moves to (a relative one from the last known directory), else the same.
function nextDir(words, { scope, base }) {
  if (words[0] !== "cd" || typeof words[1] !== "string") return scope.dir;
  const from = scope.dir ?? base;
  return wordPath(words[1], scope) ?? (from ? resolve(from, words[1]) : scope.dir);
}

// The directory the first segment's relative words resolve against: the cwd, unless it is the nightqueue home where the operator starts; a chat keeps it.
function firstSegmentDir(base, env, chat) {
  if (base === null || chat) return base;
  return insideRoots(canonicalPath(base), [canonicalPath(homeDir(env))]) ? null : base;
}

// Why one of the segments is in the never band, the first one found, or null; relative words resolve against the cwd, then each `cd`.
function segmentsReason(segments, { cwd, env, nested, allowDeletes, chat }) {
  const base = typeof cwd === "string" && isAbsolute(cwd) ? cwd : null;
  let dir = firstSegmentDir(base, env, chat);
  for (const { raw, words } of segments) {
    const scope = { dir, env, allowDeletes, chat };
    const reason = grepRawReason(raw, words) ?? segmentReason(words, { scope, nested });
    if (reason) return reason;
    dir = nextDir(words, { scope, base });
  }
  return null;
}

// Why a Bash command is in the never band, scanning every segment of it under one gh budget, or null when no segment is; `allowDeletes` frees file deletes only and reads words in chat mode.
export function neverBashReason(command, { cwd = null, env = process.env, nested = false, allowDeletes = false, chat = null } = {}) {
  if (typeof command !== "string") return null;
  const segments = shellSegments(command).map((raw) => ({ raw, words: segmentWords(raw) }));
  const mode = chat ?? (allowDeletes ? { worktree: null } : null);
  return withPrBudget(() => {
    if (!nested) prefetchPrStates(segments.map(({ words }) => words), env);
    const options = { cwd, env, nested, allowDeletes, chat: mode };
    const reason = segmentsReason(segments, options);
    return reason ?? (mode ? fedScriptReason(command, segments, { ...options, nested: true }) : null);
  });
}

// Tells whether the program words of one segment delete files: a delete, `git worktree remove|prune`, `git rm`, or one inside `eval` or a shell's `-c` text.
function programDeletes(words) {
  if (words.length === 0) return false;
  if (isHomeMaintenance(words)) return true;
  const program = programName(words[0]);
  if (program === "git") return gitSubcommand(words.slice(1)).subcommand === "rm";
  if (program === "eval") return commandDeletes(words.slice(1).join(" "));
  const scripts = SHELLS.has(program) ? (shellScriptWords(words) ?? []) : [];
  return scripts.some(commandDeletes);
}

// Tells whether any segment of a Bash command deletes files, past the wrappers that lead its program (the chat's extra ones included).
export function commandDeletes(command) {
  if (typeof command !== "string") return false;
  return shellSegments(command).some((raw) => chatPrograms(commandPrefix(segmentWords(raw)).program).some(programDeletes));
}

// Tells whether the words are a home maintenance command: a delete, or `git worktree remove|prune` in any spelling.
export function isHomeMaintenance(words) {
  if (deletes(words)) return true;
  if (programName(words[0]) !== "git") return false;
  const { subcommand, rest } = gitSubcommand(words.slice(1));
  return subcommand === "worktree" && WORKTREE_MAINTENANCE.has(rest[0]);
}
