import { readFileSync } from "node:fs";

// Filesystem types known to drop or to emulate incorrectly the POSIX advisory locks SQLite's WAL depends on; anything carrying `fuse` joins them.
export const RISKY_FS_TYPES = ["nfs", "nfs3", "nfs4", "smbfs", "cifs", "afpfs", "webdav", "9p"];

// Files the Linux kernel writes the mount table to, in the order they are tried.
const LINUX_MOUNT_SOURCES = ["/proc/mounts", "/proc/self/mountinfo"];

const MOUNTINFO_LINE = /^\d+\s+\d+\s+\d+:\d+\s/;
const DARWIN_MOUNT_LINE = / on (.*) \(([^,)]+)[,)]/;

// Tells whether a filesystem type is one where a WAL database cannot be trusted.
export function isRiskyFsType(type) {
  const value = typeof type === "string" ? type.trim().toLowerCase() : "";
  if (!value) return false;
  return value.includes("fuse") || RISKY_FS_TYPES.some((risky) => value.startsWith(risky));
}

// Mount point as the kernel really means it: `/proc` escapes a space, a tab and a backslash as octal.
function unescapeOctal(point) {
  return point.replace(/\\(\d{3})/g, (_, octal) => String.fromCharCode(Number.parseInt(octal, 8)));
}

// One entry of a Linux line, reading `/proc/mounts` (`device point fstype ...`) and `/proc/self/mountinfo` (`... point ... - fstype ...`) alike.
function parseLinuxLine(line) {
  if (!MOUNTINFO_LINE.test(line)) {
    const [, point, type] = line.split(/\s+/);
    return point && type ? { point: unescapeOctal(point), type } : null;
  }
  const separator = line.indexOf(" - ");
  if (separator === -1) return null;
  const point = line.slice(0, separator).split(/\s+/)[4];
  const type = line.slice(separator + 3).trim().split(/\s+/)[0];
  return point && type ? { point: unescapeOctal(point), type } : null;
}

// One entry of a `mount` line of macOS, taking the first ` on ` and the last ` (` so a mount point with spaces survives.
function parseDarwinLine(line) {
  const found = DARWIN_MOUNT_LINE.exec(line);
  return found ? { point: found[1], type: found[2].trim() } : null;
}

// Mount entries of a mount table, one `{ point, type }` per line, in the format the platform writes.
export function parseMountEntries(text, platform = process.platform) {
  const parse = platform === "darwin" ? parseDarwinLine : parseLinuxLine;
  return String(text ?? "")
    .split("\n")
    .map((line) => (line.trim() ? parse(line) : null))
    .filter(Boolean);
}

// Tells whether a mount point covers a path, comparing whole segments so `/Users/foo` never sits under a mount at `/Users/foobar`.
function coversPath(point, path) {
  if (point === "/") return path.startsWith("/");
  return path === point || path.startsWith(`${point}/`);
}

// The entry whose mount point is the longest prefix of the path, the one really in effect there.
export function longestMountMatch(entries, path) {
  let best = null;
  for (const entry of entries) {
    if (!coversPath(entry.point, path)) continue;
    if (!best || entry.point.length >= best.point.length) best = entry;
  }
  return best;
}

// Mount table of Linux, trying every file the kernel publishes it in and naming every failure when none answers.
function readLinuxTable(readFileImpl) {
  const failures = [];
  for (const source of LINUX_MOUNT_SOURCES) {
    try {
      return { text: readFileImpl(source, "utf8"), source, error: null };
    } catch (err) {
      failures.push(`${source} (${err?.message ?? String(err)})`);
    }
  }
  return { text: "", source: null, error: `no mount table could be read: ${failures.join(", ")}` };
}

// Mount table of macOS, read through the injected `mount` runner because this module never spawns a process itself.
function readDarwinTable(runMount) {
  if (typeof runMount !== "function") return { text: "", source: null, error: "no way to run `mount` was given" };
  const result = runMount();
  if (result?.ok) return { text: result.stdout, source: "mount", error: null };
  return { text: "", source: null, error: result?.missing ? "`mount` is not on this host" : "`mount` did not answer" };
}

// Mount table of the host, or the reason this platform has no source that can answer.
function readMountTable({ platform, runMount, readFileImpl }) {
  if (platform === "darwin") return readDarwinTable(runMount);
  if (platform === "linux") return readLinuxTable(readFileImpl);
  return { text: "", source: null, error: `no mount table is known for ${platform}` };
}

// The mount a path sits on - `{ point, type, source }` - or `{ unknown }` stating why this host cannot answer; a mount that cannot be named is never reported as local.
export function mountOfPath(path, { platform = process.platform, runMount = null, readFileImpl = readFileSync } = {}) {
  const table = readMountTable({ platform, runMount, readFileImpl });
  if (table.error) return { unknown: table.error };
  const entry = longestMountMatch(parseMountEntries(table.text, platform), path);
  return entry ? { point: entry.point, type: entry.type, source: table.source } : { unknown: `no entry of \`${table.source}\` covers ${path}` };
}
