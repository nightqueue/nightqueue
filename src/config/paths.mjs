import { homedir } from "node:os";
import { join, resolve } from "node:path";

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

// Directory of the package inside the runtime prefix, the stable root the host is registered against.
export function runtimePackageDir(env = process.env) {
  return join(runtimeDir(env), "node_modules", "nightshift");
}

// Directory of the isolated npm prefix that holds the embedding library, installed on demand.
export function embeddingDir(env = process.env) {
  return join(homeDir(env), "embedding");
}

// Directory the user is invited to put on the PATH.
export function binDir(env = process.env) {
  return join(homeDir(env), "bin");
}

// Path of the shim that starts the CLI from the runtime.
export function shimPath(env = process.env) {
  return join(binDir(env), "shift");
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
