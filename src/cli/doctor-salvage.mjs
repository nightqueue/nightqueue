import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { salvageDir } from "../config/paths.mjs";
import { DETACHED_WORK_PREFIX } from "../queue/worktree.mjs";
import { compactStamp } from "../queue/runner.mjs";
import { firstLine } from "./report.mjs";

const SALVAGE_TIMEOUT_MS = 120000;
const LIST_MAX_BUFFER = 64 * 1024 * 1024;
const FILTER_KEY_RE = /^filter\.(.+)\.[^.]+$/;
const FILTER_SETTINGS = [
  ["clean", ""],
  ["smudge", ""],
  ["process", ""],
  ["required", "false"],
];
const BASE_OVERRIDES = [
  ["core.fsmonitor", "false"],
  ["core.hooksPath", "/dev/null"],
];
const PATCH_FILE = "changes.patch";
const UNTRACKED_LIST = "untracked.list";
const UNTRACKED_ARCHIVE = "untracked.tar.gz";
const CONTENT_ARCHIVE = "content.tar.gz";
const HEAD_FILE = "head.txt";

// The reason a command failed, from its first error line or its exit status.
function failureOf(result, what) {
  return `${what} failed (${firstLine(result.stderr) || `exit ${result.status}`})`;
}

// The filter names a `git config -z --list` output defines, includes followed.
function filterNames(listing) {
  const keys = String(listing ?? "").split("\0").map((entry) => entry.split("\n")[0]);
  return [...new Set(keys.map((key) => FILTER_KEY_RE.exec(key)?.[1]).filter(Boolean))];
}

// The GIT_CONFIG_* variables that pin every override, safe for any character a name holds.
function configEnv(overrides) {
  const vars = { GIT_CONFIG_COUNT: String(overrides.length) };
  overrides.forEach(([key, value], index) => {
    vars[`GIT_CONFIG_KEY_${index}`] = key;
    vars[`GIT_CONFIG_VALUE_${index}`] = value;
  });
  return vars;
}

// A git runner for one orphan that no configured filter, fsmonitor or hook can run through, or the reason git could not read its config.
export function neutralGit({ run, env, dir }) {
  const listed = run("git", ["-C", dir, "config", "-z", "--list"], { env });
  if (!listed.ok) return { error: failureOf(listed, "git config --list") };
  const filters = filterNames(listed.stdout).flatMap((name) => FILTER_SETTINGS.map(([setting, value]) => [`filter.${name}.${setting}`, value]));
  const neutralEnv = { ...env, ...configEnv([...BASE_OVERRIDES, ...filters]) };
  const git = (args, options = {}) => run("git", ["-C", dir, ...args], { env: neutralEnv, timeout: SALVAGE_TIMEOUT_MS, ...options });
  return { git, env: neutralEnv };
}

// Why a detached HEAD must be kept: commits no branch, tag or remote reaches; null on a branch or with nothing to lose.
export function detachedWork(git, entry) {
  if (entry.branch !== null) return null;
  const listed = git(["rev-list", "--count", "HEAD", "--not", "--branches", "--tags", "--remotes"]);
  const count = listed.ok ? Number.parseInt(listed.stdout.trim(), 10) : Number.NaN;
  if (!Number.isFinite(count)) return "git could not count the commits of its detached HEAD";
  return count > 0 ? `${DETACHED_WORK_PREFIX}${count} commit(s) on no branch` : null;
}

// The directory one salvage of an orphan is written to, stamped so two salvages never collide.
export function salvageDest({ env, projectId, name }) {
  return join(salvageDir(env), projectId, `${name}-${compactStamp()}`);
}

// Tells whether a salvage file was written with content.
function hasContent(path) {
  try {
    return statSync(path).size > 0;
  } catch {
    return false;
  }
}

// Writes the tracked changes against HEAD as a binary patch; answers whether one was saved, or the reason it failed.
function savePatch(git, dest) {
  const path = join(dest, PATCH_FILE);
  const diffed = git(["diff", "--binary", "--no-textconv", "--no-ext-diff", "--ignore-submodules=all", `--output=${path}`, "HEAD"]);
  if (!diffed.ok) return { error: failureOf(diffed, "git diff") };
  if (hasContent(path)) return { saved: true };
  rmSync(path, { force: true });
  return { saved: false };
}

// The tar options that store every name with the bytes it has on disk; bsdtar otherwise rewrites a unicode name to another normalization.
function exactNameOptions(run) {
  const version = run("tar", ["--version"], { timeout: SALVAGE_TIMEOUT_MS });
  return version.ok && /bsdtar/.test(version.stdout) ? ["--format", "pax", "--options", "hdrcharset=BINARY"] : [];
}

// Writes a gzipped archive of the given tar inputs taken from `dir`; answers the tar result.
function packArchive({ run, archive, dir, inputs }) {
  return run("tar", ["-czf", archive, ...exactNameOptions(run), "-C", dir, ...inputs], { timeout: SALVAGE_TIMEOUT_MS });
}

// The paths one `git ls-files` listing answers, or the reason it failed.
function listedPaths(git, args) {
  const listed = git(["ls-files", ...args, "-z"], { maxBuffer: LIST_MAX_BUFFER });
  if (!listed.ok) return { error: failureOf(listed, `git ls-files ${args.join(" ")}`) };
  return { paths: listed.stdout.split("\0").filter(Boolean) };
}

