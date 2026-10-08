import { lstat, open, realpath } from "node:fs/promises";
import { join, sep } from "node:path";
import { changedKinds, diffBase, resultFiles, untrackedPaths } from "./diffstat.mjs";
import { gitOutput, worktreeOf } from "./git-read.mjs";

export const MAX_DIFF_BYTES = 1024 * 1024;
const MAX_PATH_CHARS = 4096;
const BINARY_SNIFF_BYTES = 8000;
const BINARY_LINE = /^Binary files .* differ$/m;
const RELEASED_NOTE = "diff unavailable — the worktree was released";
const NOT_REGULAR_NOTE = "not a regular file — no text diff";
const TOO_LONG_LINE_NOTE = "file too large to show — its first line exceeds 1 MiB";

// The answer when no text diff can be read for a path, with the reason.
function unavailable(path, note) {
  return { path, from: null, kind: null, source: "unavailable", base: null, untracked: false, binary: false, truncated: false, diff: null, note };
}

// Whether a request path is a plausible repo path to look up: a non-empty string under 4096 chars without NUL.
function isLookupPath(path) {
  return typeof path === "string" && path.length > 0 && path.length <= MAX_PATH_CHARS && !path.includes("\0");
}

// A text cut to its last whole line within the byte cap, with whether anything was dropped.
function capped(text) {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= MAX_DIFF_BYTES) return { text, truncated: false };
  const head = bytes.subarray(0, MAX_DIFF_BYTES).toString("utf8");
  return { text: head.slice(0, head.lastIndexOf("\n") + 1), truncated: true };
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
  const answer = { path, from: null, kind: "new", source: "worktree", base, untracked: true, binary: false, truncated: false, diff: "", note: null };
  const { bytes, longer } = await readHead(file);
  if (bytes.subarray(0, BINARY_SNIFF_BYTES).includes(0)) return { ...answer, binary: true };
  if (bytes.length === 0) return { ...answer, note: "empty file" };
  const text = bytes.toString("utf8");
  const whole = longer ? text.slice(0, text.lastIndexOf("\n") + 1) : text;
  const { text: diff, truncated } = capped(addedFileDiff(whole));
  const note = diff === "" ? TOO_LONG_LINE_NOTE : null;
  return { ...answer, diff, truncated: longer || truncated, note };
}

// The diff of a tracked file against the merge base, a rename read as one rename diff from its old name.
async function trackedDiff({ cwd, path, named, base, mergeBase, env }) {
  const paths = named.from ? [named.from, path] : [path];
  const args = ["diff", "--no-color", "--no-ext-diff", "--no-textconv", "-M", mergeBase, "--", ...paths];
  const { text, truncated } = capped(await gitOutput(cwd, args, { ...env, GIT_LITERAL_PATHSPECS: "1" }));
  const binary = BINARY_LINE.test(text);
  return { path, from: named.from ?? null, kind: named.kind, source: "worktree", base, untracked: false, binary, truncated, diff: text, note: null };
}

// The diff of one path in a live worktree, null when the job's diff does not list that exact path.
async function worktreeFileDiff(job, cwd, { path, env }) {
  const { base, mergeBase } = await diffBase(cwd, env);
  const named = (await changedKinds(cwd, mergeBase, env)).get(path);
  if (named) return trackedDiff({ cwd, path, named, base, mergeBase, env });
  if ((await untrackedPaths(cwd, env)).includes(path)) return untrackedDiff(cwd, path, base);
  return resultFiles(job).includes(path) ? unavailable(path, "no change left against the base (already merged?)") : null;
}

// The diff of one file a job changed, read from its worktree without writing anything; null when the path is not one of the job's files.
export async function jobFileDiff(job, path, env = process.env) {
  if (!isLookupPath(path)) return null;
  const cwd = worktreeOf(job, env);
  if (!cwd) return resultFiles(job).includes(path) ? unavailable(path, RELEASED_NOTE) : null;
  try {
    return await worktreeFileDiff(job, cwd, { path, env });
  } catch (err) {
    return unavailable(path, `the worktree could not be read: ${err?.message ?? String(err)}`);
  }
}
