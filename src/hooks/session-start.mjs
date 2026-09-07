import { projectFromCwd } from "../memory/db.mjs";
import { markInjected } from "../memory/lessons.mjs";
import { recentMemories } from "../memory/memory.mjs";
import { recallLessons } from "../memory/search.mjs";
import { section } from "./block.mjs";
import { recordInjected } from "./state.mjs";

const LESSON_LIMIT = 12;
const MEMORY_LIMIT = 10;
const MAX_OUTPUT = 9000;
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
function markInjectedQuietly(ids, env) {
  try {
    return markInjected(ids, env).injected;
  } catch {
    return 0;
  }
}

// Registers what was injected, both in the session state and in the corpus.
function stampInjection(sessionId, lessons, env) {
  const ids = lessons.map((lesson) => lesson.id).filter((id) => Number.isInteger(id));
  recordInjected(
    sessionId,
    ids.map((id) => `l${id}`),
    env,
  );
  return markInjectedQuietly(ids, env);
}

// Builds the context block injected at the start of a session: top lessons plus the project memories.
export async function runSessionStart({ input, env = process.env }) {
  if (env?.NIGHTSHIFT_REFLECT === "1") return "";
  const cwd = typeof input?.cwd === "string" && input.cwd.trim() ? input.cwd : process.cwd();
  const sessionId = typeof input?.session_id === "string" ? input.session_id : "unknown";
  const project = projectFromCwd(cwd, env);
  if (!project) return "";
  const lessons = await recallLessons({ project: project?.name, limit: LESSON_LIMIT }, env);
  const memories = recentMemories({ project: project?.name, limit: MEMORY_LIMIT }, env);
  const sections = [
    section("Lessons learned (do not repeat these mistakes)", lessons, lessonLine),
    section(`Project memory (${project?.name ?? "global"})`, memories, memoryLine),
  ].filter(Boolean);
  if (!sections.length) return "";
  stampInjection(sessionId, lessons, env);
  return `# Nightshift context\n\n${sections.join("\n\n")}\n\n${FOOTER}`.slice(0, MAX_OUTPUT);
}
