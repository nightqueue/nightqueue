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
  if (own === null) return { sessionId: null, project: null };
  const row = await openStore(env).jobs.getJob(own);
  const session = typeof row?.session_id === "string" ? row.session_id.trim() : "";
  return { sessionId: session || null, project: row?.project ?? null };
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
export async function recallFreshLessons({ query, project, target, excludeIds, sessionId, limit = PHASE_LIMIT }, env) {
  const lessons = openStore(env).lessons;
  const spec = { query, project, target: LESSON_TARGETS.includes(target) ? target : null, limit };
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
async function indexSection({ target, project, repoRoot, query }, env) {
  if (target !== "explore" || !project) return "";
  const { files, libs } = await openStore(env).index.recallProjectIndex({ project, repoRoot, query, limit: INDEX_LIMIT });
  const rows = files.map(indexLine);
  if (libs.length) rows.push(`- libs: ${libs.map((lib) => `${lib.lib}@${lib.version}`).join(", ")}`);
  return section("Structural index", rows, (row) => row);
}

// The context block of one phase, ready to paste into the subagent's prompt: the lessons it has not seen, the project memory and, for the explore, the known map.
export async function phaseContextBlock({ target, query, project, repoRoot, excludeIds }, env = process.env) {
  const caller = await callerContext(env);
  const named = typeof project === "string" && project.trim() ? project.trim() : null;
  const owner = caller.project ?? named;
  const lessons = await recallFreshLessons(
    { query, project: owner, target, excludeIds, sessionId: caller.sessionId },
    env,
  );
  const memories = await openStore(env).memory.recallMemories({ query, project: owner, limit: PHASE_LIMIT });
  const sections = [
    section("Applicable lessons", lessons, lessonLine),
    section("Project memory", memories, memoryLine),
    await indexSection({ target, project: owner, repoRoot, query }, env),
  ].filter(Boolean);
  return { project: owner, block: sections.join("\n\n") };
}
