import { UserError } from "../config/errors.mjs";
import { resolveProjectRef } from "../config/projects.mjs";
import { clip, section } from "../hooks/block.mjs";
import { lessonIdsFromRefs, recordInjected, seenRefs } from "../hooks/state.mjs";
import { resolveCitations } from "../queue/job-citations.mjs";
import { lessonRoles } from "../queue/pipeline-package.mjs";
import { readRunState } from "../queue/resume.mjs";
import { callerJobId } from "../queue/retry.mjs";
import { openStore } from "../store/open.mjs";
import { runTimelineLines } from "./run-timeline.mjs";

const WHOLE_RUN = { reinjectAfter: Number.MAX_SAFE_INTEGER };
const PHASE_LIMIT = 4;
const INDEX_LIMIT = 40;
const LINE_MAX = 300;
const NOTICE_MAX = 200;
const INJECTED_LIMIT = 40;
const NONE_RECORDED = "none recorded";

// What the caller's own job row says about this run: the session whose injections are already spent, and the project every recall reads.
export async function callerContext(env) {
  const own = callerJobId(env);
  if (own === null) return { sessionId: null, project: null, projectId: null, slug: null, prompt: null };
  const row = await openStore(env).jobs.getJob(own);
  const session = typeof row?.session_id === "string" ? row.session_id.trim() : "";
  const prompt = typeof row?.prompt === "string" ? row.prompt : null;
  return { sessionId: session || null, project: row?.project ?? null, projectId: row?.project_id ?? null, slug: row?.slug ?? null, prompt };
}

// Lesson ids this run's session was given - the whole session, not a rolling window; none without a session.
export function runInjectedLessonIds(sessionId, env = process.env) {
  if (!sessionId) return [];
  return lessonIdsFromRefs(seenRefs(sessionId, WHOLE_RUN, env));
}

// Lesson ids this run already saw, merged with the ones the call excluded by hand.
function excludedIds(sessionId, excludeIds, env) {
  const asked = Array.isArray(excludeIds) ? excludeIds : [];
  if (!sessionId) return asked;
  return [...new Set([...asked, ...runInjectedLessonIds(sessionId, env)])];
}

// Marks the lessons as seen by this run, so the next phase asks for other ones; a run the runtime cannot name records nothing.
function markSeen(sessionId, rows, env) {
  if (!sessionId || !rows.length) return;
  recordInjected(
    sessionId,
    rows.map((row) => `l${row.id}`),
    env,
  );
}

// The role a recall filters lessons by: none for no target, a role without lessons, or installed manifests that cannot answer.
function lessonFilterOf(target) {
  if (typeof target !== "string" || target === "") return null;
  try {
    return lessonRoles().includes(target) ? target : null;
  } catch (error) {
    if (error instanceof UserError) return null;
    throw error;
  }
}

// Lessons this run has not seen yet; when the exclusion empties the answer the same query is asked once more without it, because a phase with no lessons is worse than a repeated one.
export async function recallFreshLessons({ query, projectId, target, excludeIds, sessionId, limit = PHASE_LIMIT }, env) {
  const lessons = openStore(env).lessons;
  const spec = { query, projectId, target: lessonFilterOf(target), limit };
  const excluded = excludedIds(sessionId, excludeIds, env);
  const rows = await lessons.recallLessons({ ...spec, excludeIds: excluded });
  const fresh = rows.length || !excluded.length ? rows : await lessons.recallLessons(spec);
  markSeen(sessionId, fresh, env);
  return fresh;
}

// One lesson line of a phase block, carrying the id that closes the injected-applied funnel.
function lessonLine(lesson) {
  return `- [L${lesson.id}] ${clip(lesson.prevention || lesson.title, LINE_MAX)}`;
}

// One memory line of a phase block.
function memoryLine(memory) {
  return `- [M${memory.id}] ${memory.key}: ${clip(memory.value, LINE_MAX)}`;
}

// One indexed file of a phase block, marked for revalidation when the checkout moved under it.
export function indexLine(file) {
  const mark = file.missing || file.stale ? " (REVALIDATE)" : "";
  return `- ${file.path} — ${clip(file.responsibility, LINE_MAX)}${mark}`;
}

// The structural index the explore phase starts from; every other phase gets none, and a project with no map gets nothing.
async function indexSection({ target, projectId, repoRoot, query }, env) {
  if (target !== "explore" || !projectId) return "";
  const { files, libs } = await openStore(env).index.recallProjectIndex({ projectId, repoRoot, query, limit: INDEX_LIMIT });
  const rows = files.map(indexLine);
  if (libs.length) rows.push(`- libs: ${libs.map((lib) => `${lib.lib}@${lib.version}`).join(", ")}`);
  return section("Structural index", rows, (row) => row);
}

