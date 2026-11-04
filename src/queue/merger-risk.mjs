import { UserError } from "../config/errors.mjs";

export const DEFAULT_MERGER_RISK = Object.freeze([
  "package.json",
  "*-lock.json",
  "*.lock",
  "pnpm-lock.yaml",
  "bun.lockb",
  "Cargo.lock",
  "go.sum",
  "poetry.lock",
  "Gemfile.lock",
]);

const PATTERN_MAX_CHARS = 200;
const GLOB_TOKENS = /(\*\*\/|\*\*|\*|\?)/;
const CONTROL_CHAR = /[\u0000-\u001f\u007f]/;

// The canonical form of a glob: no leading `./` and no trailing `/`.
function canonicalPattern(pattern) {
  return pattern.replace(/^(?:\.\/+)+/, "").replace(/\/+$/, "");
}

// The glob split into its wildcard tokens and one token per literal character.
function globTokens(pattern) {
  return pattern.split(GLOB_TOKENS).flatMap((part, index) => (index % 2 === 1 ? [part] : part.split("")));
}

// One row of the match table: whether this token and every later one match the subject from each position.
function tokenRow(token, subject, next) {
  const row = Array(subject.length + 1).fill(false);
  let crossing = false;
  for (let j = subject.length; j >= 0; j -= 1) {
    const char = subject[j];
    const segmentChar = char !== undefined && char !== "/";
    if (token === "**/") {
      crossing = char !== undefined && ((char === "/" && next[j + 1]) || crossing);
      row[j] = next[j] || crossing;
    } else if (token === "**") row[j] = next[j] || (char !== undefined && row[j + 1]);
    else if (token === "*") row[j] = next[j] || (segmentChar && row[j + 1]);
    else if (token === "?") row[j] = segmentChar && next[j + 1];
    else row[j] = char === token && next[j + 1];
  }
  return row;
}

// The positions of the subject from which the glob matches up to its end or up to a `/` (a directory the path lies under), in time linear in each.
function matchStarts(pattern, subject) {
  const ends = Array.from({ length: subject.length + 1 }, (_, j) => j === subject.length || subject[j] === "/");
  return globTokens(pattern).reduceRight((next, token) => tokenRow(token, subject, next), ends);
}

// Tells whether a repo-relative path matches one risk pattern, or lies under a directory it matches: a pattern without `/` matches any segment, one with `/` the path from its root.
export function riskPatternMatches(path, pattern) {
  if (typeof path !== "string" || typeof pattern !== "string") return false;
  const glob = canonicalPattern(pattern);
  if (!glob) return false;
  const subject = path.replace(/^\.\//, "");
  const starts = matchStarts(glob, subject);
  if (glob.includes("/")) return starts[0];
  return starts.some((hit, j) => hit && (j === 0 || subject[j - 1] === "/"));
}

// One risk pattern validated, trimmed and made canonical, or a refusal naming what is wrong with it.
export function requireRiskPattern(value) {
  if (typeof value !== "string") throw new UserError("a merger risk pattern must be a text glob");
  const trimmed = value.trim();
  if (trimmed.startsWith("/")) throw new UserError(`the merger risk pattern \`${trimmed}\` must be relative to the repository, not start with /`);
  const pattern = canonicalPattern(trimmed);
  if (!pattern) throw new UserError("a merger risk pattern cannot be empty");
  if (pattern.length > PATTERN_MAX_CHARS) throw new UserError(`the merger risk pattern \`${pattern.slice(0, 40)}...\` is over ${PATTERN_MAX_CHARS} characters`);
  if (CONTROL_CHAR.test(pattern)) throw new UserError("a merger risk pattern cannot carry a control character");
  if (pattern.split("/").includes("..")) throw new UserError(`the merger risk pattern \`${pattern}\` cannot carry a .. segment`);
  return pattern;
}

// The risk list a project runs with: its own stored list, or the default one when it has none.
export function effectiveRisk(stored) {
  return stored ?? DEFAULT_MERGER_RISK;
}
