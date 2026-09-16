import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { UserError } from "../config/errors.mjs";

// The checks `nightshift verify` reports, in the order it runs them; `diff-hygiene` is the runtime's own and is never detected.
export const CHECK_ORDER = ["typecheck", "lint", "build", "test", "poc", "diff-hygiene"];

const LOCKFILES = [
  ["bun.lockb", "bun"],
  ["bun.lock", "bun"],
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["package-lock.json", "npm"],
];

const PNPM_WORKSPACE = "pnpm-workspace.yaml";
const SCRIPT_CHECKS = ["typecheck", "lint", "build", "test"];
const POC_SCRIPTS = ["test:poc", "test:fuzz"];
const POC_FILE_RE = /\.(poc|fuzz|regression)\.(test|spec)\.[A-Za-z0-9]+$/;
const IGNORED_DIRS = new Set(["node_modules", "dist", "build", "target", "vendor", "coverage"]);
const POC_WALK_DEPTH = 4;

// Package manager the lockfiles of a directory name; a Node project with no lockfile is an npm project.
export function detectPackageManager(dir) {
  for (const [file, manager] of LOCKFILES) {
    if (existsSync(join(dir, file))) return manager;
  }
  return "npm";
}

// Reads one manifest, treating an absent file as absent and leaving any other read error to the caller.
function readManifest(path) {
  try {
    return readFileSync(path, "utf8");
  } catch (err) {
    if (err?.code === "ENOENT") return null;
    throw new UserError(`${path} cannot be read: ${err?.message ?? String(err)}`);
  }
}

// Manifest of a Node project, or null when there is none; a manifest that is not valid JSON is refused instead of read as "no checks".
function readPackageJson(dir) {
  const path = join(dir, "package.json");
  const text = readManifest(path);
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new UserError(`${path} is not valid JSON: ${err?.message ?? String(err)}`);
  }
}

// Paths, relative to the project root, of the PoC, fuzz and regression files of one directory; the walk is depth-bounded so detection never crosses a whole disk.
function walkPocFiles(root, dir, depth) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const found = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (depth > 0 && !IGNORED_DIRS.has(entry.name) && !entry.name.startsWith(".")) found.push(...walkPocFiles(root, path, depth - 1));
      continue;
    }
    if (POC_FILE_RE.test(entry.name)) found.push(relative(root, path));
  }
  return found;
}

// Paths of the PoC, fuzz and regression files the project carries.
export function findPocFiles(dir) {
  return walkPocFiles(dir, dir, POC_WALK_DEPTH).sort();
}

// The script a manifest declares under that name, or null when it declares none.
function scriptOf(scripts, name) {
  return typeof scripts?.[name] === "string" && scripts[name] ? scripts[name] : null;
}

// Scripts of one manifest, always an object.
function scriptsOf(manifest) {
  return manifest?.scripts && typeof manifest.scripts === "object" ? manifest.scripts : {};
}

// Command that runs the PoCs: the script the project declares for them, or its own test script narrowed to the PoC files.
function pocCheck(dir, manager, scripts) {
  const declared = POC_SCRIPTS.find((name) => scriptOf(scripts, name));
  if (declared) return { file: manager, args: ["run", declared], acceptsFiles: false };
  const files = findPocFiles(dir);
  if (!files.length || !scriptOf(scripts, "test")) return null;
  return { file: manager, args: ["run", "test", "--", ...files], acceptsFiles: false };
}

