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
