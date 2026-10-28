import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { isId } from "../config/ids.mjs";
import { homeDir, userHomeDir } from "../config/paths.mjs";
import { listHomeHolders } from "../memory/jobs.mjs";
import { jobRef } from "../memory/refs.mjs";
import { registeredCheckouts, withRegistry } from "../memory/registry-access.mjs";
import {
  GIT_READ_HARDENING,
  IGNORE_SUBMODULES,
  gitGlobals,
  gitReadAllowed,
  grepDirSpelling,
  grepSpellingNever,
  isBarePrefix,
  isSubmoduleArg,
  opensWithHardening,
  programName,
} from "./operator-scope.mjs";
import { prStates } from "./operator-pr-budget.mjs";
import { canonicalPath } from "./orchestrator-scope.mjs";
import { flattenPrState, prStateKey } from "./pr-state.mjs";
import { killProcess, probePid } from "./registry.mjs";
import { isSafeSegment, readRunState } from "./resume.mjs";
import { lockPid } from "./worktree.mjs";

export { programName };

export const DELETERS = new Set(["rm", "rmdir", "unlink", "shred"]);
export const WORKTREE_MAINTENANCE = new Set(["remove", "prune"]);
const WORKTREE_FORCE = new Set(["-f", "--force"]);
const PRUNE_FLAGS = new Set(["-n", "-v", "--dry-run", "--verbose"]);
const PRUNE_EXPIRE = "--expire";
const EXEC_FLAGS = new Set(["-exec", "-execdir", "-ok", "-okdir"]);
const MAINTENANCE_ROOTS = new Set(["runs", "worktrees"]);
const ENTRY_DEPTH = 2;
const GIT_DIR_NAME = ".git";
const ONE_ENTRY =
  "deleting under the nightqueue home: one run dir or worktree per command (`rm -rf <dir>`, `find <dir> -delete`); clean in bulk with `nightqueue doctor --fix` or `git worktree prune`";
const ONE_BARE_COMMAND = "home maintenance runs as one bare command, never behind a wrapper, an env assignment or an inline shell";
const HOLDING_STATUSES = new Set(["pending", "running", "gate"]);
const SALVAGE_REFUSED_STATUSES = new Set(["done", "failed"]);
const PR_HOLD_WORDS = { open: "is open", unknown: "is open", draft: "is a draft", conflicted: "has conflicts" };
const STASH_SAVES = new Set(["push", "save"]);
const COPY_OPTION = /^-[rRpafnv]+$/;
const ABSENT_FILE_CODES = new Set(["ENOENT", "ENOTDIR", "EISDIR"]);
const GITDIR_LINE = /^gitdir:\s*(.+)$/m;
const NON_LITERAL_HOME =
  "a path under the nightqueue home with a `.` or `..` component; name a run dir or worktree by its literal absolute path";
const ADMIN_DIRS = "worktrees";
const NO_LOCKS = "--no-optional-locks";
const HARDENED_GIT = "git -C <worktree> -c core.fsmonitor=false -c core.hooksPath=/dev/null";
export const WORKTREE_READ_SPELLING = `\`${HARDENED_GIT} [${NO_LOCKS}] <read>\` (\`status\` and \`diff\` with \`${IGNORE_SUBMODULES}\`; \`grep\` only as ${grepDirSpelling("<worktree>")})`;
const WORKTREE_READ_HARDENED = `a worktree under the nightqueue home is read only hardened, so no program the job planted runs: ${WORKTREE_READ_SPELLING}, never another \`--submodule*\` or \`--recurse-submodules\``;
const WORKTREE_NEVER_STASHED =
  "a worktree under the nightqueue home is never stashed: `git stash` runs the clean filter of a nested repo the job planted, whatever the hardening; salvage it with `git -C <worktree> format-patch` or `cp`";

// A word as an absolute path, `~` expanded and a relative path with a slash resolved against the segment's directory, or null.
export function wordPath(word, { dir, env }) {
  if (word === "~" || word.startsWith("~/")) return join(userHomeDir(env), word.slice(1));
  if (isAbsolute(word)) return word;
  return word.includes("/") && dir ? resolve(dir, word) : null;
}

