import { resolveProjectName } from "./db.mjs";
import {
  backfillEmptyLessonFields,
  bumpAttempts,
  bumpViolation,
  emptyLessonFields,
  findByNormalizedTitle,
  saveLesson,
  setLessonEmbedding,
} from "./lessons.mjs";
import { memoryByKey, saveMemory } from "./memory.mjs";
import { normalizeExcludeIds as normalizeIds, recallLessons, resolveEmbedder } from "./search.mjs";

const ITEM_KINDS = ["error", "correction", "decision"];
const CANDIDATE_LIMIT = 5;

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

// Saves a lesson, or bumps the existing one when a lesson of the same project already has the same normalized title.
export async function saveLessonDeduped(
  { project, title, root_cause, solution, prevention, attempts, target },
  env = process.env,
) {
  const projectName = resolveProjectName(project, env);
  const existing = findByNormalizedTitle({ project: projectName, title }, env);
  if (existing) {
    const bumped = bumpAttempts(existing.id, env);
    const filled = backfillEmptyLessonFields(existing.id, { root_cause, solution, prevention }, env);
    return {
      id: existing.id,
      project: projectName,
      deduped: true,
      attempts: bumped.attempts,
      incomplete: emptyLessonFields(filled),
    };
  }
  const saved = saveLesson({ project: projectName, title, root_cause, solution, prevention, attempts, target }, env);
  const embedder = await resolveEmbedder(undefined, env);
  await storeEmbedding(saved.id, lessonProbe({ title, prevention }), { embedder, log: logToStderr }, env);
  return {
    id: saved.id,
    project: projectName,
    deduped: false,
    attempts: Number.isInteger(attempts) ? attempts : null,
    incomplete: emptyLessonFields({ root_cause, solution, prevention }),
  };
}

// Item of the reflector with the minimum to become a lesson or a memory.
function isValidItem(item) {
  return Boolean(
    item &&
      ITEM_KINDS.includes(item.kind) &&
      typeof item.title === "string" &&
      typeof item.prevention === "string" &&
      item.title.trim() &&
      item.prevention.trim(),
  );
}

// Verdict of the judge: a plain object with at least one `n<number>` key.
function acceptsVerdict(value) {
  return Boolean(value) && !Array.isArray(value) && typeof value === "object" && Object.keys(value).some((k) => /^n\d+$/.test(k));
}

// Id of a merge is only valid as an OWN key of the ref and as one of the candidates of THAT ref.
function validId(verdict, ref, candidates) {
  const raw = Object.hasOwn(verdict, ref) ? verdict[ref] : null;
  return Number.isInteger(raw) && candidates.some((c) => c.id === raw) ? raw : null;
}

