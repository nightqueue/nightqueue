import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { homeDir, secretsPath, userHomeDir } from "../config/paths.mjs";
import { claudeConfigDir } from "../host/paths.mjs";
import { canonicalPath, insideRoots, isDeniedFlag, tokenize } from "./orchestrator-scope.mjs";
import {
  WORKTREE_MAINTENANCE,
  WORKTREE_READ_SPELLING,
  deletes,
  homeSegment,
  isWorktreeEntry,
  isWorktreeRead,
  isWorktreeSalvage,
  prefetchPrStates,
  programName,
  wordPath,
  worktreeArgJudged,
  worktreeCall,
  worktreeTrustRefusal,
} from "./operator-home.mjs";
import { withPrBudget } from "./operator-pr-budget.mjs";
import {
  DOTENV_NAME,
  GIT_READ_HARDENING,
  GIT_READ_SUBCOMMANDS,
  NIGHTQUEUE_PROGRAMS,
  OPERATOR_CLI_COMMANDS,
  bareTokens,
  checkoutRoots,
  commandPrefix,
  gitGlobals,
  gitReadAllowed,
  isDoctorFix,
  isDoctorFixForm,
  refusedNightqueueForm,
  registryNote,
  withoutTimeout,
} from "./operator-scope.mjs";

