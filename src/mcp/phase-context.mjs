import { resolveProjectRef } from "../config/projects.mjs";
import { clip, section } from "../hooks/block.mjs";
import { lessonIdsFromRefs, recordInjected, seenRefs } from "../hooks/state.mjs";
import { LESSON_TARGETS } from "../memory/lessons.mjs";
import { callerJobId } from "../queue/retry.mjs";
import { openStore } from "../store/open.mjs";

export const PHASE_TARGETS = [...LESSON_TARGETS, "explore"];

const WHOLE_RUN = { reinjectAfter: Number.MAX_SAFE_INTEGER };
const PHASE_LIMIT = 4;
const INDEX_LIMIT = 40;
const LINE_MAX = 300;

// What the caller's own job row says about this run: the session whose injections are already spent, and the project every recall reads.
export async function callerContext(env) {
  const own = callerJobId(env);
  if (own === null) return { sessionId: null, project: null, projectId: null };
  const row = await openStore(env).jobs.getJob(own);
  const session = typeof row?.session_id === "string" ? row.session_id.trim() : "";
  return { sessionId: session || null, project: row?.project ?? null, projectId: row?.project_id ?? null };
}

// Lesson ids this run already saw - the whole session, not a rolling window - merged with the ones the call excluded by hand.
function excludedIds(sessionId, excludeIds, env) {
  const asked = Array.isArray(excludeIds) ? excludeIds : [];
  if (!sessionId) return asked;
  return [...new Set([...asked, ...lessonIdsFromRefs(seenRefs(sessionId, WHOLE_RUN, env))])];
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

// Lessons this run has not seen yet; when the exclusion empties the answer the same query is asked once more without it, because a phase with no lessons is worse than a repeated one.
export async function recallFreshLessons({ query, projectId, target, excludeIds, sessionId, limit = PHASE_LIMIT }, env) {
  const lessons = openStore(env).lessons;
  const spec = { query, projectId, target: LESSON_TARGETS.includes(target) ? target : null, limit };
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
function indexLine(file) {
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

// One roadmap line of the triager block: its reference, its title and where it stands.
function roadmapLine(item) {
  return `- [${item.ref}] ${clip(item.title, LINE_MAX)} [${item.status}, p${item.priority}, ${item.type}]`;
}

// The roadmap items the triager should know about before judging a request; any other phase, a run without an owner or a failed search gets nothing.
async function roadmapSection({ target, project, query }, env) {
  if (target !== "triager" || !project || typeof query !== "string" || !query.trim()) return "";
  try {
    const items = await openStore(env).roadmap.searchRoadmap({ project, query });
    return section("Related roadmap items", items, roadmapLine);
  } catch {
    return "";
  }
}

// The project a phase block reads: the caller's own job's, else the one the call names (a name, or a path inside a checkout); an unknown name is refused.
async function phaseOwner(caller, project, env) {
  if (caller.project) return { id: caller.projectId, name: caller.project };
  const found = await resolveProjectRef(openStore(env), project);
  return { id: found?.id ?? null, name: found?.name ?? null };
}

// The context block of one phase, ready to paste into the subagent's prompt: the lessons it has not seen, the project memory and, for the explore, the known map.
export async function phaseContextBlock({ target, query, project, repoRoot, excludeIds }, env = process.env) {
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
    await roadmapSection({ target, project: owner.name, query }, env),
  ].filter(Boolean);
  return { project: owner.name, block: sections.join("\n\n") };
}