// The submodule paths the index of a checkout names, checked out or not.
function submodulePaths(git) {
  const listed = listedPaths(git, ["--stage"]);
  if (listed.error) return listed;
  return { paths: listed.paths.filter((entry) => entry.startsWith("160000 ")).map((entry) => entry.slice(entry.indexOf("\t") + 1)) };
}

// Tells whether a checked out submodule holds anything uncommitted, its own submodules included, with git neutralized inside it.
function isDirtyCheckout({ run, env, dir }) {
  const neutral = neutralGit({ run, env, dir });
  if (neutral.error) return { error: neutral.error };
  const status = neutral.git(["status", "--porcelain", "-z", "--ignore-submodules=all"], { maxBuffer: LIST_MAX_BUFFER });
  if (!status.ok) return { error: failureOf(status, "git status") };
  if (status.stdout !== "") return { dirty: true };
  const nested = dirtySubmodules({ git: neutral.git, run, env, dir });
  return nested.error ? nested : { dirty: nested.paths.length > 0 };
}

// The checked out submodules of a checkout that hold anything uncommitted, or the reason git could not tell.
function dirtySubmodules({ git, run, env, dir }) {
  const listed = submodulePaths(git);
  if (listed.error) return listed;
  const dirty = [];
  for (const path of listed.paths.filter((candidate) => existsSync(join(dir, candidate, ".git")))) {
    const checked = isDirtyCheckout({ run, env, dir: join(dir, path) });
    if (checked.error) return { error: `submodule ${path}: ${checked.error}` };
    if (checked.dirty) dirty.push(path);
  }
  return { paths: dirty };
}

// What the archive of an orphan holds: its untracked files, its ignored files outside a wholly ignored directory, and its dirty submodules; or the reason git could not list them.
function archivePaths({ git, run, env, dir }) {
  const untracked = listedPaths(git, ["--others", "--exclude-standard"]);
  const ignored = listedPaths(git, ["--others", "--ignored", "--exclude-standard", "--directory"]);
  const submodules = dirtySubmodules({ git, run, env, dir });
  const failed = [untracked, ignored, submodules].find((listing) => listing.error);
  if (failed) return failed;
  return { paths: [...untracked.paths, ...ignored.paths.filter((path) => !path.endsWith("/")), ...submodules.paths] };
}

// Archives what an orphan holds outside its tracked files; answers whether an archive was saved, or the reason it failed.
function saveUntracked({ git, run, env, dir, dest }) {
  const listed = archivePaths({ git, run, env, dir });
  if (listed.error) return listed;
  if (!listed.paths.length) return { saved: false };
  const list = join(dest, UNTRACKED_LIST);
  writeFileSync(list, listed.paths.map((path) => `./${path}\0`).join(""));
  const archive = join(dest, UNTRACKED_ARCHIVE);
  const packed = packArchive({ run, archive, dir, inputs: ["--null", "-T", list] });
  if (!packed.ok || !hasContent(archive)) return { error: failureOf(packed, "tar") };
  return { saved: true };
}

// Records the branch and commit the orphan was on, so the patch can be applied to the right base.
function saveHead(git, dest) {
  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]).stdout.trim() || "unknown";
  const sha = git(["rev-parse", "HEAD"]).stdout.trim() || "unknown";
  writeFileSync(join(dest, HEAD_FILE), `branch ${branch}\nhead ${sha}\n`);
}

// Runs the two salvage steps of a registered orphan and names what each saved.
function saveRegistered({ git, run, env, dir, dest }) {
  const patch = savePatch(git, dest);
  if (patch.error) return patch;
  const untracked = saveUntracked({ git, run, env, dir, dest });
  if (untracked.error) return untracked;
  return { saved: [patch.saved && PATCH_FILE, untracked.saved && UNTRACKED_ARCHIVE].filter(Boolean) };
}

// Saves what a registered orphan holds uncommitted under `dest`; `{ saved, dest }` with no directory left when nothing was uncommitted, or `{ error, dest }`.
export function salvageRegistered({ git, run, env = process.env, dir, dest }) {
  try {
    mkdirSync(dest, { recursive: true });
    const result = saveRegistered({ git, run, env, dir, dest });
    if (result.error) return { error: result.error, dest };
    if (!result.saved.length) {
      rmSync(dest, { recursive: true, force: true });
      return { saved: [], dest: null };
    }
    saveHead(git, dest);
    return { saved: result.saved, dest };
  } catch (err) {
    return { error: `the salvage could not be written (${err?.message ?? String(err)})`, dest };
  }
}

// Removes an orphaned directory under the home once its salvage was written; throws when it cannot.
export function removeOrphanDir(dir) {
  rmSync(dir, { recursive: true, force: true });
}

// Archives everything a directory git cannot read holds besides its `.git` link; `{ saved, dest }` or `{ error, dest }`.
export function salvageUnreadable({ run, dir, dest }) {
  try {
    const entries = readdirSync(dir).filter((entry) => entry !== ".git");
    if (!entries.length) return { saved: [], dest: null };
    mkdirSync(dest, { recursive: true });
    const archive = join(dest, CONTENT_ARCHIVE);
    const packed = packArchive({ run, archive, dir, inputs: entries.map((entry) => `./${entry}`) });
    if (!packed.ok || !existsSync(archive)) return { error: failureOf(packed, "tar"), dest };
    return { saved: [CONTENT_ARCHIVE], dest };
  } catch (err) {
    return { error: `the salvage could not be written (${err?.message ?? String(err)})`, dest };
  }
}
