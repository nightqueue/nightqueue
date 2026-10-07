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
const COMMITS_SOURCE = "commits";

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
    if (text !== null) artifacts.push({ name, number, text });
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

// The named texts a recall's hits may be cited in: artifacts of its phase or later (any for the orchestrator), and the commits.
function textsAfter(recall, { artifacts, commits }) {
  const phase = Number.isInteger(recall?.phase) ? recall.phase : null;
  const texts = artifacts.filter((artifact) => phase === null || artifact.number >= phase);
  return commits ? [...texts, { name: COMMITS_SOURCE, text: commits }] : texts;
}

// The names of the texts that cite a hit's ref, none for a hit without a ref or one the recall fell back to.
function citingNames(hit, texts) {
  if (typeof hit?.ref !== "string" || !hit.ref || hit.via === FALLBACK_VIA) return [];
  const pattern = refPattern(hit.ref);
  return texts.filter((source) => pattern.test(source.text)).map((source) => source.name);
}

// For each hit of one recall, in order, the names of the later texts that cite it.
function appliedOf(recall, sources) {
  const hits = Array.isArray(recall?.hits) ? recall.hits : [];
  const texts = textsAfter(recall, sources);
  return hits.map((hit) => citingNames(hit, texts));
}

// For each recall of the list, per hit, the artifact names (then `commits`) citing it; never throws, a failed source adds nothing.
export async function appliedRefs({ job, recalls, env = process.env }) {
  const list = Array.isArray(recalls) ? recalls : [];
  if (list.length === 0) return [];
  const [artifacts, commits] = await Promise.all([runArtifacts(job, env), commitMessages(job, env)]);
  return list.map((recall) => appliedOf(recall, { artifacts, commits }));
}

// One recall with each hit's citing sources and the distinct refs it applied.
function recallWithApplied(recall, perHit) {
  const hits = (Array.isArray(recall?.hits) ? recall.hits : []).map((hit, index) => ({ ...hit, applied: perHit?.[index] ?? [] }));
  const applied = [...new Set(hits.filter((hit) => hit.applied.length > 0).map((hit) => hit.ref))];
  return { ...recall, hits, applied };
}

// The recalls with per-hit `applied` sources and the count of distinct refs cited across all of them.
export function withApplied(recalls, appliedLists) {
  const list = (Array.isArray(recalls) ? recalls : []).map((recall, index) => recallWithApplied(recall, appliedLists?.[index]));
  return { recalls: list, applied_total: new Set(list.flatMap((recall) => recall.applied)).size };
}
