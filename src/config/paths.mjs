import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Resolves the configuration home, reading the environment on every call.
export function homeDir(env = process.env) {
  const raw = typeof env?.NIGHTSHIFT_HOME === "string" ? env.NIGHTSHIFT_HOME.trim() : "";
  return raw ? resolve(raw) : join(homedir(), ".nightshift");
}

// Path of the configuration file.
export function configPath(env = process.env) {
  return join(homeDir(env), "config.json");
}

// Path of the secrets file.
export function secretsPath(env = process.env) {
  return join(homeDir(env), "secrets.json");
}

// Path of the SQLite database of the memory runtime.
export function dbPath(env = process.env) {
  return join(homeDir(env), "nightshift.db");
}

// Path of the shared-memory index of the WAL, the file every open connection of the database maps.
export function dbShmPath(env = process.env) {
  return `${dbPath(env)}-shm`;
}

// Path of the cache of the update check: the newest published version and when it was asked for.
export function updateCheckPath(env = process.env) {
  return join(homeDir(env), "update-check.json");
}

// Directory of the embedding model weights, kept outside node_modules on purpose.
export function modelsDir(env = process.env) {
  return join(homeDir(env), "models");
}

// Directory of the self-contained runtime: the root that holds every installed version and the link that names the live one.
export function runtimeDir(env = process.env) {
  return join(homeDir(env), "runtime");
}

// Directory that holds one npm prefix per installed version, the only place an install ever writes a new tree into.
export function runtimeVersionsDir(env = process.env) {
  return join(runtimeDir(env), "versions");
}

// Path of the link that names the version the host runs, the single thing an install ever swaps.
export function runtimeCurrentLink(env = process.env) {
  return join(runtimeDir(env), "current");
}

// Name this package declares to npm, read once because it is the identity the installed layout is built from.
function declaredPackageName() {
  const path = fileURLToPath(new URL("../../package.json", import.meta.url));
  let name;
  try {
    name = JSON.parse(readFileSync(path, "utf8"))?.name;
  } catch (err) {
    throw new Error(
      `cannot read ${path}: ${err?.message ?? String(err)}; this installation of nightshift is incomplete, reinstall it with \`npm i -g @maykonv/nightshift\``,
    );
  }
  if (typeof name !== "string" || !name.trim()) throw new Error(`${path} declares no name; this installation of nightshift is incomplete, reinstall it`);
  return name.trim();
}

export const PACKAGE_NAME = declaredPackageName();

// Trail from the configuration home down to the installed package, the layout every shim this package writes points into.
export const RUNTIME_PACKAGE_TRAIL = `runtime/current/node_modules/${PACKAGE_NAME}`;

// Trail an installation written before the versioned layout still points into, kept resolvable so an old install never breaks.
export const LEGACY_RUNTIME_PACKAGE_TRAIL = `runtime/node_modules/${PACKAGE_NAME}`;

// Tells whether the runtime of this home is still the one an installation before the versioned layout wrote: no link at all, but a package under the old trail.
function legacyRuntimeOnly(env) {
  if (lstatSync(runtimeCurrentLink(env), { throwIfNoEntry: false })) return false;
  return existsSync(join(homeDir(env), LEGACY_RUNTIME_PACKAGE_TRAIL, "package.json"));
}

// Directory of the package the host is registered against: through the `current` link, and only through the old trail while no link was ever written.
export function runtimePackageDir(env = process.env) {
  const trail = legacyRuntimeOnly(env) ? LEGACY_RUNTIME_PACKAGE_TRAIL : RUNTIME_PACKAGE_TRAIL;
  return join(homeDir(env), trail);
}

// Version directory the `current` link really names, or null when nothing is behind it.
export function resolvedRuntimeDir(env = process.env) {
  try {
    return realpathSync(runtimeCurrentLink(env));
  } catch {
    return null;
  }
}

// Directory of the isolated npm prefix that holds the embedding library, installed on demand.
export function embeddingDir(env = process.env) {
  return join(homeDir(env), "embedding");
}

// Directory the user is invited to put on the PATH.
export function binDir(env = process.env) {
  return join(homeDir(env), "bin");
}

export const SHIM_NAME = "nightshift";
export const SHORTCUT_SHIM_NAMES = ["nshift", "nsft"];
export const LEGACY_SHIM_NAME = "shift";

// Path of one shim that starts the CLI from the runtime, the canonical name unless another is asked for.
export function shimPath(env = process.env, name = SHIM_NAME) {
  return join(binDir(env), name);
}

// Names of the shims one installation writes: the canonical one always, the shortcuts unless they were turned off.
export function shimNames({ shortcuts } = {}) {
  return shortcuts === false ? [SHIM_NAME] : [SHIM_NAME, ...SHORTCUT_SHIM_NAMES];
}

// Path of the shim an older installation wrote under the previous command name.
export function legacyShimPath(env = process.env) {
  return shimPath(env, LEGACY_SHIM_NAME);
}

// Directory of the per-session state written by the hooks.
export function stateDir(env = process.env) {
  return join(homeDir(env), "state");
}

// Directory where the pipeline writes the artifacts and the state.json of one run.
export function runDir(project, slug, env = process.env) {
  return join(homeDir(env), "runs", project, slug);
}

// Directory of the queue logs: one file per job plus one per detached runner.
export function logsDir(env = process.env) {
  return join(homeDir(env), "logs");
}

// Path of the accumulated log of one queue job, appended once per attempt.
export function jobLogPath(id, env = process.env) {
  return join(logsDir(env), `job-${id}.log`);
}

// Path of the sentinel file that keeps the queue paused.
export function queuePausedPath(env = process.env) {
  return join(homeDir(env), "queue.paused");
}

// Path of the intent record of an org rename in flight: written before the first store changes, removed after the last one did.
export function orgRenamePendingPath(env = process.env) {
  return join(homeDir(env), "org-rename.pending.json");
}

// Directory of the runner registry: one file per live runner, the way any number of them coexist.
export function runnersDir(env = process.env) {
  return join(homeDir(env), "runners");
}

// Path of the registration of one runner, named after the pid it belongs to.
export function runnerRegistryPath(pid, env = process.env) {
  return join(runnersDir(env), `${pid}.json`);
}

// Path of the single pidfile an installation before the registry wrote; it is read until it is stopped or pruned, and never written again.
export function legacyRunnerPidPath(env = process.env) {
  return join(homeDir(env), "runner.pid");
}
