import { constants } from "node:fs";
import { access, chmod } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const HELPER_MODE = 0o755;
const cachedLoads = new Map();

// The first line of an error's message, the reason a terminal is unavailable.
function reasonOf(err) {
  const text = String(err?.message ?? err ?? "unknown error").trim();
  return text.split("\n")[0] || "unknown error";
}

// The directory and version of the installed node-pty, answered by its package.json.
function defaultResolvePackage() {
  const manifest = require.resolve("node-pty/package.json");
  return { dir: dirname(manifest), version: require(manifest).version };
}

// The real file-system and module operations the loader needs, overridable by a test.
function loaderDeps(deps) {
  return {
    importImpl: (name) => import(name),
    resolvePackageImpl: defaultResolvePackage,
    accessImpl: access,
    chmodImpl: chmod,
    platform: process.platform,
    arch: process.arch,
    ...deps,
  };
}

// Tells whether a path passes an access check, never throwing.
async function passes(accessImpl, path, mode) {
  try {
    await accessImpl(path, mode);
    return true;
  } catch {
    return false;
  }
}

// The spawn-helper node-pty runs on darwin: the prebuilt one for this platform, else the one a local build produced, or null.
async function findSpawnHelper(dir, d) {
  const candidates = [join(dir, "prebuilds", `${d.platform}-${d.arch}`, "spawn-helper"), join(dir, "build", "Release", "spawn-helper")];
  for (const path of candidates) {
    if (await passes(d.accessImpl, path, constants.F_OK)) return path;
  }
  return null;
}

// Chmods the spawn-helper to 0755 and tells whether it is executable afterwards, never throwing.
async function madeExecutable(helper, d) {
  try {
    await d.chmodImpl(helper, HELPER_MODE);
    return await passes(d.accessImpl, helper, constants.X_OK);
  } catch {
    return false;
  }
}

// Makes the darwin spawn-helper executable when allowed to, answering the reason it stays unusable, or null when it is fine.
async function spawnHelperProblem(dir, { fix, d }) {
  if (d.platform !== "darwin") return null;
  const helper = await findSpawnHelper(dir, d);
  if (helper === null || (await passes(d.accessImpl, helper, constants.X_OK))) return null;
  if (fix && (await madeExecutable(helper, d))) return null;
  return { reason: `spawn-helper not executable (${helper})`, helper };
}

// Loads node-pty once, answering `{ available, pty, version }` or `{ available: false, reason }`.
async function loadNow({ fix, deps }) {
  const d = loaderDeps(deps);
  let pty;
  let found;
  try {
    const mod = await d.importImpl("node-pty");
    pty = mod?.default ?? mod;
    if (typeof pty?.spawn !== "function") return { available: false, reason: "node-pty exposes no spawn function" };
    found = d.resolvePackageImpl();
  } catch (err) {
    return { available: false, reason: reasonOf(err) };
  }
  const problem = await spawnHelperProblem(found.dir, { fix, d });
  if (problem) return { available: false, ...problem };
  return { available: true, pty, version: found.version };
}

// The node-pty module the studio spawns terminals with, imported only here and only on demand; `fix` lets the loader chmod the darwin spawn-helper of nightqueue's own install.
export function loadPty({ fix = true, deps = null } = {}) {
  if (deps) return loadNow({ fix, deps });
  const key = fix ? "fix" : "report";
  if (!cachedLoads.has(key)) cachedLoads.set(key, loadNow({ fix, deps: {} }));
  return cachedLoads.get(key);
}