// Tells whether the words delete files: a deleting program, `find … -delete`, or a deleting program after `-exec`.
export function deletes(words) {
  const program = programName(words[0]);
  if (DELETERS.has(program)) return true;
  if (program === "find" && words.includes("-delete")) return true;
  return words.some((word, index) => EXEC_FLAGS.has(word) && DELETERS.has(programName(words[index + 1])));
}

// The path below a root, as a relative path, or null when it does not lie there.
function restUnder(root, path) {
  const rest = relative(root, path);
  return isAbsolute(rest) || rest.split(sep)[0] === ".." ? null : rest;
}

// The real path of a path as the filesystem stores its names (the stored case on a case-insensitive volume), its missing rest appended.
function storedPath(path) {
  const absolute = resolve(path);
  let existing = absolute;
  while (!existsSync(existing) && dirname(existing) !== existing) existing = dirname(existing);
  try {
    return join(realpathSync.native(existing), relative(existing, absolute));
  } catch {
    return canonicalPath(absolute);
  }
}

// A path stored as on disk, its leaf kept as written when it is a link so the link is not followed.
function storedLeaf(path) {
  const leaf = join(storedPath(dirname(path)), basename(path));
  return isLink(leaf) ? leaf : storedPath(leaf);
}

// A path folded for a spelling compare: Unicode-normalized and lower-cased, as a case-insensitive volume compares names.
function folded(path) {
  return path.normalize("NFC").toLowerCase();
}