// The pull request number a job's PR url carries, or null.
function prNumberOf(prUrl) {
  return /\/pull\/(\d+)(?:[/?#]|$)/.exec(prUrl ?? "")?.[1] ?? null;
}

// The day (YYYY-MM-DD) a job finished on, or null.
function finishedDayOf(finishedAt) {
  return /^(\d{4}-\d{2}-\d{2})/.exec(finishedAt ?? "")?.[1] ?? null;
}

// One job line of the triager block: its reference, its title or slug, and where it stands; an absent piece is left out.
function jobLine(job) {
  const name = job.title ?? job.slug;
  const pr = prNumberOf(job.pr_url);
  const facts = [job.status, pr ? `PR #${pr}` : null, finishedDayOf(job.finished_at)].filter(Boolean).join(" · ");
  return [`- [${job.ref}]`, name ? clip(name, LINE_MAX) : null, `[${facts}]`].filter(Boolean).join(" ");
}

// One cited job line of the triager block: its reference, its title or slug, where it stands with its PR and branch, and the first line of its notice.
function citedLine(job) {
  const name = job.title ?? job.slug;
  const facts = ["cited", job.status, job.pr_url ? `PR ${job.pr_url}` : null, job.branch ? `branch ${job.branch}` : null, finishedDayOf(job.finished_at)];
  const notice = job.notice ? `notice: ${clip(job.notice, NOTICE_MAX)}` : null;
  return [`- [${job.ref}]`, name ? clip(name, LINE_MAX) : null, `[${facts.filter(Boolean).join(" · ")}]`, notice].filter(Boolean).join(" ");
}

// One line of the Related jobs block, by what the entry is: a search hit, a cited job, or a citation the project does not resolve.
function relatedLine(entry) {
  if (entry.kind === "hit") return jobLine(entry.job);
  if (entry.kind === "cited") return citedLine(entry.job);
  if (entry.kind === "missing-job") return `- [${entry.ref}] cited, not found in this project`;
  if (entry.kind === "missing-pr") return `- [PR] ${entry.url} cited, no job of this project opened it`;
  if (entry.kind === "unavailable-job") return `- [${entry.ref}] cited, could not be looked up`;
  if (entry.kind === "unavailable-pr") return `- [PR] ${entry.url} cited, could not be looked up`;
  return `- [PR] ${entry.url} cited, opened by more than one job of this project: ${entry.refs.join(", ")}`;
}

// The project's jobs matching a query, best first; an empty query or a failed search answers none.
async function searchedJobs(store, { projectId, query, excludeJobId }) {
  if (typeof query !== "string" || !query.trim()) return [];
  try {
    return await store.jobs.searchJobs({ projectId, query, excludeJobId });
  } catch {
    return [];
  }
}

// The earlier jobs the triager should know about before judging a request: the ones the job prompt or the query cites first, then the search hits; any other phase, a run without an owner or a failed read gets nothing.
async function jobSection({ target, projectId, query, prompt, excludeJobId }, env) {
  if (target !== "triager" || !projectId) return "";
  try {
    const store = openStore(env);
    const text = [prompt, query].filter((part) => typeof part === "string").join("\n");
    const resolved = await resolveCitations(store, { projectId, text, ownJobId: excludeJobId });
    const cited = resolved.filter((entry) => entry.kind !== "own");
    const pinned = new Set(cited.filter((entry) => entry.kind === "cited").map((entry) => entry.job.id));
    const hits = (await searchedJobs(store, { projectId, query, excludeJobId })).filter((job) => !pinned.has(job.id));
    return section("Related jobs", [...cited, ...hits.map((job) => ({ kind: "hit", job }))], relatedLine);
  } catch {
    return "";
  }
}

// The lessons this job's session was given, one `- [L<id>] <title>` line each; none outside a job.
export async function injectedLessonLines(env) {
  const { sessionId } = await callerContext(env);
  const ids = runInjectedLessonIds(sessionId, env).slice(0, INJECTED_LIMIT);
  const store = openStore(env);
  const lessons = await Promise.all(ids.map((id) => store.lessons.getLesson(id)));
  const lines = lessons.filter(Boolean).map((lesson) => `- [L${lesson.id}] ${lesson.title}`);
  return lines.length ? lines.join("\n") : NONE_RECORDED;
}

// The given lessons of the reflector's block; a failed read answers `none recorded` and an open item.
async function givenLessonsOf(env, openItems) {
  try {
    return await injectedLessonLines(env);
  } catch (error) {
    openItems.push(`the lessons given to this run failed: ${error?.message ?? String(error)}`);
    return NONE_RECORDED;
  }
}

// The reflector's block: what the run went through and the lessons it was given; it recalls nothing, so it marks no lesson as seen.
async function reflectorBlock(run, env) {
  const openItems = [];
  const state = readRunState({ projectId: run.projectId, slug: run.slug, env });
  const timeline = await runTimelineLines({ run, state, env, openItems });
  const given = await givenLessonsOf(env, openItems);
  return { project: run.project, block: `## Run timeline\n${timeline}\n\n## Lessons given to this run\n${given}`, open_items: openItems };
}

// The project a phase block reads: the caller's own job's, else the one the call names (a name, or a path inside a checkout); an unknown name is refused.
async function phaseOwner(caller, project, env) {
  if (caller.project) return { id: caller.projectId, name: caller.project };
  const found = await resolveProjectRef(openStore(env), project);
  return { id: found?.id ?? null, name: found?.name ?? null };
}

// The context block one subagent fetches for its phase: the lessons it has not seen, the project memory and, for the explore, the known map; the reflector gets its run's timeline instead.
export async function phaseContextBlock({ target, query, project, repoRoot, excludeIds, run }, env = process.env) {
  if (target === "reflector") return reflectorBlock(run, env);
  const caller = await callerContext(env);
  const owner = await phaseOwner(caller, project, env);
  const lessons = await recallFreshLessons(
    { query, projectId: owner.id, target, excludeIds, sessionId: caller.sessionId },
    env,
  );
  const memories = await openStore(env).memory.recallMemories({ query, projectId: owner.id, limit: PHASE_LIMIT });
  const sections = [
    section("Applicable lessons", lessons, lessonLine),
    section("Project memory", memories, memoryLine),
    await indexSection({ target, projectId: owner.id, repoRoot, query }, env),
    await jobSection({ target, projectId: owner.id, query, prompt: caller.prompt, excludeJobId: callerJobId(env) }, env),
  ].filter(Boolean);
  return { project: owner.name, block: sections.join("\n\n") };
}
