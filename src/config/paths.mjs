import { readFileSync } from "node:fs";
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

// Directory of the embedding model weights, kept outside node_modules on purpose.
export function modelsDir(env = process.env) {
  return join(homeDir(env), "models");
}

// Directory of the self-contained runtime: the npm prefix this package is installed into.
export function runtimeDir(env = process.env) {
  return join(homeDir(env), "runtime");
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
export const RUNTIME_PACKAGE_TRAIL = `runtime/node_modules/${PACKAGE_NAME}`;

// Directory of the package inside the runtime prefix, the stable root the host is registered against.
export function runtimePackageDir(env = process.env) {
  return join(homeDir(env), RUNTIME_PACKAGE_TRAIL);
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

// Path of the file that registers the watch runner of the queue, the one `queue run --stop` ends.
export function runnerPidPath(env = process.env) {
  return join(homeDir(env), "runner.pid");
}
