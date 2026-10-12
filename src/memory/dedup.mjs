import {
  backfillEmptyLessonFields,
  bumpAttempts,
  emptyLessonFields,
  findByNormalizedTitle,
  saveLesson,
  setLessonEmbedding,
} from "./lessons.mjs";
import { projectIdOrNull } from "./registry.mjs";
import { resolveEmbedder } from "./search.mjs";

// Writes a diagnostic line to stderr, the only stream a stdio server may use.
function logToStderr(line) {
  process.stderr.write(`${line}\n`);
}

// Text used to embed and to look a lesson up: title plus prevention.
function lessonProbe({ title, prevention }) {
  return [title, prevention].filter(Boolean).map(String).join(" ");
}

// Stores the vector of a lesson right after its INSERT; a missing vector is recoverable, a lost lesson is not.
async function storeEmbedding(id, probe, { embedder, log }, env) {
  if (!embedder) return;
  try {
    const vector = await embedder.embedText(probe);
    setLessonEmbedding({ id, vector, model: embedder.model }, env);
  } catch (err) {
    log(`embedding of lesson ${id} not stored: ${err?.message ?? String(err)}`);
  }
}

// Saves a lesson of a project id, or bumps the existing one when a lesson of the same project already has the same normalized title.
export async function saveLessonDeduped(
  { projectId, title, root_cause, solution, prevention, attempts, target },
  env = process.env,
) {
  const owner = projectIdOrNull(projectId);
  const existing = findByNormalizedTitle({ projectId: owner, title }, env);
  if (existing) {
    const bumped = bumpAttempts(existing.id, env);
    const filled = backfillEmptyLessonFields(existing.id, { root_cause, solution, prevention }, env);
    return {
      id: existing.id,
      projectId: owner,
      deduped: true,
      attempts: bumped.attempts,
      incomplete: emptyLessonFields(filled),
    };
  }
  const saved = saveLesson({ projectId: owner, title, root_cause, solution, prevention, attempts, target }, env);
  const embedder = await resolveEmbedder(undefined, env);
  await storeEmbedding(saved.id, lessonProbe({ title, prevention }), { embedder, log: logToStderr }, env);
  return {
    id: saved.id,
    projectId: owner,
    deduped: false,
    attempts: Number.isInteger(attempts) ? attempts : null,
    incomplete: emptyLessonFields({ root_cause, solution, prevention }),
  };
}