const SEGMENT_SEPARATORS = new Set([";", "&", "|", "(", ")", "\n", "\r"]);
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish"]);
const SETTINGS_FILE = /^settings.*\.json$/;
const SHELL_HOME_LITERALS = ["$HOME", "${HOME}", "$NIGHTQUEUE_HOME", "${NIGHTQUEUE_HOME}", "$CLAUDE_CONFIG_DIR", "${CLAUDE_CONFIG_DIR}"];
const HOME_LITERALS = [...SHELL_HOME_LITERALS, "~/.nightqueue"];
const NO_WORDS = new Set();
const HOME_MAINTENANCE = "home-maintenance";
const FORCE_PUSH_FLAGS = ["-f", "-d", "--force", "--delete", "--mirror", "--prune"];
const BRANCH_DELETE_FLAGS = ["-D", "-d", "--delete"];
const CD_ANCHOR = /^cd\s+("[^"]*"|'[^']*'|[^\s"'&;|]+)\s*&&\s*(\S[\s\S]*)$/;
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
const WORKTREE_READ_ONLY = `a worktree under the nightqueue home is only read as ${WORKTREE_READ_SPELLING}, salvaged with a git-write consent (\`git -C <worktree> format-patch\`, never \`stash\`) or removed with a home-maintenance consent`;

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
function protectedPathReason(target, env) {
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

// Why a path a word carries is in the never band; a home entry the segment's home use accepted is judged on everything but the home itself.
function pathFormReason(path, { accepted, env }) {
  return accepted ? protectedPathReason(canonicalPath(path), env) : neverWriteReason(path, env);
}

// Why the expanded words of a segment name a never-band path (secrets, the home, Claude/Codex settings, a `.git` directory), or null.
function pathWordsReason(words, scope, accepted = NO_WORDS) {
  for (const word of words) {
    if (namesSecret(word, scope)) return "reading or printing secrets";
    const literals = accepted.has(word) ? SHELL_HOME_LITERALS : HOME_LITERALS;
    if (literals.some((literal) => word.includes(literal))) return "naming the nightqueue home or the Claude/Codex settings";
    for (const form of pathForms(word)) {
      const path = wordPath(form, scope);
      const reason = path ? pathFormReason(path, { accepted: accepted.has(form), env: scope.env }) : null;
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
function gitGlobalNever(option) {
  return `a git global option other than \`-C <dir>\`, \`--no-optional-locks\`, \`--no-pager\` (\`${option}\`) injects config, hooks or paths`;
}

// Tells whether one argument of `git push` forces, deletes, mirrors or prunes (a `+` or `:` refspec included).
function forcePushArg(token) {
  if (token.startsWith("--force") || FORCE_PUSH_FLAGS.some((flag) => isDeniedFlag(token, flag))) return true;
  return !token.startsWith("-") && (token.startsWith("+") || token.startsWith(":"));
}

// Why a git command is in the never band (a global option off the allowlist, force push, branch delete, hard reset, clean, rm, a worktree removal by an unjudged path), or null.
function gitNeverReason(args) {
  const { refused } = gitGlobals(args);
  if (refused !== null) return gitGlobalNever(refused);
  const { subcommand, rest } = gitSubcommand(args);
  if (subcommand === "worktree" && WORKTREE_TARGETED.has(rest[0]) && !rest.slice(1).every(worktreeArgJudged)) return WORKTREE_BY_ABSOLUTE_PATH;
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
  if (isDoctorFixForm(words) && !isDoctorFix(words)) return DOCTOR_FIX_SPELLING;
  if (command === "verify") return null;
  if (command === "sandbox") return subcommand === "worktree" ? NIGHTQUEUE_NEVER : null;
  return OPERATOR_CLI_COMMANDS.refused.includes(command) || refusedNightqueueForm(words) ? NIGHTQUEUE_NEVER : null;
}

// Why the program words of a segment are in the never band, or null; a home maintenance delete is left to the consent band, a shell's `-c` text and `eval` are scanned in turn.
function programReason(words, { scope, maintenance }) {
  if (words.length === 0) return null;
  const program = programName(words[0]);
  if (deletes(words) && !maintenance) return "deleting files";
  if (program === "git") return gitNeverReason(words.slice(1));
  if (NIGHTQUEUE_PROGRAMS.has(program)) return nightqueueNeverReason(words);
  const nested = { cwd: scope.dir, env: scope.env, nested: true };
  if (program === "eval") return neverBashReason(words.slice(1).join(" "), nested);
  const inline = SHELLS.has(program) ? words.indexOf("-c") : -1;
  return inline === -1 ? null : neverBashReason(words[inline + 1] ?? "", nested);
}

// Why one segment is in the never band: its home use first, then the paths its words name, then its program.
function segmentReason(words, { scope, nested }) {
  const expanded = expandedWords(words);
  if (expanded === null) return "a brace expansion too large to check";
  const home = homeSegment(expanded, { start: programIndex(expanded), env: scope.env, nested });
  if (home?.never) return home.never;
  const pathReason = pathWordsReason(expanded, scope, home?.accepted);
  if (pathReason) return pathReason;
  if (home?.unclassified) return HOME_PATH_NEVER;
  const prefix = commandPrefix(words);
  if (prefix.unparsed) return WRAPPER_SPLIT_NEVER;
  if (isDoctorFixForm(prefix.program) && (nested || !prefix.bare)) return DOCTOR_FIX_SPELLING;
  return programReason(prefix.program, { scope, maintenance: home?.kind === "maintenance" }) ?? hiddenGuardedReason(expanded);
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

// Why one of the segments is in the never band, the first one found, or null; relative words resolve against the cwd, then each `cd`.
function segmentsReason(segments, { cwd, env, nested }) {
  const base = typeof cwd === "string" && isAbsolute(cwd) ? cwd : null;
  let dir = firstSegmentDir(base, env);
  for (const words of segments) {
    const scope = { dir, env };
    const reason = segmentReason(words, { scope, nested });
    if (reason) return reason;
    dir = nextDir(words, { scope, base });
  }
  return null;
}

// Why a Bash command is in the never band, scanning every segment of it under one gh budget, or null when no segment is.
export function neverBashReason(command, { cwd = null, env = process.env, nested = false } = {}) {
  if (typeof command !== "string") return null;
  const segments = shellSegments(command).map(segmentWords);
  return withPrBudget(() => {
    if (!nested) prefetchPrStates(segments, env);
    return segmentsReason(segments, { cwd, env, nested });
  });
}

// A quoted word without its quotes.
function unquoted(word) {
  return word.replace(/^(["'])(.*)\1$/, "$2");
}

// The command a consent scope names, a leading `cd <dir> &&` and `timeout <n>` dropped and every other wrapper kept, as its words; null when it is not one bare command.
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

// The consent of a git command in a worktree under the home: free for a read, git-write for `git -C <worktree> stash|format-patch`, else a shape refusal.
function worktreeGitConsent(words, { asRead, gitDir, argv, shown }, env) {
  const untrusted = worktreeTrustRefusal(gitDir, env);
  if (untrusted) return { shape: untrusted };
  if (isWorktreeRead(asRead, env)) return { free: true };
  if (isWorktreeSalvage(words, env)) return { kind: "git-write", dir: gitDir, argv, shown };
  return { shape: WORKTREE_READ_ONLY };
}

// The git consent of a command (`git [-C <dir>] <subcommand> …`), or free for a read of a checkout, or a shape refusal.
function gitConsent(words, { dir, rest }, env) {
  const globals = gitGlobals(words.slice(1));
  if (globals.refused !== null) return { shape: `\`git ${globals.refused}\` is refused: ${gitGlobalNever(globals.refused)}` };
  if (globals.dir !== null && !isAbsolute(globals.dir)) return { shape: "`git -C` takes an absolute directory" };
  const gitDir = globals.dir ?? dir;
  const argv = words.slice(1 + globals.index);
  const hardening = globals.hardened ? GIT_READ_HARDENING : [];
  const asRead = ["git", "-C", gitDir, ...hardening, ...(globals.noLocks ? ["--no-optional-locks"] : []), ...argv];
  if (isWorktreeEntry(gitDir, env)) return worktreeGitConsent(words, { asRead, gitDir, argv, shown: rest }, env);
  const outside = checkoutShape(gitDir, env);
  if (outside) return outside;
  if (gitReadAllowed(asRead, checkoutRoots(env).roots)) return { free: true };
  return { kind: "git-write", dir: gitDir, argv, shown: rest };
}

// Tells whether the words are a home maintenance command: a delete, or `git worktree remove|prune` in any spelling.
export function isHomeMaintenance(words) {
  if (deletes(words)) return true;
  if (programName(words[0]) !== "git") return false;
  const { subcommand, rest } = gitSubcommand(words.slice(1));
  return subcommand === "worktree" && WORKTREE_MAINTENANCE.has(rest[0]);
}

// Tells whether a directory may anchor home maintenance: a registered checkout, or for a delete also a worktree under the home or the home itself.
function maintenanceDirAllowed(dir, { env, home }) {
  if (typeof dir !== "string" || !isAbsolute(dir)) return false;
  if (insideRoots(dir, checkoutRoots(env).roots)) return true;
  return home && (isWorktreeEntry(dir, env) || canonicalPath(dir) === canonicalPath(homeDir(env)));
}

// The home-maintenance consent of a delete or a `git worktree remove|prune`, or the shape it refuses.
function homeMaintenanceConsent(argv, anchor, env) {
  if (programName(argv[0]) === "git") {
    const call = worktreeCall(argv);
    const gitDir = call?.gitDir ?? anchor.dir;
    if (!call || !maintenanceDirAllowed(gitDir, { env, home: false })) return { shape: "`git worktree remove|prune` runs in the project's checkout: `git -C <checkout> worktree prune`" };
    return { kind: HOME_MAINTENANCE, dir: anchor.dir, gitDir, argv, shown: anchor.rest };
  }
  if (!maintenanceDirAllowed(anchor.dir, { env, home: true })) return { shape: `${anchor.dir ?? "the session's directory"} is no registered checkout, worktree or the nightqueue home` };
  return { kind: HOME_MAINTENANCE, dir: anchor.dir, argv, shown: anchor.rest };
}

// What consent a Bash command needs (`{ kind, dir, argv, shown }`, `home: true` for `doctor --fix` from any directory), `{ free: true }` for a git read of a checkout, or `{ shape }` when it has no consentable form.
export function consentBash(command, { cwd = null, env = process.env } = {}) {
  if (typeof command !== "string" || command.trim() === "") return { shape: "the command is empty" };
  const anchor = commandAnchor(command.trim(), cwd);
  if (anchor.shape) return anchor;
  const words = bareTokens(anchor.rest);
  if (words === null || words.length === 0) return { shape: "the command chains, pipes or redirects, or carries a backslash" };
  if (hasGlob(anchor.rest)) return { shape: "the command carries a glob or brace character (`* ? [ ] { }`), so no consent can name what it touches" };
  if (isWrappedGuarded(words)) return { shape: WRAPPED_GUARDED };
  const argv = withoutTimeout(words);
  if (isHomeMaintenance(argv)) return homeMaintenanceConsent(argv, anchor, env);
  if (isDoctorFix(argv)) return { kind: "run", home: true, dir: anchor.dir, argv, shown: anchor.rest };
  if (argv[0] === "git") return gitConsent(argv, anchor, env);
  const outside = checkoutShape(anchor.dir, env);
  if (outside) return outside;
  return { kind: "run", dir: anchor.dir, argv, shown: anchor.rest };
}
