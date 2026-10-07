import { UserError } from "../config/errors.mjs";

export const KEY_RE = /^[A-Z][A-Z0-9]{1,4}$/;
export const GLOBAL_KEY = "G";

const NUMBER = "([1-9]\\d*)";
const OWNER = "([A-Z][A-Z0-9]{1,4}|G)";
const JOB_RE = new RegExp(`^(?:J-)?${NUMBER}$`);
const BARE_DECISION_RE = new RegExp(`^D-${NUMBER}$`);
const OWNED_DECISION_RE = new RegExp(`^${OWNER}/D-${NUMBER}$`);
const SUFFIXES = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const KEY_CHARS = `${SUFFIXES}0123456789`;
const FALLBACK_PREFIX = { project: "P", org: "O" };

// Normalises a key (trim, upper case) and refuses one outside the key rules.
export function requireKey(value) {
  const key = typeof value === "string" ? value.trim().toUpperCase() : "";
  if (!KEY_RE.test(key)) {
    throw new UserError(`key \`${value}\` is invalid: a key is 2 to 5 uppercase letters or digits and starts with a letter`);
  }
  return key;
}

// Renders the ref of a job.
export function jobRef(id) {
  return `J-${id}`;
}

// Reads a ref number as a safe positive integer, or null.
function positiveNumber(text) {
  const number = Number(text);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

// Refuses to render a ref whose key or number is missing.
function requireRefParts(what, row, key) {
  if (typeof key !== "string" || key === "" || positiveNumber(row?.number) === null) {
    throw new Error(`cannot render the ref of ${what} ${row?.id ?? "(no id)"}: its owner key or number is missing`);
  }
}

// Picks the owner key a decision row renders with: its org, its project, or the global pseudo-key.
function rowKey(row) {
  if (row?.scope === "org") return row.org_key;
  return (row?.project_id ?? null) === null ? GLOBAL_KEY : row.project_key;
}

// Renders the ref of a decision (`D-<n>`, `<ORGKEY>/D-<n>` or `G/D-<n>`).
export function decisionRef(row) {
  const key = isProjectRow(row) ? "D" : rowKey(row);
  requireRefParts("decision", row, key);
  return isProjectRow(row) ? `D-${row.number}` : `${key}/D-${row.number}`;
}

// Tells whether a row belongs to a registered project, whose decision refs need no key.
function isProjectRow(row) {
  return row?.scope !== "org" && (row?.project_id ?? null) !== null;
}

// Canonicalises a ref candidate to trimmed upper-case text, or null when it is not text or a number.
function refText(value) {
  if (typeof value === "number") return String(value);
  return typeof value === "string" ? value.trim().toUpperCase() : null;
}

// Parses a job or decision ref into its kind and parts, or null when it is neither.
export function parseRef(value) {
  const text = refText(value);
  if (text === null) return null;
  const job = JOB_RE.exec(text);
  if (job) return numbered({ kind: "job" }, "id", job[1]);
  const bare = BARE_DECISION_RE.exec(text);
  if (bare) return numbered({ kind: "decision", key: null }, "number", bare[1]);
  const owned = OWNED_DECISION_RE.exec(text);
  return owned ? numbered({ kind: "decision", key: owned[1] }, "number", owned[2]) : null;
}

// Completes a parsed ref with its number, or null when the number is out of range.
function numbered(ref, field, digits) {
  const number = positiveNumber(digits);
  return number === null ? null : { ...ref, [field]: number };
}

// Resolves a job ref (`J-<id>`) or a plain job id to the id, refusing anything else.
export function parseJobRef(value) {
  const ref = typeof value === "number" && !Number.isInteger(value) ? null : parseRef(value);
  if (ref?.kind !== "job") throw new UserError(`expected a job ref (\`J-<id>\`) or a job id, got \`${value}\``);
  return ref.id;
}

// Splits a name into upper-case alphanumeric hyphen parts, starting at the first letter.
function nameParts(name) {
  const parts = String(name ?? "").toUpperCase().split("-").map((part) => part.replace(/[^A-Z0-9]/g, ""));
  const first = parts.findIndex((part) => /[A-Z]/.test(part));
  if (first === -1) return [];
  return [parts[first].replace(/^\d+/, ""), ...parts.slice(first + 1)].filter(Boolean);
}

// Derives the base key of a name: initials of up to 4 parts, or the first letters of a one-part name's halves.
function baseKey(name, kind) {
  const parts = nameParts(name);
  if (parts.length === 0) {
    const prefix = FALLBACK_PREFIX[kind] ?? FALLBACK_PREFIX.project;
    const first = String(name ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "")[0] ?? prefix;
    return `${prefix}${first}`;
  }
  if (parts.length > 1) return parts.slice(0, 4).map((part) => part[0]).join("");
  const [word] = parts;
  return `${word[0]}${word[Math.floor(word.length / 2)]}`;
}

// Suggests a free key for a project or org name, adding one letter on a collision.
export function suggestKey(name, taken, { kind = "project" } = {}) {
  const used = taken instanceof Set ? taken : new Set(taken ?? []);
  const base = baseKey(name, kind);
  const candidates = [base, ...[...SUFFIXES].map((letter) => `${base}${letter}`)];
  const free = candidates.find((key) => KEY_RE.test(key) && !used.has(key));
  if (!free) throw new UserError(`no free key derives from \`${name}\`; pass one with --key <KEY>`);
  return free;
}

// Yields every key that extends a stem by one to five-minus-stem alphanumerics, shortest first at each level.
function* keyExtensions(stem) {
  if (stem.length >= 5) return;
  for (const char of KEY_CHARS) yield `${stem}${char}`;
  for (const char of KEY_CHARS) yield* keyExtensions(`${stem}${char}`);
}

// Suggests a free key that never runs out: the base, its letter suffixes, then any free extension of a shorter prefix of the base.
export function suggestKeyUnbounded(name, taken, { kind = "project" } = {}) {
  const used = taken instanceof Set ? taken : new Set(taken ?? []);
  const base = baseKey(name, kind);
  if (!used.has(base)) return base;
  for (let stem = base; stem.length > 0; stem = stem.slice(0, -1)) {
    for (const key of keyExtensions(stem)) if (KEY_RE.test(key) && !used.has(key)) return key;
  }
  throw new Error(`every key deriving from \`${name}\` is taken`);
}
