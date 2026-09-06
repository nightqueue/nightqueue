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

// Directory of the per-session state written by the hooks.
export function stateDir(env = process.env) {
  return join(homeDir(env), "state");
}
