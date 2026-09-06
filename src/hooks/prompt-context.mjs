import { projectFromCwd } from "../memory/db.mjs";
import { searchMemories } from "../memory/memory.mjs";
import { recallLessons } from "../memory/search.mjs";
import { clip, section } from "./block.mjs";
import { lessonIdsFromRefs, nextSeq, recordInjected, seenRefs } from "./state.mjs";

const MIN_PROMPT = 20;
const LESSON_QUERY_LIMIT = 8;
const LESSON_LIMIT = 4;
const MEMORY_QUERY_LIMIT = 5;
const MEMORY_LIMIT = 3;
const REINJECT_AFTER = 20;
const EMBED_DEADLINE_MS = 800;
const LESSON_CLIP = 350;
const MEMORY_CLIP = 400;
const MAX_OUTPUT = 3000;

// Text the user actually wrote, with the slash command stripped so the recall sees the request.
export function promptBody(prompt) {
  return String(prompt ?? "")
    .replace(/^\/\S+\s*/, "")
    .trim();
}

// Embedding deadline of the prompt hook, adjustable on a slow machine.
function embedDeadline(env) {
  const raw = Number(env?.NIGHTSHIFT_EMBED_DEADLINE_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : EMBED_DEADLINE_MS;
}

// One lesson line of the prompt block.
function lessonLine(lesson) {
  return `- [L${lesson.id}] ${clip(lesson.prevention, LESSON_CLIP)}`;
}

// One memory line of the prompt block.
function memoryLine(memory) {
  return `- ${memory.key}: ${clip(memory.value, MEMORY_CLIP)}`;
}

// Lessons relevant to this prompt, skipping the ones already injected in this session.
async function relevantLessons({ body, project, seen, env }) {
  const rows = await recallLessons(
    {
      query: body,
      project,
      limit: LESSON_QUERY_LIMIT,
      excludeIds: lessonIdsFromRefs(seen),
      deadlineMs: embedDeadline(env),
    },
    env,
  );
  return rows.slice(0, LESSON_LIMIT);
}

// Memories relevant to this prompt, skipping the ones already injected in this session.
function relevantMemories({ body, project, seen, env }) {
  const rows = searchMemories({ query: body, project, limit: MEMORY_QUERY_LIMIT }, env);
  return rows.filter((row) => !seen.has(`m${row.id}`)).slice(0, MEMORY_LIMIT);
}

// Builds the context block injected on every prompt: lessons and memories relevant to the prompt text.
export async function runPromptContext({ input, env = process.env }) {
  if (env?.NIGHTSHIFT_REFLECT === "1") return "";
  const body = promptBody(input?.prompt);
  if (body.length < MIN_PROMPT) return "";
  const cwd = typeof input?.cwd === "string" && input.cwd.trim() ? input.cwd : process.cwd();
  const sessionId = typeof input?.session_id === "string" ? input.session_id : "unknown";
  const project = projectFromCwd(cwd, env)?.name;
  nextSeq(sessionId, env);
  const seen = seenRefs(sessionId, { reinjectAfter: REINJECT_AFTER }, env);
  const lessons = await relevantLessons({ body, project, seen, env });
  const memories = relevantMemories({ body, project, seen, env });
  const sections = [
    section("Lessons relevant to this request (apply before acting)", lessons, lessonLine),
    section("Relevant memory", memories, memoryLine),
  ].filter(Boolean);
  if (!sections.length) return "";
  const refs = [...lessons.map((lesson) => `l${lesson.id}`), ...memories.map((memory) => `m${memory.id}`)];
  recordInjected(sessionId, refs, env);
  return sections.join("\n\n").slice(0, MAX_OUTPUT);
}
