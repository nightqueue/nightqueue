import { existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { binDir } from "../config/paths.mjs";
import { modeOf, writeFileAtomic } from "../config/store.mjs";
import { userHome } from "./paths.mjs";

export const PATH_MARK = "# nightshift";

const OWN_LINE_RE = new RegExp(`^(?:export PATH="[^"]*:\\$PATH"|fish_add_path \\S.*) ${PATH_MARK}[ \t]*$`);

// Tells whether an rc line is a PATH line this package wrote: the whole line has to have the shape we write, because the mark alone is text a user may have typed for any reason.
function isOwnLine(line) {
  return OWN_LINE_RE.test(line);
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

// The single marked line that puts the shim directory on the PATH.
export function pathLine(env = process.env) {
  const dir = binDir(env);
  if (shellFamily(env) === "fish") return `fish_add_path ${dir} ${PATH_MARK}`;
  return `export PATH="${dir}:$PATH" ${PATH_MARK}`;
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

// The lines with the first line of ours replaced by the wanted one and every other line of ours dropped.
function replaceOwnLines(lines, wanted) {
  let done = false;
  return lines.flatMap((line) => {
    if (!isOwnLine(line)) return [line];
    if (done) return [];
    done = true;
    return [wanted];
  });
}

// Adds our PATH line to the rc file, replacing a stale line of ours and never touching a line we did not write.
export function addPathLine(env = process.env) {
  const path = rcFilePath(env);
  const wanted = pathLine(env);
  const body = readRcFile(path);
  const lines = body.split("\n");
  const own = lines.filter(isOwnLine);
  if (own.length === 1 && own[0] === wanted) return { path, status: "already present" };
  if (!own.length) {
    writeRcFile(path, `${body && !body.endsWith("\n") ? `${body}\n` : body}${wanted}\n`);
    return { path, status: "created" };
  }
  writeRcFile(path, replaceOwnLines(lines, wanted).join("\n"));
  return { path, status: "updated" };
}

// Removes every PATH line this package wrote, leaving every other line exactly as it was.
export function removePathLine(env = process.env) {
  const path = rcFilePath(env);
  if (!existsSync(path)) return { path, status: "not present" };
  const lines = readRcFile(path).split("\n");
  const kept = lines.filter((line) => !isOwnLine(line));
  if (kept.length === lines.length) return { path, status: "not present" };
  writeRcFile(path, kept.join("\n"));
  return { path, status: "removed" };
}