// The `packages:` list of a `pnpm-workspace.yaml`, read as the flat list of quoted or bare entries it really is.
function pnpmWorkspacePatterns(dir) {
  const text = readManifest(join(dir, PNPM_WORKSPACE));
  if (text === null) return [];
  const patterns = [];
  let inList = false;
  for (const line of text.split("\n")) {
    if (/^packages\s*:/.test(line)) {
      inList = true;
      continue;
    }
    const entry = inList ? /^\s*-\s*(.+?)\s*$/.exec(line) : null;
    if (entry) patterns.push(entry[1].replace(/^["']|["']$/g, ""));
    else if (inList && line.trim() && !line.startsWith(" ")) inList = false;
  }
  return patterns;
}

// Every workspace pattern the root declares: the `workspaces` of the manifest (array or yarn's `{ packages: [...] }`) and pnpm's own file.
function workspacePatterns(dir, manifest) {
  const declared = manifest?.workspaces;
  const fromManifest = Array.isArray(declared) ? declared : Array.isArray(declared?.packages) ? declared.packages : [];
  return [...fromManifest, ...pnpmWorkspacePatterns(dir)].filter((pattern) => typeof pattern === "string" && pattern.trim());
}

// Subdirectories of one directory a `*` segment may expand to.
function childDirs(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !IGNORED_DIRS.has(entry.name) && !entry.name.startsWith("."))
      .map((entry) => join(dir, entry.name));
  } catch {
    return [];
  }
}

// Every directory under one directory, down to the bounded depth the detection walks.
function descendants(dir, depth) {
  if (depth <= 0) return [];
  return childDirs(dir).flatMap((child) => [child, ...descendants(child, depth - 1)]);
}

// Directories one workspace pattern names, `*` expanding one level and `**` every level down to the bounded depth of the walk.
function expandPattern(dir, pattern) {
  let found = [dir];
  for (const segment of pattern.split("/").filter(Boolean)) {
    if (segment === "**") found = found.flatMap((base) => [base, ...descendants(base, POC_WALK_DEPTH)]);
    else if (segment.includes("*")) found = found.flatMap((base) => childDirs(base));
    else found = found.map((base) => join(base, segment)).filter((path) => existsSync(path));
  }
  return found;
}

// The workspace members of a root: every directory its patterns name that really carries a manifest, minus the `!` patterns that exclude one.
function workspaceMembers(dir, patterns) {
  const excluded = new Set(patterns.filter((pattern) => pattern.startsWith("!")).flatMap((pattern) => expandPattern(dir, pattern.slice(1))));
  const included = patterns.filter((pattern) => !pattern.startsWith("!")).flatMap((pattern) => expandPattern(dir, pattern));
  return [...new Set(included)]
    .filter((path) => path !== dir && !excluded.has(path) && existsSync(join(path, "package.json")))
    .sort()
    .map((path) => ({ dir: path, name: relative(dir, path), scripts: scriptsOf(readPackageJson(path)) }));
}

// The script one member declares for a check: the script of the same name, and for `poc` the first of the PoC scripts.
function memberScript(scripts, name) {
  if (name !== "poc") return scriptOf(scripts, name) ? name : null;
  return POC_SCRIPTS.find((poc) => scriptOf(scripts, poc)) ?? null;
}

// Checks the workspace members declare: one run per member that declares the script, so a root with no scripts of its own never reports a member's check as absent.
function memberChecks(manager, members) {
  const checks = new Map();
  for (const name of [...SCRIPT_CHECKS, "poc"]) {
    const runs = members.flatMap((member) => {
      const script = memberScript(member.scripts, name);
      return script ? [{ args: ["run", script], cwd: member.dir, member: member.name }] : [];
    });
    if (runs.length) checks.set(name, { file: manager, acceptsFiles: false, runs });
  }
  return checks;
}

// Checks a Node project declares: one per script named after a check, always run through the project's own package manager and
// never through a global `npx`/`bunx`. A script the root does not declare is looked for in the workspace members it names,
// because a workspace root with no scripts of its own is not a project with no checks.
function nodeChecks(dir, warn) {
  const checks = new Map();
  const manifest = readPackageJson(dir);
  if (!manifest) return checks;
  const manager = detectPackageManager(dir);
  const scripts = scriptsOf(manifest);
  for (const name of SCRIPT_CHECKS) {
    if (scriptOf(scripts, name)) checks.set(name, { file: manager, args: ["run", name], acceptsFiles: name === "lint" });
  }
  const poc = pocCheck(dir, manager, scripts);
  if (poc) checks.set("poc", poc);
  const patterns = workspacePatterns(dir, manifest);
  if (!patterns.length) return checks;
  const members = workspaceMembers(dir, patterns);
  if (!members.length) warn(`${dir} declares the workspaces ${patterns.join(", ")} but no member carries a package.json`);
  for (const [name, command] of memberChecks(manager, members)) {
    if (!checks.has(name)) checks.set(name, command);
  }
  return checks;
}

const MAKE_TARGET_RE = /^([A-Za-z0-9_.-]+)\s*:(?!=)/;

// Checks a Makefile declares, one per target named after a check.
function makeChecks(dir) {
  const checks = new Map();
  const text = readManifest(join(dir, "Makefile"));
  if (text === null) return checks;
  const targets = new Set();
  for (const line of text.split("\n")) {
    const match = MAKE_TARGET_RE.exec(line);
    if (match) targets.add(match[1]);
  }
  for (const name of SCRIPT_CHECKS) {
    if (targets.has(name)) checks.set(name, { file: "make", args: [name], acceptsFiles: false });
  }
  return checks;
}

// Checks a Python project declares through its pyproject manifest.
function pythonChecks(dir) {
  const checks = new Map();
  if (!existsSync(join(dir, "pyproject.toml"))) return checks;
  checks.set("lint", { file: "ruff", args: ["check", "."], acceptsFiles: false });
  checks.set("test", { file: "pytest", args: [], acceptsFiles: false });
  return checks;
}

// Checks a Go module declares.
function goChecks(dir) {
  const checks = new Map();
  if (!existsSync(join(dir, "go.mod"))) return checks;
  checks.set("build", { file: "go", args: ["build", "./..."], acceptsFiles: false });
  checks.set("test", { file: "go", args: ["test", "./..."], acceptsFiles: false });
  return checks;
}

// Checks a Cargo crate declares.
function rustChecks(dir) {
  const checks = new Map();
  if (!existsSync(join(dir, "Cargo.toml"))) return checks;
  checks.set("typecheck", { file: "cargo", args: ["check"], acceptsFiles: false });
  checks.set("test", { file: "cargo", args: ["test"], acceptsFiles: false });
  return checks;
}

const LADDER = [nodeChecks, makeChecks, pythonChecks, goChecks, rustChecks];

// Command of every check the project really declares, the first source of the ladder that names a check winning it; a check no
// source names is simply absent, never invented, and a layout the detection could not read through is reported to `warn`.
export function detectChecks(dir, { warn = () => {} } = {}) {
  const found = new Map();
  for (const source of LADDER) {
    for (const [name, command] of source(dir, warn)) {
      if (!found.has(name)) found.set(name, command);
    }
  }
  return found;
}
