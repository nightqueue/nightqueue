import { existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { binDir } from "../config/paths.mjs";
import { modeOf, writeFileAtomic } from "../config/store.mjs";
import { userHome } from "./paths.mjs";

export const PATH_MARK = "# nightshift";
export const PATH_MARK_END = "# nightshift end";

const LEGACY_LINE_RE = new RegExp(`^(?:export PATH="[^"]*:\\$PATH"|fish_add_path \\S.*) ${PATH_MARK}[ \t]*$`);

const CASE_HEAD = 'case ":$PATH:" in';
const CASE_SKIP_RE = /^ {2}\*":[^"]*:"\*\) ;;$/;
const CASE_EXPORT_RE = /^ {2}\*\) export PATH="[^"]*:\$PATH" ;;$/;
const CASE_END = "esac";
const FISH_BODY_RE = /^fish_add_path \S.*$/;

// One rc line ready to be compared: the carriage return of a CRLF file never decides whether a region is ours.
function lineAt(lines, index) {
  return String(lines[index] ?? "").replace(/\r$/, "");
}

// Tells whether the lines from this index are exactly the wanted ones.
function matchesLines(lines, index, wanted) {
  return wanted.every((line, offset) => lineAt(lines, index + offset) === line);
}

// Number of lines the body of a region takes: the fish call or the guarded case, and zero when the shape is neither.
function bodySize(lines, index) {
  if (FISH_BODY_RE.test(lineAt(lines, index))) return 1;
  const isCase =
    lineAt(lines, index) === CASE_HEAD &&
    CASE_SKIP_RE.test(lineAt(lines, index + 1)) &&
    CASE_EXPORT_RE.test(lineAt(lines, index + 2)) &&
    lineAt(lines, index + 3) === CASE_END;
  return isCase ? 4 : 0;
}

// Lines that put the shim directory on the PATH, without the markers that delimit them.
function blockBody(env) {
  const dir = binDir(env);
  if (shellFamily(env) === "fish") return [`fish_add_path ${dir}`];
  return [CASE_HEAD, `  *":${dir}:"*) ;;`, `  *) export PATH="${dir}:$PATH" ;;`, CASE_END];
}

// Number of lines the region of ours that starts at this index takes, and zero when nothing of ours starts there: the shape alone never proves ownership, because `# nightshift` is text a user may have typed for any reason - the region has to CLOSE with the end marker, or be exactly the block an older build of this package wrote in this very home.
function ownRegionAt(lines, index, env) {
  if (LEGACY_LINE_RE.test(lineAt(lines, index))) return 1;
  if (lineAt(lines, index) !== PATH_MARK) return 0;
  const body = bodySize(lines, index + 1);
  if (body && lineAt(lines, index + 1 + body) === PATH_MARK_END) return body + 2;
  const previous = blockBody(env);
  return matchesLines(lines, index + 1, previous) ? previous.length + 1 : 0;
}

// Every region of ours in the rc file, in the order they appear.
function scanOwnRegions(lines, env) {
  const regions = [];
  for (let index = 0; index < lines.length; index += 1) {
    const size = ownRegionAt(lines, index, env);
    if (!size) continue;
    regions.push({ start: index, size });
    index += size - 1;
  }
  return regions;
}

// Shell family the rc file belongs to, read from SHELL and defaulting to zsh.
function shellFamily(env) {
  const shell = typeof env?.SHELL === "string" ? env.SHELL.toLowerCase() : "";
  if (shell.includes("fish")) return "fish";
  if (shell.includes("bash")) return "bash";
  return "zsh";
}

// Path of the rc file the PATH line goes into, one file per shell family and never two.
export function rcFilePath(env = process.env) {
  const family = shellFamily(env);
  if (family === "fish") return join(userHome(env), ".config", "fish", "config.fish");
  return join(userHome(env), family === "bash" ? ".bashrc" : ".zshrc");
}

// The marked block that puts the shim directory on the PATH: guarded so sourcing the rc file twice never prepends it twice, and delimited at both ends so nothing the user wrote is ever taken for ours.
export function pathBlock(env = process.env) {
  return [PATH_MARK, ...blockBody(env), PATH_MARK_END].join("\n");
}

// Tells whether the shim directory is already on the PATH of this environment.
export function binDirInPath(env = process.env) {
  const wanted = resolve(binDir(env));
  const raw = typeof env?.PATH === "string" ? env.PATH : "";
  return raw
    .split(delimiter)
    .filter(Boolean)
    .some((entry) => resolve(entry) === wanted);
}

// Reads the rc file, treating an absent one as empty because a fresh machine has none.
function readRcFile(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

// Writes the rc file, following a symlink and keeping the permission bits the user had set on it.
function writeRcFile(path, content) {
  const target = existsSync(path) ? realpathSync(path) : path;
  mkdirSync(dirname(target), { recursive: true });
  writeFileAtomic(target, content, { mode: modeOf(target) ?? undefined });
}

// The lines with the first region of ours replaced by the wanted lines and every other region of ours dropped.
function replaceOwnRegions(lines, regions, wanted) {
  const kept = [];
  let cursor = 0;
  let done = false;
  for (const region of regions) {
    kept.push(...lines.slice(cursor, region.start));
    if (!done) kept.push(...wanted);
    done = true;
    cursor = region.start + region.size;
  }
  kept.push(...lines.slice(cursor));
  return kept;
}

// Tells whether one region already holds exactly the lines we want to write.
function regionMatches(lines, region, wanted) {
  return region.size === wanted.length && matchesLines(lines, region.start, wanted);
}

// Adds our PATH block to the rc file, replacing a stale region of ours and never touching a line we did not write.
export function addPathLine(env = process.env) {
  const path = rcFilePath(env);
  const wanted = pathBlock(env).split("\n");
  const body = readRcFile(path);
  const lines = body.split("\n");
  const regions = scanOwnRegions(lines, env);
  if (regions.length === 1 && regionMatches(lines, regions[0], wanted)) return { path, status: "already present" };
  if (!regions.length) {
    writeRcFile(path, `${body && !body.endsWith("\n") ? `${body}\n` : body}${wanted.join("\n")}\n`);
    return { path, status: "created" };
  }
  writeRcFile(path, replaceOwnRegions(lines, regions, wanted).join("\n"));
  return { path, status: "updated" };
}

// Removes every PATH region this package wrote, of any shape it ever wrote, leaving every other line exactly as it was.
export function removePathLine(env = process.env) {
  const path = rcFilePath(env);
  if (!existsSync(path)) return { path, status: "not present" };
  const lines = readRcFile(path).split("\n");
  const regions = scanOwnRegions(lines, env);
  if (!regions.length) return { path, status: "not present" };
  writeRcFile(path, replaceOwnRegions(lines, regions, []).join("\n"));
  return { path, status: "removed" };
}
