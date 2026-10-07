// Best-effort reader of which recalled refs a run went on to use: a hit counts as applied when its ref is cited, as a
// whole token, in a run artifact of the asking phase or later, or in a commit message of the job's worktree. Read-only
// and local (D-24): a ref cited only in a PR body, or in commits after the worktree was removed, is not seen.
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { runDir } from "../config/paths.mjs";
import { isSafeSegment } from "../queue/resume.mjs";
import { baseOf, gitOutput, worktreeOf } from "./git-read.mjs";

const ARTIFACT_RE = /^(\d+)[a-z]?-.*\.md$/;
const FALLBACK_VIA = "fallback";

// The numbered artifacts of the job's run directory (the `00-` brief excluded) with their text; none when unreadable.
async function runArtifacts(job, env) {
  if (!isSafeSegment(job?.project_id) || !isSafeSegment(job?.slug)) return [];
  const dir = runDir(job.project_id, job.slug, env);
  let names = [];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const artifacts = [];
  for (const name of names.sort()) {
    const number = Number(ARTIFACT_RE.exec(name)?.[1]);
    if (!Number.isInteger(number) || number < 1) continue;
    const text = await readFile(join(dir, name), "utf8").catch(() => null);
    if (text !== null) artifacts.push({ number, text });
  }
  return artifacts;
}

// The commit messages the job's branch added over its base, empty when the worktree is gone or git fails.
async function commitMessages(job, env) {
  try {
    const cwd = worktreeOf(job, env);
    if (!cwd) return "";
    const base = await baseOf(cwd, env);
    const mergeBase = (await gitOutput(cwd, ["merge-base", base, "HEAD"], env)).trim();
    return await gitOutput(cwd, ["log", "--no-ext-diff", "--format=%B%x00", `${mergeBase}..HEAD`], env);
  } catch {
    return "";
  }
}

// A pattern matching a ref as a whole token (`L5` never inside `L50`); a path ref may follow a `/`, as in `/abs/`, `./` or `a/`.
function refPattern(ref) {
  const escaped = ref.replace(/[.*+?^${}()|[\]\\]/g, (char) => `\\${char}`);
  const before = ref.includes("/") ? "(?<![\\w.-])" : "(?<![\\w/.-])";
  return new RegExp(`${before}${escaped}(?![\\w-]|[./]\\w)`);
}

// The texts a recall's hits may be cited in: artifacts of its phase or later (any for the orchestrator), and the commits.
function textsAfter(recall, { artifacts, commits }) {
  const phase = Number.isInteger(recall?.phase) ? recall.phase : null;
  const texts = artifacts.filter((artifact) => phase === null || artifact.number >= phase).map((artifact) => artifact.text);
  return commits ? [...texts, commits] : texts;
}

// The refs of one recall's matched hits cited later in the run, each once.
function appliedOf(recall, sources) {
  const hits = Array.isArray(recall?.hits) ? recall.hits : [];
  const texts = textsAfter(recall, sources);
  const applied = new Set();
  for (const hit of hits) {
    if (typeof hit?.ref !== "string" || !hit.ref || hit.via === FALLBACK_VIA) continue;
    const pattern = refPattern(hit.ref);
    if (texts.some((text) => pattern.test(text))) applied.add(hit.ref);
  }
  return [...applied];
}

// For each recall of the list, the refs of its hits the run went on to cite; never throws, a failed source adds nothing.
export async function appliedRefs({ job, recalls, env = process.env }) {
  const list = Array.isArray(recalls) ? recalls : [];
  if (list.length === 0) return [];
  const [artifacts, commits] = await Promise.all([runArtifacts(job, env), commitMessages(job, env)]);
  return list.map((recall) => appliedOf(recall, { artifacts, commits }));
}
