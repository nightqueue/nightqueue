import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { stateDir } from "../config/paths.mjs";
import { writeFileAtomic } from "../config/store.mjs";

const MAX_SESSION_ID = 120;
const DEFAULT_REINJECT_AFTER = 20;
const LESSON_REF = /^l(\d+)$/;

// Session id reduced to the characters that are safe in a file name.
function safeSessionId(sessionId) {
  const safe = String(sessionId ?? "")
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .slice(0, MAX_SESSION_ID);
  return safe || "unknown";
}

// Filesystem-safe path of the state file of a session; a hostile session id can never escape the state directory.
export function sessionStatePath(sessionId, env = process.env) {
  return join(stateDir(env), `${safeSessionId(sessionId)}.json`);
}

// Injected entries of a parsed file, keeping only the well-formed ones.
function readInjected(parsed) {
  if (!Array.isArray(parsed?.injected)) return [];
  return parsed.injected
    .filter((entry) => entry && typeof entry.ref === "string" && Number.isFinite(entry.seq))
    .map((entry) => ({ ref: entry.ref, seq: Number(entry.seq) }));
}

// Reads the state of a session, rebuilding it field by field and never merging the parsed object.
export function readSessionState(sessionId, env = process.env) {
  try {
    const parsed = JSON.parse(readFileSync(sessionStatePath(sessionId, env), "utf8"));
    return { seq: Number.isFinite(parsed?.seq) ? Number(parsed.seq) : 0, injected: readInjected(parsed) };
  } catch {
    return { seq: 0, injected: [] };
  }
}

// Writes the state of a session; a failed write is a no-op, never an error for the hook.
function writeSessionState(sessionId, state, env) {
  try {
    mkdirSync(stateDir(env), { recursive: true });
    const content = JSON.stringify({
      session_id: safeSessionId(sessionId),
      updated_at: new Date().toISOString(),
      seq: state.seq,
      injected: state.injected,
    });
    writeFileAtomic(sessionStatePath(sessionId, env), `${content}\n`);
    return true;
  } catch {
    return false;
  }
}

// Advances the prompt counter of the session and returns the new value.
export function nextSeq(sessionId, env = process.env) {
  const state = readSessionState(sessionId, env);
  const seq = state.seq + 1;
  writeSessionState(sessionId, { seq, injected: state.injected }, env);
  return seq;
}

// Refs of a list, as unique non-empty strings.
function uniqueRefs(refs) {
  const list = Array.isArray(refs) || refs instanceof Set ? [...refs] : [];
  return [...new Set(list.filter((ref) => typeof ref === "string" && ref.trim()))];
}

// Appends the refs injected now, deduped, stamped with the current seq.
export function recordInjected(sessionId, refs, env = process.env) {
  const state = readSessionState(sessionId, env);
  const alreadyAtSeq = new Set(state.injected.filter((entry) => entry.seq === state.seq).map((entry) => entry.ref));
  const fresh = uniqueRefs(refs)
    .filter((ref) => !alreadyAtSeq.has(ref))
    .map((ref) => ({ ref, seq: state.seq }));
  if (!fresh.length) return state;
  const next = { seq: state.seq, injected: [...state.injected, ...fresh] };
  writeSessionState(sessionId, next, env);
  return next;
}

// Refs injected less than `reinjectAfter` prompts ago.
export function seenRefs(sessionId, { reinjectAfter = DEFAULT_REINJECT_AFTER } = {}, env = process.env) {
  const state = readSessionState(sessionId, env);
  const window = Number.isFinite(reinjectAfter) && reinjectAfter > 0 ? reinjectAfter : DEFAULT_REINJECT_AFTER;
  const refs = new Set();
  for (const entry of state.injected) {
    if (state.seq - entry.seq < window) refs.add(entry.ref);
  }
  return refs;
}

// Numeric lesson ids of refs shaped `l<id>`.
export function lessonIdsFromRefs(refs) {
  const ids = [];
  for (const ref of uniqueRefs(refs)) {
    const match = LESSON_REF.exec(ref);
    if (match) ids.push(Number(match[1]));
  }
  return ids;
}
