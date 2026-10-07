import { UserError } from "../config/errors.mjs";
import { originProviders, providerOf } from "./registry.mjs";

// Parses a text with one provider's origin parser, turning a parser that throws or answers nothing into null.
function parseWith(provider, text, { explicit = false } = {}) {
  try {
    const ref = provider.origin.parse(text, { explicit });
    return typeof ref === "string" && ref ? ref : null;
  } catch {
    return null;
  }
}

// The origin a prompt names: the first provider, in registry order, whose parser recognizes it; null when none does.
export function detectOrigin(prompt) {
  if (typeof prompt !== "string" || !prompt) return null;
  for (const provider of originProviders()) {
    const ref = parseWith(provider, prompt);
    if (ref) return { kind: provider.kind, ref };
  }
  return null;
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

// Resolves the origin of a job being queued: `false` means none, an explicit one is validated, anything else is detected in the prompt.
export function resolveOrigin({ origin, prompt }) {
  if (origin === false) return null;
  if (origin && typeof origin === "object") return explicitOrigin(origin);
  return detectOrigin(prompt);
}

// The origin stored in a jobs row as { kind, ref }, or null when there is none or it is unreadable.
export function parseOriginColumn(text) {
  if (typeof text !== "string" || !text) return null;
  try {
    const parsed = JSON.parse(text);
    const valid = typeof parsed?.kind === "string" && parsed.kind && typeof parsed?.ref === "string" && parsed.ref;
    return valid ? { kind: parsed.kind, ref: parsed.ref } : null;
  } catch {
    return null;
  }
}

// The origin as the text the job log, the CLI and the hints show.
export function originLabel(origin) {
  return `${origin.kind} ${origin.ref}`;
}