// Flattens a text into a single line, so a line break never breaks the merge log.
function oneLine(text) {
  return String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

// Logs the content of the lesson dropped by a merge, which is what makes a wrong verdict recoverable.
function logMerge(item, chosen, log) {
  const via = chosen?.via ? ` via=${chosen.via}` : "";
  log(
    `merged: lesson ${chosen?.id} kept${via}; dropped title="${oneLine(item.title)}" prevention="${oneLine(item.prevention)}"`,
  );
}

// Candidates of an item through both recall paths; a search failure means no candidate, so the item is saved.
async function candidatesOf(item, { project, log, db }, env) {
  try {
    const found = await recallLessons({ query: lessonProbe(item), project, limit: CANDIDATE_LIMIT }, env, db);
    return found.filter((row) => row.via !== "fallback");
  } catch (err) {
    log(`candidate search failed for "${oneLine(item.title)}": ${err?.message ?? String(err)}`);
    return [];
  }
}

// Stores a decision as a memory, skipping a key that is already there; never throws.
function storeDecision(item, { project, model, log }, env) {
  try {
    const key = item.title.trim();
    if (memoryByKey({ project, key }, env)) return false;
    saveMemory({ project, key, value: String(item.solution || item.prevention).trim(), model }, env);
    return true;
  } catch (err) {
    log(`could not save memory "${oneLine(item.title)}": ${err?.message ?? String(err)}`);
    return false;
  }
}

// Saves a new lesson with its vector; never throws, and tells whether it entered the corpus.
async function storeLesson(item, { project, model, embedder, log }, env) {
  let saved;
  try {
    saved = saveLesson(
      {
        project,
        title: item.title.trim(),
        root_cause: String(item.root_cause || item.title).trim(),
        solution: String(item.solution || "").trim(),
        prevention: item.prevention.trim(),
        target: item.target,
        model,
      },
      env,
    );
  } catch (err) {
    log(`could not save lesson "${oneLine(item.title)}": ${err?.message ?? String(err)}`);
    return false;
  }
  await storeEmbedding(saved.id, lessonProbe(item), { embedder, log }, env);
  return true;
}

// Counts a violation when a lesson injected in this session was broken again; only the lexical path counts.
function countViolation(candidates, injected, log, env) {
  if (!injected.size) return false;
  const hit = candidates.find((c) => c.via === "lexical" && injected.has(c.id));
  if (!hit) return false;
  try {
    bumpViolation(hit.id, env);
    return true;
  } catch (err) {
    log(`violation count failed for lesson ${hit.id}: ${err?.message ?? String(err)}`);
    return false;
  }
}

// Asks the judge once for every stationed item; any failure becomes {} and everything is saved as new.
async function askJudge(judge, stationed, log) {
  if (typeof judge !== "function") return {};
  const payload = stationed.map(({ ref, item, candidates }) => ({
    ref,
    fresh: { title: item.title, prevention: item.prevention },
    candidates: candidates.map((c) => ({ id: c.id, title: c.title, prevention: c.prevention })),
  }));
  try {
    const verdict = await judge(payload);
    if (acceptsVerdict(verdict)) return verdict;
    log(`judge returned no usable verdict; ${stationed.length} item(s) saved as new`);
  } catch (err) {
    log(`judge failed (${err?.message ?? String(err)}); ${stationed.length} item(s) saved as new`);
  }
  return {};
}

// Marks the recurrence of an existing lesson; never throws.
function markRecurrence(id, log, env) {
  try {
    const bumped = bumpAttempts(id, env);
    log(`recurrence: lesson ${id} attempts=${bumped.attempts}`);
    return true;
  } catch (err) {
    log(`could not mark the recurrence of lesson ${id}: ${err?.message ?? String(err)}`);
    return false;
  }
}

// Persists the lessons extracted by the reflector, merging recurrences through a single judge call; never throws. `db` lets the store bring its own connection.
export async function persistLessons(items, options = {}, env = process.env, db = null) {
  const write = typeof options?.log === "function" ? options.log : () => {};
  try {
    return await persistItems(items, options, write, env, db);
  } catch (err) {
    write(`persistLessons failed: ${err?.message ?? String(err)}`);
    return { saved: 0, merged: 0, judged: 0, violations: 0, memories: 0 };
  }
}

// Runs the two phases of the persistence: item by item first, one judge call for the stationed ones after.
async function persistItems(items, { project, model, injectedIds = [], judge, embedder }, write, env, db) {
  const result = { saved: 0, merged: 0, judged: 0, violations: 0, memories: 0 };
  const injected = new Set(normalizeIds(injectedIds));
  const ctx = {
    project: resolveProjectName(project, env),
    model,
    log: write,
    db,
    embedder: await resolveEmbedder(embedder, env),
  };
  const stationed = [];
  for (const item of (Array.isArray(items) ? items : []).filter(isValidItem)) {
    if (item.kind === "decision") {
      if (storeDecision(item, ctx, env)) result.memories++;
      continue;
    }
    const candidates = await candidatesOf(item, ctx, env);
    if (countViolation(candidates, injected, write, env)) result.violations++;
    if (candidates.length) {
      stationed.push({ ref: `n${stationed.length}`, item, candidates });
      continue;
    }
    if (await storeLesson(item, ctx, env)) result.saved++;
  }
  if (!stationed.length) return result;
  result.judged = stationed.length;
  const verdict = await askJudge(judge, stationed, write);
  for (const parked of stationed) {
    const id = validId(verdict, parked.ref, parked.candidates);
    if (id !== null && markRecurrence(id, write, env)) {
      logMerge(parked.item, parked.candidates.find((c) => c.id === id), write);
      result.merged++;
      continue;
    }
    if (await storeLesson(parked.item, ctx, env)) result.saved++;
  }
  return result;
}
