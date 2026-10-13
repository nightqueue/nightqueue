import { UserError } from "../config/errors.mjs";
import { originProviders, providerOf } from "./registry.mjs";

const THREAD_OPENER = /<comment-thread\b/gi;
const THREAD_CLOSER = /<\/comment-thread\s*>/gi;
const NOT_A_LIST = "`origin` is a list of {kind, ref}; [] queues with no origin";

// Parses a text with one provider's origin parser, turning a parser that throws or answers nothing into null.
function parseWith(provider, text, { explicit = false } = {}) {
  try {
    const ref = provider.origin.parse(text, { explicit });
    return typeof ref === "string" && ref ? ref : null;
  } catch {
    return null;
  }
}

// Lists every reference one provider recognizes in a text, turning a finder that throws into none.
function findWith(provider, text) {
  if (typeof provider.origin.find !== "function") {
    const ref = parseWith(provider, text);
    return ref ? [ref] : [];
  }
  try {
    const refs = provider.origin.find(text);
    return Array.isArray(refs) ? refs.filter((ref) => typeof ref === "string" && ref) : [];
  } catch {
    return [];
  }
}

// Keeps the first of each origin with the same kind and ref, in the given order.
function dedupeOrigins(origins) {
  const seen = new Set();
  return origins.filter((origin) => {
    const key = originLabel(origin);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// The bounds of the next complete comment-thread opener from a position, a start of -1 when the text has none left.
function nextOpener(text, from) {
  THREAD_OPENER.lastIndex = from;
  const found = THREAD_OPENER.exec(text);
  const end = found ? text.indexOf(">", found.index + found[0].length) : -1;
  return end === -1 ? { start: -1, end: -1 } : { start: found.index, end: end + 1 };
}

// The end of the next comment-thread closer from a position, or -1 when the thread is never closed.
function closerEnd(text, from) {
  THREAD_CLOSER.lastIndex = from;
  const found = THREAD_CLOSER.exec(text);
  return found ? found.index + found[0].length : -1;
}

// Removes the quoted comment threads of a prompt, an unclosed one up to the end of the text, in one pass over it.
function withoutCommentThreads(prompt) {
  let kept = "";
  let at = 0;
  while (at < prompt.length) {
    const opener = nextOpener(prompt, at);
    if (opener.start === -1) return kept + prompt.slice(at);
    kept += prompt.slice(at, opener.start);
    at = closerEnd(prompt, opener.end);
    if (at === -1) return kept;
  }
  return kept;
}

// The origins a prompt names: every link a provider recognizes outside quoted comment threads, in registry order, deduped.
export function detectOrigins(prompt) {
  if (typeof prompt !== "string" || !prompt) return [];
  const text = withoutCommentThreads(prompt);
  const found = originProviders().flatMap((provider) => findWith(provider, text).map((ref) => ({ kind: provider.kind, ref })));
  return dedupeOrigins(found);
}

// Lists the kinds of this build able to name an origin, for a refusal.
function knownOriginKinds() {
  const kinds = originProviders().map((provider) => provider.kind);
  return kinds.length ? kinds.join(", ") : "(none)";
}

// Validates an origin given explicitly as { kind, ref }, answering it with the reference the provider parsed.
export function explicitOrigin(origin) {
  const kind = typeof origin?.kind === "string" ? origin.kind.trim() : "";
  const ref = typeof origin?.ref === "string" ? origin.ref.trim() : "";
  const provider = providerOf(kind);
  if (!provider || typeof provider.origin?.parse !== "function") {
    throw new UserError(`unknown origin kind \`${kind}\`; known origin kinds: ${knownOriginKinds()}`);
  }
  const parsed = ref ? parseWith(provider, ref, { explicit: true }) : null;
  if (!parsed) throw new UserError(`\`${ref}\` is not a ${kind} reference; known origin kinds: ${knownOriginKinds()}`);
  return { kind, ref: parsed };
}

// Resolves the origins of a job being queued: an explicit list is validated ([] = none), an absent one is detected in the prompt.
export function resolveOrigins({ origin, prompt }) {
  if (origin === undefined || origin === null) return detectOrigins(prompt);
  if (!Array.isArray(origin)) throw new UserError(NOT_A_LIST);
  return dedupeOrigins(origin.map(explicitOrigin));
}

// Tells whether a value is one stored origin: an object with a non-empty kind and ref.
function isStoredOrigin(value) {
  return typeof value?.kind === "string" && value.kind !== "" && typeof value?.ref === "string" && value.ref !== "";
}

// Keeps the well-formed origins of a list as { kind, ref }, deduped; anything but an array gives none.
export function validOrigins(list) {
  if (!Array.isArray(list)) return [];
  return dedupeOrigins(list.filter(isStoredOrigin).map(({ kind, ref }) => ({ kind, ref })));
}

// The origins stored in a jobs row as a list of { kind, ref }; empty when there are none or the column is unreadable.
export function parseOriginsColumn(text) {
  if (typeof text !== "string" || !text) return [];
  try {
    return validOrigins(JSON.parse(text));
  } catch {
    return [];
  }
}

// The origin a link names for the first origin provider, other than the excluded kind, that recognizes it; null when none does.
export function originInLink(url, { exclude } = {}) {
  if (typeof url !== "string" || !url) return null;
  for (const provider of originProviders()) {
    if (provider.kind === exclude) continue;
    const ref = parseWith(provider, url);
    if (ref) return { kind: provider.kind, ref };
  }
  return null;
}

// The origin as the text the job log, the CLI and the hints show.
export function originLabel(origin) {
  return `${origin.kind} ${origin.ref}`;
}

// The origins as one comma-separated text.
export function originsLabel(list) {
  return validOrigins(list).map(originLabel).join(", ");
}
