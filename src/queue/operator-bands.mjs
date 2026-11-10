import { isAbsolute } from "node:path";
import { homeDir } from "../config/paths.mjs";
import { WRAPPED_GUARDED, gitGlobalNever, hasGlob, isHomeMaintenance, isWrappedGuarded } from "../host/never-band.mjs";
import { canonicalPath, insideRoots } from "./orchestrator-scope.mjs";
import {
  WORKTREE_READ_SPELLING,
  isWorktreeEntry,
  isWorktreeRead,
  isWorktreeSalvage,
  programName,
  worktreeCall,
  worktreeTrustRefusal,
} from "./operator-home.mjs";
import {
  GIT_READ_HARDENING,
  bareTokens,
  checkoutRoots,
  expandsUnquoted,
  gitGlobals,
  gitGrepIndex,
  gitReadAllowed,
  hasUnterminatedQuote,
  isDoctorFix,
  registryNote,
  withoutTimeout,
} from "./operator-scope.mjs";

export { GREP_HARDENED_SPELLING } from "./operator-scope.mjs";
export { WRAPPED_GUARDED, hasGlob, isHomeMaintenance, isWrappedGuarded, neverBashReason, neverWriteReason } from "../host/never-band.mjs";

const HOME_MAINTENANCE = "home-maintenance";
const CD_ANCHOR = /^cd\s+("[^"]*"|'[^']*'|[^\s"'&;|]+)\s*&&\s*(\S[\s\S]*)$/;
const GLOB_SHAPE = "the command carries a glob or brace character (`* ? [ ] { }`), so no consent can name what it touches";
export const UNTERMINATED_QUOTE_SHAPE = "a quote (`'`, `\"` or `$'`) is never closed, so zsh would read the rest of the command as quoted text: close it";
export const CHAIN_SHAPE =
  "the command chains, pipes or redirects outside quotes (an unquoted `; & | < > $` or backtick), carries a backslash, or quotes words the guard cannot align";
const UNQUOTED_GLOB_SHAPE =
  "the command carries a glob or brace character (`* ? [ ] { }`) or a leading `^` that zsh expands unquoted: it is not free and no consent can name what it touches; quote it (`'HEAD@{1}'`, `-- '*.md'`)";
const WORKTREE_READ_ONLY = `a worktree under the nightqueue home is only read as ${WORKTREE_READ_SPELLING}, salvaged with a git-write consent (\`git -C <worktree> format-patch\`, never \`stash\`) or removed with a home-maintenance consent`;

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

// The global words of a git command with every `-C <dir>` pair removed.
function withoutDirs(globalWords) {
  return globalWords.filter((word, index) => word !== "-C" && globalWords[index - 1] !== "-C");
}

// The words a git command is judged as a read by, under `-C <gitDir>`: a grep's own global words verbatim, any other read rebuilt from its flags.
function readSpelling(globalWords, { globals, gitDir, argv }) {
  if (argv[0] === "grep") return ["git", "-C", gitDir, ...withoutDirs(globalWords), ...argv];
  const hardening = globals.hardened ? GIT_READ_HARDENING : [];
  return ["git", "-C", gitDir, ...hardening, ...(globals.noLocks ? ["--no-optional-locks"] : []), ...argv];
}

// The git consent of a command (`git [-C <dir>] <subcommand> …`), or free for a read of a checkout, or a shape refusal.
function gitConsent(words, { dir, rest }, env) {
  const globals = gitGlobals(words.slice(1));
  if (globals.refused !== null) return { shape: `\`git ${globals.refused}\` is refused: ${gitGlobalNever(globals.refused)}` };
  if (globals.dir !== null && !isAbsolute(globals.dir)) return { shape: "`git -C` takes an absolute directory" };
  const gitDir = globals.dir ?? dir;
  const argv = words.slice(1 + globals.index);
  const asRead = readSpelling(words.slice(1, 1 + globals.index), { globals, gitDir, argv });
  if (isWorktreeEntry(gitDir, env)) return worktreeGitConsent(words, { asRead, gitDir, argv, shown: rest }, env);
  const outside = checkoutShape(gitDir, env);
  if (outside) return outside;
  if (gitReadAllowed(asRead, checkoutRoots(env).roots)) return { free: true };
  return { kind: "git-write", dir: gitDir, argv, shown: rest };
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

// The shape refusal of a command carrying a glob or brace character: a hint to quote it when zsh would expand it, else that no consent names it.
function globShape(rest, words) {
  return expandsUnquoted(rest, words) ? UNQUOTED_GLOB_SHAPE : GLOB_SHAPE;
}

// A free git consent kept only when zsh expands none of the command's judged words, else the shape that says to quote them.
function expansionChecked(consent, rest, words) {
  return consent.free === true && expandsUnquoted(rest, words) ? { shape: UNQUOTED_GLOB_SHAPE } : consent;
}

// The free answer of a bare hardened git grep whose quoted pattern or pathspec carries a glob character, or null when it is not one.
function freeGrepRead(words, anchor, env) {
  const argv = withoutTimeout(words);
  if (isWrappedGuarded(words) || argv[0] !== "git" || gitGrepIndex(argv) === -1) return null;
  const consent = gitConsent(argv, anchor, env);
  return consent.free === true ? consent : null;
}

// What consent a Bash command needs (`{ kind, dir, argv, shown }`, `home: true` for `doctor --fix` from any directory), `{ free: true }` for a git read of a checkout, or `{ shape }` when it has no consentable form.
export function consentBash(command, { cwd = null, env = process.env } = {}) {
  if (typeof command !== "string" || command.trim() === "") return { shape: "the command is empty" };
  if (hasUnterminatedQuote(command)) return { shape: UNTERMINATED_QUOTE_SHAPE };
  const anchor = commandAnchor(command.trim(), cwd);
  if (anchor.shape) return anchor;
  const words = bareTokens(anchor.rest);
  if (words === null || words.length === 0) return { shape: CHAIN_SHAPE };
  if (hasGlob(anchor.rest)) return freeGrepRead(words, anchor, env) ?? { shape: globShape(anchor.rest, words) };
  if (isWrappedGuarded(words)) return { shape: WRAPPED_GUARDED };
  const argv = withoutTimeout(words);
  if (isHomeMaintenance(argv)) return homeMaintenanceConsent(argv, anchor, env);
  if (isDoctorFix(argv)) return { kind: "run", home: true, dir: anchor.dir, argv, shown: anchor.rest };
  if (argv[0] === "git") return expansionChecked(gitConsent(argv, anchor, env), anchor.rest, words);
  const outside = checkoutShape(anchor.dir, env);
  if (outside) return outside;
  return { kind: "run", dir: anchor.dir, argv, shown: anchor.rest };
}
