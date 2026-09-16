import { UserError } from "../config/errors.mjs";

/**
 * Pure parser of the artifact the Explore writes: it turns the `## File map` and the
 * `## Third-party libraries` sections into the two lists `index_save` takes. It reads text and
 * nothing else — no filesystem, no store — which is what makes it testable on its own.
 */

const FILE_MAP_HEADINGS = ["## file map"];
const LIBS_HEADINGS = ["## third-party libraries", "## libs"];
const HEADING_RE = /^#{1,6}\s/;
const BULLET_RE = /^[-*]\s+(.*)$/;
const SEPARATORS = [" — ", " -- ", " - "];
const LIB_ENTRY_RE = /^(@?[A-Za-z0-9._][A-Za-z0-9._/-]*)@(v?\d[^\s]*)$/;
const NO_LIBS_RE = /^none\b/i;

// The numbered lines of the first section carrying one of the headings, or null when the artifact has none of them.
function sectionLines(text, headings) {
  const lines = String(text ?? "").split("\n");
  const start = lines.findIndex((line) => headings.includes(line.trim().toLowerCase()));
  if (start === -1) return null;
  const body = [];
  for (let at = start + 1; at < lines.length; at++) {
    if (HEADING_RE.test(lines[at])) break;
    body.push({ number: at + 1, text: lines[at] });
  }
  return body;
}

// The content of a `- ` bullet, or null for any other line.
function bulletBody(line) {
  const match = BULLET_RE.exec(line.text.trim());
  return match ? match[1].trim() : null;
}

// Drops the markdown backticks a path or a lib name may be wrapped in.
function unquote(value) {
  return value.replace(/^`+|`+$/g, "").trim();
}

// Splits a file-map bullet on the first separator whose left side really is a path, or null when it carries none.
function splitFileEntry(body) {
  for (const separator of SEPARATORS) {
    const at = body.indexOf(separator);
    if (at <= 0) continue;
    const path = unquote(body.slice(0, at));
    const responsibility = body.slice(at + separator.length).trim();
    if (!path || /\s/.test(path) || !responsibility) continue;
    return { path, responsibility };
  }
  return null;
}

// The files of the `## File map` section; a bullet that is not `<path> — <responsibility>` is refused instead of being dropped.
function parseFiles(lines) {
  const files = [];
  for (const line of lines) {
    const body = bulletBody(line);
    if (body === null) continue;
    const entry = splitFileEntry(body);
    if (!entry) {
      throw new UserError(
        `\`## File map\` line ${line.number} has no \` — \` between the path and its responsibility: \`${body}\``,
      );
    }
    files.push(entry);
  }
  return files;
}

// The libs of the `## Third-party libraries` section, keeping apart the bullets that are prose rather than `<lib>@<version>`.
function parseLibs(lines) {
  const libs = [];
  const ignored = [];
  for (const line of lines) {
    const body = bulletBody(line);
    if (body === null || NO_LIBS_RE.test(body)) continue;
    const candidate = unquote(body.split(" (")[0]);
    const match = LIB_ENTRY_RE.exec(candidate);
    if (match) libs.push({ lib: match[1], version: match[2] });
    else ignored.push(body);
  }
  return { libs, ignored };
}

// Reads an explore artifact into the file list and the lib list the project index is saved from.
export function parseExploreArtifact(text) {
  const fileLines = sectionLines(text, FILE_MAP_HEADINGS);
  if (!fileLines) throw new UserError("the artifact carries no `## File map` section; nothing to index");
  const files = parseFiles(fileLines);
  if (!files.length) throw new UserError("`## File map` carries no `- <path> — <responsibility>` entry; nothing to index");
  const libLines = sectionLines(text, LIBS_HEADINGS);
  const { libs, ignored } = parseLibs(libLines ?? []);
  return { files, libs, ignoredLibs: ignored, libsSection: libLines !== null };
}
