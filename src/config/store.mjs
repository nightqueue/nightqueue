import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { UserError } from "./errors.mjs";
import { configPath, homeDir, secretsPath } from "./paths.mjs";
import { emptyConfig, emptySecrets, normalizeConfig, normalizeSecrets } from "./schema.mjs";

const SECRETS_MODE = 0o600;
const HOME_MODE = 0o700;

// Writes a file atomically, through a sibling temporary file plus rename.
export function writeFileAtomic(filePath, content, { mode } = {}) {
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tmp, content, mode === undefined ? "utf8" : { encoding: "utf8", mode });
    if (mode !== undefined) chmodSync(tmp, mode);
    renameSync(tmp, filePath);
  } finally {
    rmSync(tmp, { force: true });
  }
}

// Timestamped name of the backup taken before the first write of a run.
export function backupPath(path) {
  return `${path}.bak-${new Date().toISOString().replace(/[-:.]/g, "")}`;
}

// Returns the permission bits of the path, or null when it is missing.
export function modeOf(path) {
  const stats = statSync(path, { throwIfNoEntry: false });
  return stats ? stats.mode & 0o777 : null;
}

// Tells whether the mode grants any access to group or others.
function isOpenToOthers(mode) {
  return mode !== null && (mode & 0o077) !== 0;
}

// Makes sure the configuration home exists at 0700, tightening it also when it already existed.
export function ensureHome(env = process.env) {
  const path = homeDir(env);
  const created = mkdirSync(path, { recursive: true, mode: HOME_MODE }) !== undefined;
  if (created || isOpenToOthers(modeOf(path))) chmodSync(path, HOME_MODE);
  return { path, created };
}

// Reads a JSON file, treating absence as an empty structure and broken content as a usage error.
function readJsonFile(filePath, missing) {
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch (err) {
    if (err?.code === "ENOENT") return missing;
    if (err instanceof SyntaxError) {
      throw new UserError(`\`${filePath}\` is not valid JSON: ${err.message} — fix or remove the file`);
    }
    throw new UserError(`cannot read \`${filePath}\`: ${err?.message ?? String(err)}`);
  }
}

// Serializes a configuration structure for disk.
function serialize(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

// Writes a warning line to stderr.
function warnToStderr(line) {
  process.stderr.write(`${line}\n`);
}

// Warns when the secrets file is more open than 0600.
function warnOnOpenMode(filePath, warn) {
  const mode = modeOf(filePath);
  if (!isOpenToOthers(mode)) return;
  warn(`nightshift: warning: ${filePath} is mode 0${mode.toString(8).padStart(3, "0")}, expected 0600`);
}

// Loads config.json, warning about inconsistency in the file without rewriting it.
export function loadConfig(env = process.env, { warn = warnToStderr } = {}) {
  const raw = readJsonFile(configPath(env), null);
  return raw === null ? emptyConfig() : normalizeConfig(raw, { warn });
}

// Writes config.json atomically, creating the home directory when it is missing.
export function saveConfig(config, env = process.env) {
  ensureHome(env);
  writeFileAtomic(configPath(env), serialize(config));
}

// Loads secrets.json, warning when the file mode is too open.
export function loadSecrets(env = process.env, { warn = warnToStderr } = {}) {
  const filePath = secretsPath(env);
  warnOnOpenMode(filePath, warn);
  const raw = readJsonFile(filePath, null);
  return raw === null ? emptySecrets() : normalizeSecrets(raw);
}

// Writes secrets.json atomically and with mode 0600.
export function saveSecrets(secrets, env = process.env) {
  ensureHome(env);
  writeFileAtomic(secretsPath(env), serialize(secrets), { mode: SECRETS_MODE });
}
