import { statSync } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { join, sep } from "node:path";
import { changedKinds, diffBase, parseNameStatus, parseNumstat, resultFiles, untrackedPaths } from "./diffstat.mjs";
import { gitOutput, readGit, worktreeOf } from "./git-read.mjs";
import { parseHunks } from "./hunks.mjs";

export const MAX_DIFF_BYTES = 1024 * 1024;
const MAX_PATH_CHARS = 4096;
const BINARY_SNIFF_BYTES = 8000;
const MERGE_SHA = /^[0-9a-f]{7,40}$/;
const SAFE_DIFF_FLAGS = ["--no-ext-diff", "--no-textconv", "-M"];
const RELEASED_NOTE = "diff unavailable — the worktree was released";
const NOT_REGULAR_NOTE = "not a regular file — no text diff";
const TOO_LONG_LINE_NOTE = "file too large to show — its first line exceeds 1 MiB";
export const BYTE_CAP_NOTE = "diff over 1 MiB — only its first part is shown; the rest is in the pull request";

// An answer with no lines to show, the given fields set on top.
function bodyless(meta, extra) {
  return { ...meta, adds: null, dels: null, hunks: [], truncated: false, binary: false, note: null, ...extra };
}

// The answer when no text diff can be read for a path, with the reason.
function unavailable(path, note) {
  return bodyless({ path, from: null, kind: null, source: "unavailable", base: null }, { note });
}

// The answer for a diff text: its non-empty hunks, its counts unless binary, truncated when either cap was hit, a note on a byte cut.
function textAnswer(meta, { text, cut, adds, dels, note = null }) {
  const { hunks, binary, capped } = parseHunks(text);
  const shown = hunks.filter((hunk) => hunk.lines.length > 0);
  const answerNote = note ?? (cut ? BYTE_CAP_NOTE : null);
  return { ...meta, adds: binary ? null : adds, dels: binary ? null : dels, hunks: shown, truncated: cut || capped, binary, note: answerNote };
}

// Whether a request path is a plausible repo path to look up: a non-empty string under 4096 chars without NUL.
function isLookupPath(path) {
  return typeof path === "string" && path.length > 0 && path.length <= MAX_PATH_CHARS && !path.includes("\0");
}

// A text cut to its last whole line within the byte cap, with whether anything was dropped.
function byteCapped(text) {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= MAX_DIFF_BYTES) return { text, truncated: false };
  const head = bytes.subarray(0, MAX_DIFF_BYTES).toString("utf8");
  return { text: head.slice(0, head.lastIndexOf("\n") + 1), truncated: true };
}

// The number of lines of a text, a final line without newline included.
function lineCount(text) {
  if (text === "") return 0;
  return text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
}

// The unified diff of an untracked file's content: every line added from an empty file.
export function addedFileDiff(text) {
  if (text === "") return "";
  const lines = text.split("\n");
  const endsInNewline = lines[lines.length - 1] === "";
  if (endsInNewline) lines.pop();
  const body = lines.map((line) => `+${line}`);
  if (!endsInNewline) body.push("\\ No newline at end of file");
  return [`@@ -0,0 +1,${lines.length} @@`, ...body].join("\n") + "\n";
}

// Up to the byte cap of a file, plus whether the file is longer.
async function readHead(file) {
  const handle = await open(file, "r");
  try {
    const { size } = await handle.stat();
    const buffer = Buffer.alloc(Math.min(size, MAX_DIFF_BYTES));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return { bytes: buffer.subarray(0, bytesRead), longer: size > MAX_DIFF_BYTES };
  } finally {
    await handle.close();
  }
}

// The diff of an untracked file read from disk, only when it is a regular file inside the worktree.
async function untrackedDiff(cwd, path, base) {
  const file = join(cwd, path);
  if (!(await lstat(file)).isFile()) return unavailable(path, NOT_REGULAR_NOTE);
  if (!(await realpath(file)).startsWith((await realpath(cwd)) + sep)) return unavailable(path, NOT_REGULAR_NOTE);
  const meta = { path, from: null, kind: "new", source: "worktree", base };
  const { bytes, longer } = await readHead(file);
  if (bytes.subarray(0, BINARY_SNIFF_BYTES).includes(0)) return bodyless(meta, { binary: true });
  if (bytes.length === 0) return bodyless(meta, { adds: 0, dels: 0, note: "empty file" });
  const text = bytes.toString("utf8");
  const whole = longer ? text.slice(0, text.lastIndexOf("\n") + 1) : text;
  const { text: diff, truncated } = byteCapped(addedFileDiff(whole));
  const counts = longer ? { adds: null, dels: null } : { adds: lineCount(whole), dels: 0 };
  return textAnswer(meta, { text: diff, cut: longer || truncated, ...counts, note: diff === "" ? TOO_LONG_LINE_NOTE : null });
}

