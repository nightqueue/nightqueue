import { existsSync, realpathSync, rmdirSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { runGitAsync } from "../host/git.mjs";
import { killProcess, probePid } from "./registry.mjs";
import { readRunState } from "./resume.mjs";
import { isPrUrl } from "./stream.mjs";
import { scratchFiles } from "../cli/scratch-files.mjs";
import { checkoutOfJob } from "../memory/registry-access.mjs";

export const WORKTREE_READ_TIMEOUT_MS = 5000;
export const WORKTREE_REMOVE_TIMEOUT_MS = 60000;
export const KEPT_PREFIX = "Worktree kept: ";
const DROPPED_NAMES_MAX = 10;
const LOCK_PID_RE = /\(pid (\d+)\b/;
const WORKTREE_FIELD = "worktree ";
const BRANCH_FIELD = "branch ";
const LOCKED_FIELD = "locked";
const PRUNABLE_FIELD = "prunable";

// The reason of a flag line such as `locked <reason>` or `prunable <reason>`, "" for a bare flag, or null when the line is another field.
function flagValue(line, field) {
  if (line === field) return "";
  return line.startsWith(`${field} `) ? line.slice(field.length + 1) : null;
}

// Parses `git worktree list --porcelain` (with or without `-z`) into one `{ path, branch, locked, prunable }` per worktree, the main one first.
export function parseWorktreeList(porcelain) {
  const text = String(porcelain ?? "");
  const entries = [];
  for (const line of text.split(text.includes("\0") ? "\0" : "\n")) {
    if (line.startsWith(WORKTREE_FIELD)) entries.push({ path: line.slice(WORKTREE_FIELD.length), branch: null, locked: null, prunable: null });
    const current = entries.at(-1);
    if (!current) continue;
    if (line.startsWith(BRANCH_FIELD)) current.branch = line.slice(BRANCH_FIELD.length);
    current.locked = flagValue(line, LOCKED_FIELD) ?? current.locked;
    current.prunable = flagValue(line, PRUNABLE_FIELD) ?? current.prunable;
  }
  return entries;
}

// The worktrees the given jobs name in the state of their run, canonical and mapped to `{ jobId, branch }`.
export function jobWorktreeOwners(jobs, env = process.env) {
  const owners = new Map();
  for (const job of Array.isArray(jobs) ? jobs : []) {
    const state = readRunState({ projectId: job.project_id, slug: job.slug, env });
    const path = typeof state?.worktree === "string" ? state.worktree.trim() : "";
    const branch = typeof state?.branch === "string" ? state.branch.trim() : "";
    if (path) owners.set(canonicalPath(path), { jobId: job.id, branch: branch || null });
  }
  return owners;
}

// The worktrees the jobs that are not closed name; an empty map when the queue cannot be read, so a failure never exempts anything.
export async function openJobWorktrees({ store, env = process.env } = {}) {
  try {
    return jobWorktreeOwners(await store.jobs.listOpenJobs(), env);
  } catch {
    return new Map();
  }
}

// The pid a lock reason names as its owner, or null when the reason names none.
export function lockPid(reason) {
  const match = LOCK_PID_RE.exec(String(reason ?? ""));
  const pid = match ? Number.parseInt(match[1], 10) : Number.NaN;
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

// Classifies the lock of a worktree entry: `none`, `live` (its pid answers), `stale` (its pid is gone) or `manual` (it names no pid).
export function lockState(entry, killImpl = killProcess) {
  if (entry?.locked === null || entry?.locked === undefined) return "none";
  const pid = lockPid(entry.locked);
  if (pid === null) return "manual";
  return probePid(pid, killImpl) === "gone" ? "stale" : "live";
}

// The canonical form of a path, every component resolved when it exists, so `/var` and `/private/var` compare equal.
export function canonicalPath(path) {
  const absolute = resolve(String(path ?? ""));
  try {
    return realpathSync(absolute);
  } catch {
    return absolute;
  }
}

// Tells whether two paths name the same directory once every component is resolved.
export function sameDir(a, b) {
  return canonicalPath(a) === canonicalPath(b);
}

// First line of a git message, short enough for a notice or a report line.
function firstLine(text) {
  return String(text ?? "").trim().split("\n")[0].slice(0, 200);
}

// Runs one read-only git call under the read timeout.
function gitRead(args, cwd, env) {
  return runGitAsync({ args, cwd, env, timeoutMs: WORKTREE_READ_TIMEOUT_MS });
}

// A worktree nightqueue keeps, with the reason it would refuse to remove it and the untracked QA scratch files it holds.
function kept(path, reason, scratch = []) {
  return scratch.length > 0 ? { path, removable: false, reason, scratch } : { path, removable: false, reason };
}

// The untracked QA scratch files a `git status --porcelain --untracked-files=all` lists.
function untrackedScratch(porcelain) {
  const untracked = String(porcelain ?? "")
    .split("\n")
    .filter((line) => line.startsWith("?? "))
    .map((line) => line.slice(3).replace(/^"(.*)"$/, "$1"));
  return scratchFiles(untracked);
}

// Why a locked worktree is kept, or null when its lock is gone or stale and does not hold it.
function lockReason(entry, lock) {
  if (lock === "live") return `it is locked by a live session (pid ${lockPid(entry.locked)})`;
  if (lock === "manual") return entry.locked ? `it is locked (${entry.locked})` : "it is locked";
  return null;
}

// Phrases the commits of a branch its upstream does not have yet.
function unpushedReason(count) {
  return count === 1 ? "its branch has 1 commit that was never pushed" : `its branch has ${count} commits that were never pushed`;
}

// Tells whether the branch of the worktree is published: an upstream exists and HEAD is not ahead of it; returns the reason when it is not.
async function publicationReason(path, env) {
  const upstream = await gitRead(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], path, env);
  if (!upstream.ok) return "its branch was never pushed";
  const ahead = await gitRead(["rev-list", "--count", "@{u}..HEAD"], path, env);
  const count = Number.parseInt(ahead.stdout.trim(), 10);
  if (!ahead.ok || !Number.isFinite(count)) return "git could not read it";
  return count > 0 ? unpushedReason(count) : null;
}

// Decides about one registered worktree: kept with a reason, or removable with whether its stale lock must go first.
async function judgeRegistered({ entry, path, prRecorded, env, killImpl }) {
  const lock = lockState(entry, killImpl);
  const locked = lockReason(entry, lock);
  if (locked) return kept(path, locked);
  const status = await gitRead(["status", "--porcelain", "--untracked-files=all"], path, env);
  if (!status.ok) return kept(path, "git could not read it");
  if (status.stdout.trim()) return kept(path, "it has uncommitted changes", untrackedScratch(status.stdout));
  const unpublished = prRecorded ? null : await publicationReason(path, env);
  return unpublished ? kept(path, unpublished) : { path, removable: true, staleLock: lock === "stale" };
}

// The entry of `path` among the linked worktrees of the checkout, or null when git does not register it there; the main worktree never counts.
async function linkedEntry(checkout, path, env) {
  const listed = await gitRead(["worktree", "list", "--porcelain"], checkout, env);
  if (!listed.ok) return { error: firstLine(listed.stderr) || "git worktree list failed" };
  const [, ...linked] = parseWorktreeList(listed.stdout);
  return { entry: linked.find((candidate) => sameDir(candidate.path, path)) ?? null };
}

// Tells whether a recorded worktree path is worth asking git about: absolute, on disk, and not the checkout itself.
function isCandidate(checkout, path) {
  if (typeof checkout !== "string" || !checkout || typeof path !== "string" || !isAbsolute(path)) return false;
  return existsSync(path) && !sameDir(path, checkout);
}

// Inspects the worktree of a run without changing anything: null when it is not a registered linked worktree of the checkout, else removable or kept with a reason.
export async function inspectRunWorktree({ checkout, path, prRecorded = false, env = process.env, killImpl = killProcess } = {}) {
  const target = typeof path === "string" ? path.trim() : "";
  if (!isCandidate(checkout, target)) return null;
  try {
    const listed = await linkedEntry(checkout, target, env);
    if (listed.error) return kept(target, `git could not list the worktrees of ${checkout} (${listed.error})`);
    if (!listed.entry) return null;
    return await judgeRegistered({ entry: listed.entry, path: target, prRecorded, env, killImpl });
  } catch (err) {
    return kept(target, `it could not be inspected (${err?.message ?? String(err)})`);
  }
}

// Removes a registered worktree from its checkout with a plain `git worktree remove`, unlocking a stale lock first; never forced, the branch is kept.
export async function removeRunWorktree({ checkout, path, staleLock = false, env = process.env } = {}) {
  if (staleLock) {
    const unlocked = await gitRead(["worktree", "unlock", path], checkout, env);
    if (!unlocked.ok) return { ok: false, reason: firstLine(unlocked.stderr) || "git worktree unlock failed" };
  }
  const removed = await runGitAsync({ args: ["worktree", "remove", path], cwd: checkout, env, timeoutMs: WORKTREE_REMOVE_TIMEOUT_MS });
  if (removed.ok || isWorktreeGone(path)) return { ok: true, reason: null };
  return { ok: false, reason: firstLine(removed.stderr) || "git worktree remove failed" };
}

// Removes a directory that holds nothing; throws when it is not empty or cannot be removed.
export function removeEmptyDir(dir) {
  rmdirSync(dir);
}

// The paths a `git status --porcelain` lists, as the names of what a removal drops: the first ten, then how many more.
export function droppedNames(porcelain) {
  const paths = String(porcelain ?? "")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => line.slice(3).replace(/^"(.*)"$/, "$1"));
  const shown = paths.slice(0, DROPPED_NAMES_MAX).join(", ");
  return paths.length > DROPPED_NAMES_MAX ? `${shown}, … and ${paths.length - DROPPED_NAMES_MAX} more` : shown;
}

// Removes a registered worktree with `git worktree remove --force` whatever its status, naming the uncommitted paths it drops; a lock held by a live session or set by hand keeps it. Only a settled close uses it, never the runner.
export async function forceRemoveRunWorktree({ checkout, path, env = process.env, killImpl = killProcess } = {}) {
  const listed = await linkedEntry(checkout, path, env);
  if (listed.error) return { ok: false, reason: listed.error, dropped: "" };
  if (!listed.entry) return { ok: false, reason: "git does not register it as a worktree of the checkout", dropped: "" };
  const lock = lockState(listed.entry, killImpl);
  const locked = lockReason(listed.entry, lock);
  if (locked) return { ok: false, reason: locked, dropped: "" };
  const status = await gitRead(["status", "--porcelain", "--untracked-files=all"], path, env);
  const dropped = status.ok ? droppedNames(status.stdout) : "";
  if (lock === "stale") await gitRead(["worktree", "unlock", path], checkout, env);
  const removed = await runGitAsync({ args: ["worktree", "remove", "--force", path], cwd: checkout, env, timeoutMs: WORKTREE_REMOVE_TIMEOUT_MS });
  if (removed.ok || isWorktreeGone(path)) return { ok: true, reason: null, dropped };
  return { ok: false, reason: firstLine(removed.stderr) || "git worktree remove --force failed", dropped: "" };
}

// Tells whether the directory of a worktree is no longer on disk, so a racing removal that got there first is not reported as kept.
function isWorktreeGone(path) {
  return typeof path === "string" && path !== "" && !existsSync(path);
}

// The close verdict for a worktree that was not removed here: `removed` when its directory is already gone, else kept with the reason.
function unremovedVerdict(path, reason) {
  return isWorktreeGone(path) ? { path, status: "removed" } : { path, status: "kept", reason };
}

// The notice line that names a worktree nightqueue kept, and why.
export function keptWorktreeLine({ path, reason, scratch }) {
  const left = Array.isArray(scratch) && scratch.length > 0 ? ` Untracked QA scratch files left in it: ${scratch.join(", ")}.` : "";
  return `${KEPT_PREFIX}${path} - ${reason}.${left}`;
}

// A notice without the kept-worktree paragraph a previous run appended at its end, so a resumed run never stacks it.
function withoutKeptLine(notice) {
  const text = typeof notice === "string" ? notice.trimEnd() : "";
  const cut = text.lastIndexOf("\n\n");
  const tail = cut < 0 ? text : text.slice(cut + 2);
  if (!tail.startsWith(KEPT_PREFIX)) return text;
  return cut < 0 ? "" : text.slice(0, cut).trimEnd();
}

// Appends the kept-worktree line to a notice, replacing an earlier one; a worktree that is absent or removable leaves the notice as it is.
export function withKeptWorktree(noticeMd, worktree) {
  if (!worktree || worktree.removable) return noticeMd;
  const base = withoutKeptLine(noticeMd);
  const line = keptWorktreeLine(worktree);
  return base ? `${base}\n\n${line}` : line;
}

// The notice a finish writes: the run's own, or the row's earlier one when the run produced none, with the kept-worktree line appended, never replacing either.
export function finishNotice({ runNotice, rowNotice, worktree }) {
  if (!worktree || worktree.removable) return runNotice;
  const hasRunNotice = typeof runNotice === "string" && runNotice.trim() !== "";
  return withKeptWorktree(hasRunNotice ? runNotice : rowNotice, worktree);
}

// The verdict of a forced removal: removed (naming what it dropped) or kept with the reason.
async function forceRelease({ checkout, path, env, killImpl }) {
  const removed = await forceRemoveRunWorktree({ checkout, path, env, killImpl });
  if (!removed.ok) return unremovedVerdict(path, removed.reason);
  return removed.dropped ? { path, status: "removed", dropped: removed.dropped } : { path, status: "removed" };
}

// The worktree a closed job's run recorded, removed when it is clean and published (or always with `force`, unless locked), else kept with its reason; null when the job has none. Never throws.
export async function releaseJobWorktree({ job, env = process.env, killImpl = killProcess, force = false } = {}) {
  let path = null;
  try {
    if (typeof job?.project !== "string" || !job.project || typeof job?.slug !== "string" || !job.slug) return null;
    const state = readRunState({ projectId: job.project_id, slug: job.slug, env });
    path = typeof state?.worktree === "string" && state.worktree.trim() ? state.worktree.trim() : null;
    if (!path) return null;
    const checkout = checkoutOfJob(job, env);
    if (!checkout) return { path, status: "kept", reason: `the project \`${job.project}\` is not registered` };
    const prRecorded = isPrUrl(job.pr_url) || isPrUrl(state?.outcome?.prUrl);
    const inspected = await inspectRunWorktree({ checkout, path, prRecorded, env, killImpl });
    if (!inspected) return null;
    if (force) return await forceRelease({ checkout, path, env, killImpl });
    if (!inspected.removable) return unremovedVerdict(path, inspected.reason);
    const removed = await removeRunWorktree({ checkout, path, staleLock: inspected.staleLock, env });
    return removed.ok ? { path, status: "removed" } : { path, status: "kept", reason: removed.reason };
  } catch (err) {
    return path ? unremovedVerdict(path, err?.message ?? String(err)) : null;
  }
}
