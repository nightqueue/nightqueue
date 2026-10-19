import { StoreUnavailableError, storeWarningLine } from "../config/errors.mjs";
import { updateNoticeLine } from "../host/update-notice.mjs";
import { preselectedProject, projectFromCwd, projectsWithPending } from "../memory/registry-access.mjs";
import { queueWorkers } from "../queue/close-view.mjs";
import { liveRunnersReport } from "../queue/registry.mjs";
import { openStore } from "../store/open.mjs";
import { section } from "./block.mjs";
import { recordInjected } from "./state.mjs";

const LESSON_LIMIT = 12;
const MEMORY_LIMIT = 10;
const MAX_OUTPUT = 9000;
const REGISTERED_LIMIT = 30;
const HEADER = "# Nightqueue context";
const FOOTER = "Call `lesson_save` as soon as an error costs a second attempt, and `lesson_recall` before acting.";

// One lesson line of the session block.
function lessonLine(lesson) {
  const scope = lesson.project ? "" : " (global)";
  return `- [L${lesson.id}] ${lesson.title}${scope}: ${lesson.prevention}`;
}

// One memory line of the session block.
function memoryLine(memory) {
  return `- ${memory.key}: ${memory.value}`;
}

// Marks the lessons as injected in the corpus, tolerating a write failure that must not cost the block.
async function markInjectedQuietly(store, ids) {
  try {
    return (await store.lessons.markInjected(ids)).injected;
  } catch {
    return 0;
  }
}

// Registers what was injected, both in the session state and in the corpus.
async function stampInjection(store, sessionId, lessons, env) {
  const ids = lessons.map((lesson) => lesson.id).filter((id) => Number.isInteger(id));
  recordInjected(
    sessionId,
    ids.map((id) => `l${id}`),
    env,
  );
  return markInjectedQuietly(store, ids);
}

// Builds the context block injected at the start of a session, or one warning line when the home database is unavailable.
export async function runSessionStart({ input, env = process.env, fetchImpl = null }) {
  try {
    return await sessionBlock({ input, env, fetchImpl });
  } catch (err) {
    if (err instanceof StoreUnavailableError) return storeWarningLine(err);
    throw err;
  }
}

// The project of the session and whether `nightqueue open` preselected it (no checkout holds the session's directory).
function blockProject(cwd, env) {
  const found = projectFromCwd(cwd, env);
  if (found) return { project: found, preselected: false };
  return { project: preselectedProject(env), preselected: true };
}

// The line naming the project `nightqueue open` preselected, empty when the session's directory names it.
function preselectedLine(project, preselected) {
  return preselected ? `Current project (preselected by nightqueue open): ${project.name}` : "";
}

// Tells whether the session is the operator's (`nightqueue open`), never a job.
function isOperatorSession(env) {
  return !env?.NIGHTQUEUE_JOB_ID && typeof env?.NIGHTQUEUE_MODE === "string" && env.NIGHTQUEUE_MODE.trim() === "operator";
}

// One project line of the registered-projects section.
function registeredLine(row) {
  return `${row.name} · ${row.key} · ${Number(row.pending) || 0} pending`;
}

// The registered projects with their pending counts, the preselected one first, capped at REGISTERED_LIMIT lines.
function registeredProjects(env, preselectedId) {
  const rows = projectsWithPending(env);
  const ordered = [...rows.filter((row) => row.id === preselectedId), ...rows.filter((row) => row.id !== preselectedId)];
  const lines = ordered.slice(0, REGISTERED_LIMIT).map(registeredLine);
  if (ordered.length > REGISTERED_LIMIT) lines.push(`… and ${ordered.length - REGISTERED_LIMIT} more (nightqueue project list)`);
  return lines.length ? `## Registered projects\n${lines.join("\n")}\n${runnersLine(env)}`.trimEnd() : "";
}

// The `Runners online: <n>` line from the runner registry (pid probes, no log tail), empty when the registry cannot be listed.
function runnersLine(env) {
  const { runners, error } = liveRunnersReport(env);
  return error === null ? `Runners online: ${queueWorkers(runners).length}` : "";
}

// The context block of a session: the preselected project, top lessons and the project memories.
async function sessionBlock({ input, env, fetchImpl }) {
  const cwd = typeof input?.cwd === "string" && input.cwd.trim() ? input.cwd : process.cwd();
  const { project, preselected } = blockProject(cwd, env);
  const registered = isOperatorSession(env) ? registeredProjects(env, project?.id) : "";
  if (!project && !registered) return "";
  const lead = [project ? preselectedLine(project, preselected) : "", registered].filter(Boolean).join("\n\n");
  const block = project ? await memoryBlock({ input, env, fetchImpl, project, lead }) : "";
  return block || (lead ? `${HEADER}\n\n${lead}` : "");
}

// The memory part of the session block, led by the given line, or empty when the project has no memory.
async function memoryBlock({ input, env, fetchImpl, project, lead }) {
  const sessionId = typeof input?.session_id === "string" ? input.session_id : "unknown";
  const store = openStore(env);
  const lessons = await store.lessons.recallLessons({ projectId: project.id, limit: LESSON_LIMIT });
  const memories = await store.memory.recentMemories({ projectId: project.id, limit: MEMORY_LIMIT });
  const sections = [
    section("Lessons learned (do not repeat these mistakes)", lessons, lessonLine),
    section(`Project memory (${project?.name ?? "global"})`, memories, memoryLine),
  ].filter(Boolean);
  if (!sections.length) return "";
  await stampInjection(store, sessionId, lessons, env);
  const notice = await updateNoticeLine({ env, fetchImpl });
  const block = `${HEADER}\n\n${[lead, ...sections].filter(Boolean).join("\n\n")}\n\n${FOOTER}`;
  return (notice ? `${block}\n\n${notice}` : block).slice(0, MAX_OUTPUT);
}
