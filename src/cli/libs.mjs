import { readFileSync } from "node:fs";
import { join } from "node:path";
import { UserError } from "../config/errors.mjs";
import { checkArgs, parseCommand } from "./args.mjs";

const USAGE = "nightshift libs <name>...";
const NOT_FOUND = "not-found";
const VERSION_RE = /^v?\d\S*$/;
const PNPM_ENTRY_RE = /^\s+['"]?\/?(\S+?)['"]?:(?:\s|$)/;
const YARN_VERSION_RE = /^\s+version:?\s+"?([^"\s]+)"?/;
const TOML_FIELD_RE = /^(name|version)\s*=\s*"([^"]+)"/;
const REQUIREMENT_RE = /^([A-Za-z0-9._-]+)\s*==\s*([^\s;#]+)/;
const GO_MOD_RE = /^(?:require\s+)?(\S+)\s+(v\S+)/;
const GO_MOD_SUFFIX = "/go.mod";

// The value read, when it really is a version; anything else is refused so a misparse never prints a wrong version.
function asVersion(raw) {
  const value = String(raw ?? "").trim().replace(/^['"]|['"]$/g, "");
  return VERSION_RE.test(value) ? value : null;
}

// Parses one lockfile as JSON, naming the file when it is not.
function parseJson(text, file) {
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new UserError(`${file} is not valid JSON: ${err?.message ?? String(err)}`);
  }
}

// Entry of a v2/v3 npm lockfile for one name, the top-level installation winning over a nested one.
function npmPackageEntry(packages, name) {
  const direct = packages[`node_modules/${name}`];
  if (direct) return direct;
  const nested = Object.keys(packages).find((key) => key.endsWith(`/node_modules/${name}`));
  return nested ? packages[nested] : null;
}

// Version a v1 npm lockfile records for one name, walking the nested dependency trees it uses.
function npmV1Version(dependencies, name) {
  if (!dependencies || typeof dependencies !== "object") return null;
  const direct = dependencies[name];
  const version = direct && typeof direct === "object" ? asVersion(direct.version) : null;
  if (version) return version;
  for (const entry of Object.values(dependencies)) {
    const found = entry && typeof entry === "object" ? npmV1Version(entry.dependencies, name) : null;
    if (found) return found;
  }
  return null;
}

// Version a npm lockfile records for one name, in both the v1 and the v2/v3 layout.
function npmVersion(text, name, file) {
  const lock = parseJson(text, file);
  const packages = lock?.packages;
  if (packages && typeof packages === "object") {
    const entry = npmPackageEntry(packages, name);
    const version = entry && typeof entry === "object" ? asVersion(entry.version) : null;
    if (version) return version;
  }
  return npmV1Version(lock?.dependencies, name);
}

// Version a pnpm lockfile records for one name, covering the `/<name>/<version>`, `/<name>@<version>` and `<name>@<version>` keys of its three layouts.
function pnpmVersion(text, name) {
  for (const line of text.split("\n")) {
    const match = PNPM_ENTRY_RE.exec(line);
    if (!match) continue;
    const key = match[1].replace(/\(.*$/, "");
    for (const separator of ["@", "/"]) {
      if (!key.startsWith(`${name}${separator}`)) continue;
      const version = asVersion(key.slice(name.length + 1));
      if (version) return version;
    }
  }
  return null;
}

// Package names one yarn block header lists, a header carrying one or more specs in either layout.
function yarnBlockNames(header) {
  return header.replace(/:\s*$/, "").split(",").map((spec) => {
    const clean = spec.trim().replace(/^['"]|['"]$/g, "");
    const at = clean.indexOf("@", 1);
    return at === -1 ? clean : clean.slice(0, at);
  });
}

// Version a yarn lockfile records for one name, in both the classic and the berry layout.
function yarnVersion(text, name) {
  let inBlock = false;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    if (!/^\s/.test(line)) {
      inBlock = !line.startsWith("#") && yarnBlockNames(line).includes(name);
      continue;
    }
    const match = inBlock ? YARN_VERSION_RE.exec(line) : null;
    if (match) return asVersion(match[1]);
  }
  return null;
}

// Versions a `[[package]]` lockfile (poetry, Cargo) records, keyed by the package name it declares.
function tomlPackages(text) {
  const found = new Map();
  let current = null;
  for (const line of text.split("\n")) {
    const match = TOML_FIELD_RE.exec(line.trim());
    if (!match) continue;
    if (match[1] === "name") {
      current = match[2];
      continue;
    }
    const version = asVersion(match[2]);
    if (current && version && !found.has(current)) found.set(current, version);
  }
  return found;
}

// Version a Cargo lockfile records for one crate; crate names are compared exactly, `serde_json` not being `serde-json`.
function cargoVersion(text, name) {
  return tomlPackages(text).get(name) ?? null;
}

// Python distribution names compare case-insensitively, with `-`, `_` and `.` equivalent.
function normalizePython(value) {
  return value.toLowerCase().replace(/[-_.]+/g, "-");
}

// Version a poetry lockfile records for one distribution.
function poetryVersion(text, name) {
  const wanted = normalizePython(name);
  for (const [found, version] of tomlPackages(text)) {
    if (normalizePython(found) === wanted) return version;
  }
  return null;
}

// Version a pip requirements file pins for one distribution.
function requirementsVersion(text, name) {
  const wanted = normalizePython(name);
  for (const line of text.split("\n")) {
    const match = REQUIREMENT_RE.exec(line.trim());
    if (match && normalizePython(match[1]) === wanted) return asVersion(match[2]);
  }
  return null;
}

// Version a go.sum records for one module, the `/go.mod` hash line answering when it is the only one.
function goSumVersion(text, name) {
  let fromGoMod = null;
  for (const line of text.split("\n")) {
    const [module, raw] = line.trim().split(/\s+/);
    if (module !== name || !raw) continue;
    if (!raw.endsWith(GO_MOD_SUFFIX)) {
      const version = asVersion(raw);
      if (version) return version;
      continue;
    }
    fromGoMod = fromGoMod ?? asVersion(raw.slice(0, -GO_MOD_SUFFIX.length));
  }
  return fromGoMod;
}

// Version a go.mod requires for one module.
function goModVersion(text, name) {
  for (const line of text.split("\n")) {
    const match = GO_MOD_RE.exec(line.trim());
    if (match && match[1] === name) return asVersion(match[2]);
  }
  return null;
}

const LOCKFILES = [
  ["package-lock.json", npmVersion],
  ["pnpm-lock.yaml", pnpmVersion],
  ["yarn.lock", yarnVersion],
  ["poetry.lock", poetryVersion],
  ["requirements.txt", requirementsVersion],
  ["Cargo.lock", cargoVersion],
  ["go.sum", goSumVersion],
  ["go.mod", goModVersion],
];

// Reads one lockfile, treating an absent file as absent and leaving any other read error to the caller.
function readLockfile(path) {
  try {
    return readFileSync(path, "utf8");
  } catch (err) {
    if (err?.code === "ENOENT" || err?.code === "EISDIR") return null;
    throw new UserError(`${path} cannot be read: ${err?.message ?? String(err)}`);
  }
}

// Lockfiles the directory carries, each read once for the whole command.
function readLockfiles(dir) {
  const found = [];
  for (const [file, read] of LOCKFILES) {
    const text = readLockfile(join(dir, file));
    if (text !== null) found.push({ file, text, read });
  }
  return found;
}

// Installed version of one name, the first lockfile that carries it answering.
function resolveVersion(lockfiles, name) {
  for (const lock of lockfiles) {
    const version = lock.read(lock.text, name, lock.file);
    if (version) return version;
  }
  return null;
}

// Runs `nightshift libs`: prints the INSTALLED version of each named lib, read from the lockfiles of the current directory, one line per name and in the order given.
export function run(argv, ctx) {
  const { positionals } = parseCommand(argv, {});
  const names = checkArgs(positionals, { min: 1, max: Number.POSITIVE_INFINITY, usage: USAGE });
  const lockfiles = readLockfiles(ctx.cwd);
  if (!lockfiles.length) ctx.err(`nightshift libs: no lockfile in ${ctx.cwd}; every name is reported ${NOT_FOUND}`);
  for (const name of names) ctx.out(`${name} ${resolveVersion(lockfiles, name) ?? NOT_FOUND}`);
  return 0;
}
