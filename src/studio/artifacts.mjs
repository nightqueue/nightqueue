import { closeSync, lstatSync, openSync, readdirSync, readSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { cutUtf8 } from "../queue/narrate.mjs";

const TITLE_SCAN_BYTES = 64 * 1024;
export const ARTIFACT_CAP_BYTES = 1024 * 1024;
const HEADING_RE = /^#{1,6}\s+/;

// The `*.md` names of a run directory that are not dotfiles, sorted; an unreadable or absent directory has none.
function markdownNames(dir) {
  try {
    return readdirSync(dir)
      .filter((name) => name.endsWith(".md") && !name.startsWith("."))
      .sort();
  } catch {
    return [];
  }
}

// The lstat of a name inside the directory when it is a regular file, null for a symlink, a directory or a failed read.
function regularFileStat(dir, name) {
  try {
    const stat = lstatSync(join(dir, name));
    return stat.isFile() ? stat : null;
  } catch {
    return null;
  }
}

// The path and stat of an artifact named by an outside caller, null unless the name is a listed regular file inside the directory.
function trustedArtifact(dir, name) {
  if (typeof dir !== "string" || !dir || typeof name !== "string" || !markdownNames(dir).includes(name)) return null;
  const root = resolve(dir);
  const path = resolve(root, name);
  if (!path.startsWith(root + sep)) return null;
  const stat = regularFileStat(root, name);
  return stat ? { path, stat } : null;
}

// The first bytes of a file, at most `limit` of them, closing the descriptor whatever happens.
function readHead(path, limit) {
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(limit);
    const read = readSync(fd, buffer, 0, limit, 0);
    return buffer.subarray(0, read);
  } finally {
    closeSync(fd);
  }
}

// The text of the first markdown heading in the first 64 KiB of a file, null when there is none or the read fails.
function readTitle(path) {
  try {
    const text = readHead(path, TITLE_SCAN_BYTES).toString("utf8");
    const line = text.split("\n").find((candidate) => HEADING_RE.test(candidate));
    return line ? line.replace(HEADING_RE, "").trim() || null : null;
  } catch {
    return null;
  }
}

// The regular `*.md` files of a run directory with their size, title and mtime, sorted by name.
export function listArtifacts(dir) {
  if (typeof dir !== "string" || !dir) return [];
  const entries = [];
  for (const name of markdownNames(dir)) {
    const stat = regularFileStat(dir, name);
    if (stat) entries.push({ name, bytes: stat.size, title: readTitle(join(dir, name)), mtime: stat.mtime.toISOString() });
  }
  return entries;
}

// The size and title of one artifact of the run directory, or null when the name is not a listed regular `*.md` file.
export function artifactSummary(dir, name) {
  const found = trustedArtifact(dir, name);
  return found ? { bytes: found.stat.size, title: readTitle(found.path) } : null;
}

// The text of one artifact, cut at a code point boundary above the cap; null when the name is not a listed regular `*.md` file.
export function readArtifactFile(dir, name, cap = ARTIFACT_CAP_BYTES) {
  const found = trustedArtifact(dir, name);
  if (!found) return null;
  const head = readHead(found.path, Math.min(found.stat.size, cap + 1));
  const truncated = head.length > cap;
  return { text: (truncated ? cutUtf8(head, cap) : head).toString("utf8"), truncated };
}