// The diff of one tracked path over a git range, a rename read as one rename diff from its old name, with its numstat counts.
async function rangeDiff({ cwd, path, named, range, meta, env }) {
  const paths = named.from ? [named.from, path] : [path];
  const literal = { ...env, GIT_LITERAL_PATHSPECS: "1" };
  const numstat = await gitOutput(cwd, ["diff", "--numstat", ...SAFE_DIFF_FLAGS, "-z", ...range, "--", ...paths], literal);
  const counted = parseNumstat(numstat).find((file) => file.path === path);
  const { text, truncated } = byteCapped(await gitOutput(cwd, ["diff", "--no-color", ...SAFE_DIFF_FLAGS, ...range, "--", ...paths], literal));
  const answerMeta = { ...meta, path, from: named.from ?? null, kind: named.kind };
  return textAnswer(answerMeta, { text, cut: truncated, adds: counted?.added ?? null, dels: counted?.deleted ?? null });
}

// The diff of one path in a live worktree, null when the job's diff does not list that exact path.
async function worktreeFileDiff(job, cwd, { path, env }) {
  const { base, mergeBase } = await diffBase(cwd, env);
  const named = (await changedKinds(cwd, mergeBase, env)).get(path);
  if (named) return rangeDiff({ cwd, path, named, range: [mergeBase], meta: { source: "worktree", base }, env });
  if ((await untrackedPaths(cwd, env)).includes(path)) return untrackedDiff(cwd, path, base);
  return resultFiles(job).includes(path) ? unavailable(path, "no change left against the base (already merged?)") : null;
}

// The merge commit a closed job recorded, null unless it is a plain hex sha.
function mergeShaOf(job) {
  const sha = job?.close?.data?.mergeSha;
  return typeof sha === "string" && MERGE_SHA.test(sha) ? sha : null;
}

// Whether a path names an existing directory.
function isDirectory(path) {
  try {
    return typeof path === "string" && path !== "" && statSync(path).isDirectory();
  } catch {
    return false;
  }
}

// The diff of one path in a merge commit against its first parent, read from the project checkout without fetching or writing.
async function mergeFileDiff({ checkout, sha, path, env }) {
  if (!(await readGit(checkout, ["rev-parse", "--verify", "--quiet", `${sha}^{commit}`], env)).ok) return unavailable(path, `the merge commit ${sha.slice(0, 7)} is not in the local checkout`);
  const range = [`${sha}^1`, sha];
  const named = parseNameStatus(await gitOutput(checkout, ["diff", "--name-status", ...SAFE_DIFF_FLAGS, "-z", ...range], env)).get(path);
  if (!named) return unavailable(path, "no change to this file in the merge commit");
  return rangeDiff({ cwd: checkout, path, named, range, meta: { source: "merge", base: `${sha.slice(0, 7)}^1` }, env });
}

// The diff of a recorded file once the worktree is gone: from the merge commit when there is one, else unavailable; null for any other path.
async function releasedFileDiff(job, path, env) {
  if (!resultFiles(job).includes(path)) return null;
  const sha = mergeShaOf(job);
  if (!sha || !isDirectory(job?.project_path)) return unavailable(path, RELEASED_NOTE);
  try {
    return await mergeFileDiff({ checkout: job.project_path, sha, path, env });
  } catch (err) {
    return unavailable(path, `the project checkout could not be read: ${err?.message ?? String(err)}`);
  }
}

// The diff of one file a job changed, read from its worktree or its merge commit without writing anything; null when the path is not one of the job's files.
export async function jobFileDiff(job, path, env = process.env) {
  if (!isLookupPath(path)) return null;
  const cwd = worktreeOf(job, env);
  if (!cwd) return releasedFileDiff(job, path, env);
  try {
    return await worktreeFileDiff(job, cwd, { path, env });
  } catch (err) {
    return unavailable(path, `the worktree could not be read: ${err?.message ?? String(err)}`);
  }
}
