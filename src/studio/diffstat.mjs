import { baseOf, gitOutput, worktreeOf } from "./git-read.mjs";

const RELEASED_NOTE = "worktree released — names from the run's result, no line counts";
const NONE_NOTE = "no worktree and no recorded files yet";
const MERGED_NOTE = "no change left against the base (already merged?) — names from the run's result, no line counts";
const DIFF_FLAGS = ["-M", "--no-ext-diff", "--no-textconv", "-z"];
const NUMSTAT_ENTRY = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/;

// A count of `--numstat`, null for a binary file's `-`.
function countOf(text) {
  return /^\d+$/.test(text) ? Number(text) : null;
}

// The files of a `diff --numstat -M -z` output, one `{ path, added, deleted }` each; a rename's path is its new name.
export function parseNumstat(stdout) {
  const tokens = stdout.split("\0");
  const files = [];
  for (let at = 0; at < tokens.length; at += 1) {
    const match = NUMSTAT_ENTRY.exec(tokens[at]);
    if (!match) continue;
    const [, added, deleted, inline] = match;
    const path = inline === "" ? tokens[at + 2] : inline;
    if (inline === "") at += 2;
    if (path) files.push({ path, added: countOf(added), deleted: countOf(deleted) });
  }
  return files;
}

// The kind of change a `--name-status` letter names: new, mod, del or ren.
function kindOf(status) {
  if (status.startsWith("R")) return "ren";
  if (status.startsWith("C") || status === "A") return "new";
  if (status === "D") return "del";
  return "mod";
}

// The kinds of a `diff --name-status -M -z` output by path, with the old name of a rename.
export function parseNameStatus(stdout) {
  const tokens = stdout.split("\0");
  const kinds = new Map();
  let at = 0;
  while (at < tokens.length) {
    const status = tokens[at];
    if (!/^[A-Z]\d*$/.test(status)) {
      at += 1;
      continue;
    }
    const twoPaths = status.startsWith("R") || status.startsWith("C");
    const from = twoPaths ? tokens[at + 1] : null;
    const path = twoPaths ? tokens[at + 2] : tokens[at + 1];
    at += twoPaths ? 3 : 2;
    if (path) kinds.set(path, { kind: kindOf(status), from: kindOf(status) === "ren" ? from : null });
  }
  return kinds;
}

// The counted files joined with their kinds; a path git did not classify is a modification.
function withKinds(counted, kinds) {
  return counted.map((file) => {
    const named = kinds.get(file.path);
    if (!named) return { ...file, kind: "mod" };
    return named.from ? { ...file, kind: named.kind, from: named.from } : { ...file, kind: named.kind };
  });
}

// The sums of the counted lines, a binary or untracked file adding nothing.
function totalsOf(files) {
  return files.reduce((sum, file) => ({ added: sum.added + (file.added ?? 0), deleted: sum.deleted + (file.deleted ?? 0) }), { added: 0, deleted: 0 });
}

// The base branch of a worktree and the commit its diff is taken against: the merge base of that branch with HEAD.
export async function diffBase(cwd, env) {
  const base = await baseOf(cwd, env);
  const mergeBase = (await gitOutput(cwd, ["merge-base", base, "HEAD"], env)).trim();
  return { base, mergeBase };
}

// The kinds of every tracked file changed since the merge base, by path.
export async function changedKinds(cwd, mergeBase, env) {
  return parseNameStatus(await gitOutput(cwd, ["diff", "--name-status", ...DIFF_FLAGS, mergeBase], env));
}

// The untracked files git would not ignore in a worktree.
export async function untrackedPaths(cwd, env) {
  return (await gitOutput(cwd, ["ls-files", "--others", "--exclude-standard", "-z"], env)).split("\0").filter(Boolean);
}

// The diffstat of a live worktree against the merge base with its base branch, the uncommitted edits and untracked files included.
async function worktreeDiffstat(cwd, env) {
  const { base, mergeBase } = await diffBase(cwd, env);
  const counted = parseNumstat(await gitOutput(cwd, ["diff", "--numstat", ...DIFF_FLAGS, mergeBase], env));
  const changed = withKinds(counted, await changedKinds(cwd, mergeBase, env));
  const untracked = (await untrackedPaths(cwd, env)).map((path) => ({ path, added: null, deleted: null, untracked: true, kind: "new" }));
  const files = [...changed, ...untracked];
  return { source: "worktree", base, files, totals: totalsOf(changed), note: null };
}

// The repo-relative files the finished run recorded in its result, an empty list when it has none.
export function resultFiles(job) {
  try {
    const result = typeof job?.result === "string" ? JSON.parse(job.result) : job?.result;
    const files = Array.isArray(result?.files) ? result.files : [];
    return files.filter((path) => typeof path === "string" && path.trim());
  } catch {
    return [];
  }
}

// The names-only answer when no worktree can be read: the run's recorded files, or nothing.
function recordedDiffstat(job, note) {
  const files = resultFiles(job).map((path) => ({ path, added: null, deleted: null, kind: null }));
  if (files.length === 0) return { source: "none", base: null, files: [], totals: null, note: note ?? NONE_NOTE };
  return { source: "recorded", base: null, files, totals: null, note: note ?? RELEASED_NOTE };
}

// The files a job touched with their line counts and kinds, read from its worktree without writing anything; names only once the worktree is gone.
export async function jobDiffstat(job, env = process.env) {
  const cwd = worktreeOf(job, env);
  if (!cwd) return recordedDiffstat(job, null);
  try {
    const live = await worktreeDiffstat(cwd, env);
    return live.files.length === 0 && resultFiles(job).length > 0 ? recordedDiffstat(job, MERGED_NOTE) : live;
  } catch (err) {
    return recordedDiffstat(job, `the worktree could not be read: ${err?.message ?? String(err)}`);
  }
}