// Tells whether a path is a symbolic link; a missing path is not one.
function isLink(path) {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

// Why a path under runs/ or worktrees/ is no single entry a command may touch, or null when it is one.
function entryRefusal(segments, canonical) {
  const [root, projectId, slug] = segments;
  if (!MAINTENANCE_ROOTS.has(root)) return "writing under the nightqueue home";
  if (segments.length - 1 < ENTRY_DEPTH) return "a whole directory of the nightqueue home; only one run dir or worktree is ever a target";
  if (!isId(projectId) || !isSafeSegment(slug)) return "a path under the nightqueue home that is no run dir or worktree";
  if (segments.includes(GIT_DIR_NAME)) return "a repository's `.git` directory (its config and hooks run commands)";
  if (isLink(canonical)) return "a link under the nightqueue home";
  return null;
}

// Classifies an absolute path under the home: null outside it, `{ never }` for anything but a run dir or worktree (or below one), else the entry.
export function homeEntry(path, env = process.env) {
  if (typeof path !== "string" || !isAbsolute(path)) return null;
  const lexical = resolve(path);
  const storedHome = storedPath(homeDir(env));
  const canonical = storedLeaf(lexical);
  const canonicalRest = restUnder(storedHome, canonical);
  if (canonicalRest === null) return null;
  const lexicalRest = restUnder(folded(resolve(homeDir(env))), folded(lexical)) ?? restUnder(folded(storedHome), folded(lexical));
  if (lexicalRest !== folded(canonicalRest)) return { never: "a path that reaches the nightqueue home through a link" };
  const segments = canonicalRest === "" ? [""] : canonicalRest.split(sep);
  const refusal = entryRefusal(segments, canonical);
  if (refusal) return { never: refusal };
  const [root, projectId, slug] = segments;
  return { root, projectId, slug, depth: segments.length - 1, canonical };
}

// Tells whether a directory is a worktree entry under the home (the worktree itself or below it).
export function isWorktreeEntry(dir, env = process.env) {
  const entry = homeEntry(dir, env);
  return Boolean(entry && !entry.never && entry.root === "worktrees");
}

// Tells whether a word names a path literally: no `.` or `..` component the shell would resolve through links.
function literalPath(word) {
  return !word.split("/").some((part) => part === "." || part === "..");
}

// Tells whether an argument of `git worktree remove|move` is judged: a force flag, or an absolute literal path that is no link.
export function worktreeArgJudged(word) {
  if (WORKTREE_FORCE.has(word)) return true;
  return typeof word === "string" && isAbsolute(word) && literalPath(word) && !isLink(resolve(word));
}

// Tells whether `git worktree prune` arguments are only its dry-run, verbose and expire options.
function pruneArgsValid(rest) {
  for (let index = 0; index < rest.length; index += 1) {
    const word = rest[index];
    if (word === PRUNE_EXPIRE && rest[index + 1] === undefined) return false;
    if (word === PRUNE_EXPIRE) index += 1;
    else if (!PRUNE_FLAGS.has(word) && !word.startsWith(`${PRUNE_EXPIRE}=`)) return false;
  }
  return true;
}

// The index of the one worktree `git worktree remove` arguments name (from `at`), or -1 when they are not force flags and one absolute literal path.
function removeTargetIndex(words, at) {
  const targets = words.map((word, index) => (index >= at && !WORKTREE_FORCE.has(word) ? index : -1)).filter((index) => index !== -1);
  return targets.length === 1 && worktreeArgJudged(words[targets[0]]) ? targets[0] : -1;
}

// The `git [-C <abs dir>] worktree remove [-f] <abs worktree>|prune [-n] [-v] [--expire <t>]` call of git words, or null when the words are not that exact shape.
export function worktreeCall(words) {
  if (!Array.isArray(words)) return null;
  const hasDir = words[1] === "-C";
  const at = hasDir ? 3 : 1;
  const op = words[at + 1];
  if (programName(words[0]) !== "git" || words[at] !== "worktree" || !WORKTREE_MAINTENANCE.has(op)) return null;
  if (hasDir && !isAbsolute(words[2] ?? "")) return null;
  const rest = words.slice(at + 2);
  const targetIndex = op === "remove" ? removeTargetIndex(words, at + 2) : -1;
  const valid = op === "remove" ? targetIndex !== -1 : pruneArgsValid(rest);
  return valid ? { gitDir: hasDir ? words[2] : null, op, rest, targetIndex } : null;
}

// The never hit of a non-literal word that lands under the home, lexically or through its links; null when it does not.
function nonLiteralHit(path, env) {
  return homeEntry(path, env) || homeEntry(canonicalPath(path), env) ? { never: NON_LITERAL_HOME } : null;
}

// The home entries the program words name, by word index: only absolute or `~/` words, a relative one is left to the never band.
function homeHits(program, env) {
  const hits = new Map();
  program.forEach((word, index) => {
    if (!(isAbsolute(word) || word.startsWith("~/"))) return;
    const path = wordPath(word, { dir: null, env });
    const entry = literalPath(word) ? homeEntry(path, env) : nonLiteralHit(path, env);
    if (entry) hits.set(index, entry);
  });
  return hits;
}

// Tells whether a hit is a usable entry under `root` (any root when null), exactly one entry deep or, with `below`, at least.
function isEntry(entry, { root = null, below = false } = {}) {
  if (!entry || entry.never || (root !== null && entry.root !== root)) return false;
  return below ? entry.depth >= ENTRY_DEPTH : entry.depth === ENTRY_DEPTH;
}

// The indexes of the words from `from` on that are no option.
function positionalIndexes(program, from) {
  return program.map((word, index) => (index >= from && !word.startsWith("-") ? index : -1)).filter((index) => index !== -1);
}

// The classification of a delete naming home entries: maintenance for one run dir or worktree, never otherwise.
function deleteSegment(program, hits) {
  const isFind = programName(program[0]) === "find";
  const targets = isFind ? (program.length === 3 && program[2] === "-delete" ? [1] : []) : positionalIndexes(program, 1);
  const single = targets.length === 1 && hits.size === 1 && isEntry(hits.get(targets[0]));
  return single ? { kind: "maintenance", targets: [hits.get(targets[0])] } : { never: ONE_ENTRY };
}

// The classification of `git worktree remove` naming home entries: maintenance when it removes one worktree and its git dir is no home path.
function worktreeSegment(program, hits) {
  const call = worktreeCall(program);
  if (!call || call.op !== "remove" || hits.size !== 1) return null;
  const target = hits.get(call.targetIndex);
  return isEntry(target, { root: "worktrees" }) ? { kind: "maintenance", targets: [target] } : null;
}

// The worktree entry a `git -C <dir>` names at its root, the `-C` dir being the only home hit; null otherwise.
function worktreeRootHit(program, hits) {
  if (programName(program[0]) !== "git" || program[1] !== "-C" || hits.size !== 1) return null;
  const entry = hits.get(2);
  return isEntry(entry, { root: "worktrees" }) ? entry : null;
}

// A classification kept only when git's admin dir of the worktree is trusted, else the never of the untrusted pointer.
function trustedWorktree(entry, env, result) {
  const admin = worktreeAdmin(entry, env);
  return admin.refused ? { never: admin.refused } : result;
}

// Tells whether git words past the global options are a read of a directory: `stash list`, or an allowed read of it.
function isGitRead(argv, { dir, noLocks }) {
  if (argv[0] === "stash") return argv.length === 2 && argv[1] === "list";
  return gitReadAllowed(["git", "-C", dir, ...GIT_READ_HARDENING, ...(noLocks ? [NO_LOCKS] : []), ...argv], [canonicalPath(dir)]);
}

// Tells whether a read keeps out of submodules: `status` and `diff` carry exactly `--ignore-submodules=all`, any other read no submodule option.
function submodulesIgnored([subcommand, ...args]) {
  const steering = args.filter(isSubmoduleArg);
  if (subcommand !== "status" && subcommand !== "diff") return steering.length === 0;
  return steering.length === 1 && steering[0] === IGNORE_SUBMODULES;
}

// Tells whether the global options of a worktree read are exactly the hardened spelling: `-C <worktree>`, the hardening block, then `--no-optional-locks` when present.
function hardenedGlobals(globalWords, { dir, noLocks }) {
  const expected = ["-C", dir, ...GIT_READ_HARDENING, ...(noLocks ? [NO_LOCKS] : [])];
  return globalWords.length === expected.length && expected.every((word, index) => globalWords[index] === word);
}

// The classification of a git grep of a worktree under the home: read for the one free hardened spelling, else never with its reason.
function worktreeGrepRead(program) {
  const never = grepSpellingNever(program.slice(3));
  return never === null ? { kind: "read" } : { never };
}

// The classification of a git read of a worktree under the home (`stash list` included): read when hardened, never when not or for an untrusted pointer, else null.
function worktreeReadSegment(program, hits, env) {
  const entry = worktreeRootHit(program, hits);
  if (!entry) return null;
  const globals = gitGlobals(program.slice(1));
  if (globals.refused !== null) return null;
  const argv = program.slice(1 + globals.index);
  if (argv[0] === "grep") return trustedWorktree(entry, env, worktreeGrepRead(program));
  const spelling = { dir: program[2], noLocks: globals.noLocks };
  if (!isGitRead(argv, spelling)) return null;
  const hardened = hardenedGlobals(program.slice(1, 1 + globals.index), spelling) && submodulesIgnored(argv);
  return trustedWorktree(entry, env, hardened ? { kind: "read" } : { never: WORKTREE_READ_HARDENED });
}

// The run dir or worktree an entry hit lies in (the hit itself at entry depth), so ownership is judged on the entry and not a path below it.
function entryTop(entry) {
  let canonical = entry.canonical;
  for (let depth = entry.depth; depth > ENTRY_DEPTH; depth -= 1) canonical = dirname(canonical);
  return { ...entry, depth: ENTRY_DEPTH, canonical };
}

// The classification of a salvage from a worktree under the home (`git -C <worktree> [<read hardening>] format-patch …`): salvage, never for any stash (`stash [push|save] …`), or null.
function worktreeSalvageSegment(program, hits, env) {
  const entry = worktreeRootHit(program, hits);
  if (!entry) return null;
  const hardened = opensWithHardening(program.slice(3));
  const [subcommand, mode] = program.slice(hardened ? 3 + GIT_READ_HARDENING.length : 3);
  const stashes = subcommand === "stash" && (mode === undefined || mode.startsWith("-") || STASH_SAVES.has(mode));
  if (!stashes && subcommand !== "format-patch") return null;
  return trustedWorktree(entry, env, stashes ? { never: WORKTREE_NEVER_STASHED } : { kind: "salvage", targets: [entry] });
}

// The classification of a `cp` out of run dirs or worktrees: salvage when every home path is a source and the destination lies outside the home, else null.
function copySegment(program, hits) {
  const options = program.slice(1).filter((word) => word.startsWith("-"));
  const positionals = positionalIndexes(program, 1);
  if (positionals.length < 2 || !options.every((option) => COPY_OPTION.test(option)) || hits.has(positionals.at(-1))) return null;
  const sources = [...hits.values()];
  return sources.every((entry) => isEntry(entry, { below: true })) ? { kind: "salvage", targets: sources.map(entryTop) } : null;
}

// Tells whether git words salvage a worktree under the home: `git -C <worktree> [<read hardening>] format-patch …`.
export function isWorktreeSalvage(words, env = process.env) {
  return Array.isArray(words) && worktreeSalvageSegment(words, homeHits(words, env), env)?.kind === "salvage";
}

// Tells whether git words only read a worktree under the home, hardened: `git -C <worktree> <read hardening> [--no-optional-locks] <read>`.
export function isWorktreeRead(words, env = process.env) {
  return Array.isArray(words) && worktreeReadSegment(words, homeHits(words, env), env)?.kind === "read";
}

// Why git may not run in a worktree entry (or a directory below it) because its `.git` leaves git's admin dir, or null when it may.
export function worktreeTrustRefusal(dir, env = process.env) {
  const entry = homeEntry(dir, env);
  if (!entry || entry.never || entry.root !== "worktrees") return null;
  return worktreeAdmin(entryTop(entry), env).refused ?? null;
}

// The run dirs and worktrees the words name (or lie below), each as its home entry.
export function homeTargets(words, env = process.env) {
  return Array.isArray(words) ? [...homeHits(words, env).values()].filter((entry) => !entry.never) : [];
}

// Tells whether the words have a home-maintenance form: a delete, or the strict `git [-C <abs dir>] worktree remove|prune`.
export function homeMaintenanceForm(words) {
  return Array.isArray(words) && (deletes(words) || worktreeCall(words) !== null);
}

// The program words' kind of home use, before the bare check: read for a `cd` or a git read, maintenance for a delete or a worktree removal, salvage for a copy out, null otherwise.
function segmentKind(program, hits, env) {
  const name = programName(program[0]);
  if (name === "cd") return program.length === 2 && isEntry(hits.get(1), { below: true }) ? { kind: "read" } : null;
  if (deletes(program)) return deleteSegment(program, hits);
  if (name === "cp") return copySegment(program, hits);
  if (name === "git") return worktreeSegment(program, hits) ?? worktreeSalvageSegment(program, hits, env) ?? worktreeReadSegment(program, hits, env);
  return null;
}

// A text file's content, or null when it does not exist; any other read failure is thrown.
function readOptional(path) {
  try {
    return readFileSync(path, "utf8");
  } catch (err) {
    if (ABSENT_FILE_CODES.has(err?.code)) return null;
    throw err;
  }
}

// The names of a directory, none when it does not exist; any other read failure is thrown.
function optionalNames(dir) {
  try {
    return readdirSync(dir);
  } catch (err) {
    if (ABSENT_FILE_CODES.has(err?.code)) return [];
    throw err;
  }
}

// The stored path a file of git's names (its content resolved against the file's directory), or null when the file is absent or empty.
function pathInFile(file) {
  const text = readOptional(file)?.trim();
  return text ? storedPath(resolve(dirname(file), text)) : null;
}

// The `.git` dir of the registered checkout of a project, stored as on disk, or null when the project has no checkout.
function checkoutGitDir(projectId, env) {
  const checkout = registeredCheckouts(env).find((project) => project.id === projectId)?.path;
  return typeof checkout === "string" && checkout !== "" ? storedPath(join(checkout, GIT_DIR_NAME)) : null;
}

// The admin dirs git keeps in the checkout for a worktree entry: those of `<checkout>/.git/worktrees` whose `gitdir` points back to the entry's `.git`.
function adminDirs(entry, checkoutGit) {
  const pointer = join(entry.canonical, GIT_DIR_NAME);
  const root = join(checkoutGit, ADMIN_DIRS);
  return optionalNames(root).map((name) => join(root, name)).filter((admin) => pathInFile(join(admin, "gitdir")) === pointer);
}

// The admin dir the entry's own `.git` file points to, or null when `.git` is no regular file with a `gitdir:` line.
function pointedAdmin(entry) {
  const pointer = join(entry.canonical, GIT_DIR_NAME);
  if (!lstatSync(pointer, { throwIfNoEntry: false })?.isFile()) return null;
  const line = GITDIR_LINE.exec(readOptional(pointer) ?? "");
  return line ? storedPath(resolve(entry.canonical, line[1].trim())) : null;
}

// The admin dir of a worktree entry that both git's back-pointer and the entry's `.git` name, its common dir the checkout's `.git`; null when none is.
function trustedAdmin(entry, env) {
  const checkoutGit = checkoutGitDir(entry.projectId, env);
  if (!checkoutGit) return null;
  const pointed = pointedAdmin(entry);
  const admin = adminDirs(entry, checkoutGit).find((dir) => dir === pointed);
  return admin && pathInFile(join(admin, "commondir")) === checkoutGit ? admin : null;
}

// git's own admin dir of a worktree entry as `{ admin }`, or `{ refused }` when the entry's `.git` does not point to it or that cannot be read.
export function worktreeAdmin(entry, env = process.env) {
  const pointer = join(entry.canonical, GIT_DIR_NAME);
  try {
    const admin = trustedAdmin(entry, env);
    if (admin) return { admin };
  } catch (err) {
    return { refused: `${pointer} cannot be checked against git's admin dir in the project's checkout (${err?.message ?? String(err)})` };
  }
  return {
    refused: `${pointer} does not point to the admin dir git keeps for it in the project's checkout (\`.git/worktrees\`); a git command there would run a configuration the job controls`,
  };
}

// The lock reason git keeps for a worktree entry in its checkout's admin dirs ("" for a bare lock), or null when none is locked.
function worktreeLockReason(entry, env) {
  const checkoutGit = checkoutGitDir(entry.projectId, env);
  if (!checkoutGit) return null;
  for (const admin of adminDirs(entry, checkoutGit)) {
    const locked = readOptional(join(admin, "locked"));
    if (locked !== null) return locked.trim();
  }
  return null;
}

// Why a live process or a hand lock still holds a worktree entry, or null when its lock is absent or stale.
function lockReason(entry, env) {
  const reason = worktreeLockReason(entry, env);
  if (reason === null) return null;
  const pid = lockPid(reason);
  if (pid === null) return `${entry.canonical} is locked by hand${reason ? ` (${reason})` : ""}`;
  return probePid(pid, killProcess) === "gone" ? null : `${entry.canonical} is held by a live process (pid ${pid})`;
}

// The job rows of the entry's project that may hold it; a home with no database has none.
function holderRows(entry, env) {
  const rows = withRegistry(env, (db) => (db ? listHomeHolders(entry.projectId, env, db) : []));
  return Array.isArray(rows) ? rows : [];
}

// The worktrees a job row names besides its slug, canonical: the one it was queued to start in and the one its run state holds.
function linkedWorktrees(row, entry, env) {
  const state = row.slug ? readRunState({ projectId: entry.projectId, slug: row.slug, env }) : null;
  return [row.start_worktree, state?.worktree].filter((path) => typeof path === "string" && path.trim() !== "").map((path) => storedPath(path.trim()));
}

// Tells whether a job row owns an entry: by its slug, or for a worktree by one of its linked worktrees.
function ownsEntry(row, entry, env) {
  if (row.slug === entry.slug) return true;
  return entry.root === "worktrees" && linkedWorktrees(row, entry, env).includes(entry.canonical);
}

// Tells whether a job row still holds what it owns: an open status or a close in flight.
function isHolding(row) {
  return HOLDING_STATUSES.has(row.status) || row.close_status === "closing";
}

// The ref and status of a holding job, a close in flight named.
function holderLabel(row) {
  const status = row.close_status === "closing" ? `${row.status}, being closed` : row.status;
  return `${jobRef(row.id)} (${status})`;
}

// Why a salvage may not copy from an entry: a done or failed job, not closed nor cancelled, still owns it; null otherwise.
function salvageReason(rows, entry, env) {
  const owner = rows.find((row) => SALVAGE_REFUSED_STATUSES.has(row.status) && ownsEntry(row, entry, env));
  return owner ? `salvage copies from a closed or cancelled job; ${entry.canonical} belongs to ${holderLabel(owner)}` : null;
}

// Tells whether a job row is done with a pull request URL recorded.
function isDoneWithPr(row) {
  return row.status === "done" && typeof row.pr_url === "string" && row.pr_url.trim() !== "";
}

// The GitHub pull request URLs of the done jobs among rows; one not on GitHub is left out, since gh cannot read it.
function githubPrUrls(rows) {
  return rows.filter(isDoneWithPr).map((row) => row.pr_url.trim()).filter((url) => prStateKey(url) !== null);
}

// The state of a done job's pull request among the states read, or why it cannot be told.
function prView(url, states) {
  if (!prStateKey(url)) return { ok: false, why: "it is not a GitHub pull request URL" };
  return states.get(url) ?? { ok: false, why: "gh answered no readable pull request state" };
}

// Why a done job's pull request still holds what the job owns, an unreadable state counted as open; null once it is merged or closed.
function pendingPr(view) {
  const state = flattenPrState(view);
  if (state === "merged" || state === "closed") return null;
  return PR_HOLD_WORDS[state] ?? `could not be confirmed merged or closed: ${view.why ?? "gh answered no readable pull request state"}`;
}

// Why a done job of the entry still holds it while its pull request is not merged or closed, or null when none does.
function prHoldReason(rows, entry, env) {
  const owners = rows.filter((row) => isDoneWithPr(row) && ownsEntry(row, entry, env));
  if (owners.length === 0) return null;
  const states = prStates(githubPrUrls(owners), env);
  for (const row of owners) {
    const url = row.pr_url.trim();
    const pending = pendingPr(prView(url, states));
    if (pending) return `${entry.canonical} belongs to ${jobRef(row.id)} (done, pull request ${url} ${pending})`;
  }
  return null;
}

// The GitHub pull request URLs of the done jobs that own an entry.
function ownerPrUrls(entry, env) {
  if (!entry || entry.never || !entry.projectId) return [];
  return githubPrUrls(holderRows(entry, env).filter((row) => ownsEntry(row, entry, env)));
}

// Reads at once the pull request states of the done jobs owning an entry the segments' words name, so a chained command spends the guard's gh budget once; answers false when it could not, the owner check that follows then reads them itself.
export function prefetchPrStates(wordLists, env = process.env) {
  try {
    const urls = wordLists.flatMap((words) => [...homeHits(words, env).values()].flatMap((entry) => ownerPrUrls(entry, env)));
    prStates(urls, env);
    return true;
  } catch {
    return false;
  }
}

// Why a job of the entry's project still holds it (for a salvage, also a done or failed owner; otherwise a done owner whose pull request is not merged or closed), or null when none does.
function jobReason(entry, { env, salvage }) {
  const rows = holderRows(entry, env);
  const choosing = rows.find((row) => row.status === "running" && !row.slug);
  if (choosing) return `${jobRef(choosing.id)} (running) is still choosing its run directory in this project`;
  const holder = rows.find((row) => isHolding(row) && ownsEntry(row, entry, env));
  if (holder) return `${entry.canonical} belongs to ${holderLabel(holder)}`;
  return salvage ? salvageReason(rows, entry, env) : prHoldReason(rows, entry, env);
}

// Runs one ownership read, a failure turned into a refusal so an unreadable owner never counts as no owner.
function checkedRead(entry, { what, read }) {
  try {
    return read();
  } catch (err) {
    return `who holds ${entry.canonical} cannot be checked: ${what} could not be read (${err?.message ?? String(err)})`;
  }
}

// Why a run dir or worktree may not be removed (or, with `salvage`, copied from) now: a job or a live process holds it, or that cannot be checked; null when nothing holds it.
export function homeOwner(entry, env = process.env, { salvage = false } = {}) {
  if (!entry || entry.never) return entry?.never ?? "no run dir or worktree to check";
  const held = checkedRead(entry, { what: "the queue", read: () => jobReason(entry, { env, salvage }) });
  if (held || entry.root !== "worktrees") return held;
  return checkedRead(entry, { what: "its worktree lock", read: () => lockReason(entry, env) });
}

// The first reason a target is still held, or null when none is.
function heldReason(targets, { env, salvage }) {
  for (const target of targets) {
    const reason = homeOwner(target, env, { salvage });
    if (reason) return reason;
  }
  return null;
}

// Classifies one shell segment that names home entries: `{ kind, accepted }` (read, maintenance or salvage), `{ never }`, `{ unclassified }` when it names one in no such use, or null when it names none.
export function homeSegment(words, { start = 0, env = process.env, nested = false } = {}) {
  if (!Array.isArray(words)) return null;
  const program = words.slice(start);
  const hits = homeHits(program, env);
  if (hits.size === 0) return null;
  const result = segmentKind(program, hits, env);
  if (!result) return { unclassified: true };
  if (result.never) return result;
  if (result.kind !== "read" && (nested || !isBarePrefix(words.slice(0, start)))) return { never: ONE_BARE_COMMAND };
  const held = heldReason(result.targets ?? [], { env, salvage: result.kind === "salvage" });
  if (held) return { never: held };
  return { kind: result.kind, accepted: new Set([...hits.keys()].map((index) => program[index])) };
}
