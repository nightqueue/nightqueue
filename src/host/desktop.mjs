import { copyFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { backupPath, modeOf, writeFileAtomic } from "../config/store.mjs";
import { readJsonOrNull, readJsonStrict } from "./json.mjs";
import { MCP_SERVER_NAME, desiredServer, serverIsCurrent } from "./mcp.mjs";
import { userHome } from "./paths.mjs";

export const DESKTOP_LABEL = "claude desktop mcp";

const CONFIG_FILE = "claude_desktop_config.json";
const UNSAFE_KEYS = ["__proto__", "constructor", "prototype"];
const NEW_FILE_MODE = 0o600;

// Roaming application data directory of Windows, the one the app hangs its configuration from.
function appDataDir(env) {
  const raw = typeof env?.APPDATA === "string" ? env.APPDATA.trim() : "";
  return raw ? resolve(raw) : join(userHome(env), "AppData", "Roaming");
}

// Directory where the Claude Desktop app keeps its configuration, one location per operating system.
export function claudeDesktopDir(env = process.env, platform = process.platform) {
  if (platform === "darwin") return join(userHome(env), "Library", "Application Support", "Claude");
  if (platform === "win32") return join(appDataDir(env), "Claude");
  return join(userHome(env), ".config", "Claude");
}

// Path of the configuration file of the Claude Desktop app.
export function claudeDesktopConfigPath(env = process.env, platform = process.platform) {
  return join(claudeDesktopDir(env, platform), CONFIG_FILE);
}

// Tells whether the app is installed, which is the only thing that makes its configuration directory exist.
export function desktopInstalled(env = process.env, platform = process.platform) {
  return existsSync(claudeDesktopDir(env, platform));
}

// Reads the configuration this CLI is going to rewrite, treating absence as an empty object and broken content as a user error.
export function readDesktopConfig(env = process.env, platform = process.platform) {
  const path = claudeDesktopConfigPath(env, platform);
  return { path, existed: existsSync(path), data: readJsonStrict(path, {}) };
}

// Name of the first prototype-poisoning key the object carries, or null when there is none to refuse.
export function unsafeKeyOf(data) {
  for (const holder of [data, data?.mcpServers]) {
    if (!holder || typeof holder !== "object") continue;
    const found = UNSAFE_KEYS.find((key) => Object.hasOwn(holder, key));
    if (found) return found;
  }
  return null;
}

// Server map of the configuration, created only when the file has none this CLI can write into.
function ensureServers(data) {
  const servers = data.mcpServers;
  if (servers && typeof servers === "object" && !Array.isArray(servers)) return servers;
  data.mcpServers = {};
  return data.mcpServers;
}

// Entry this package registered in the configuration, or null when the app does not know it.
function registeredEntry(data) {
  const servers = data?.mcpServers;
  if (!servers || typeof servers !== "object" || !Object.hasOwn(servers, MCP_SERVER_NAME)) return null;
  const entry = servers[MCP_SERVER_NAME];
  return entry && typeof entry === "object" ? entry : null;
}

// Brings the entry of this package into the configuration object, in place, leaving every other server as it was.
export function mergeDesktopServer(data, env = process.env) {
  const servers = ensureServers(data);
  const entry = registeredEntry(data);
  if (serverIsCurrent(entry, env)) return "already present";
  servers[MCP_SERVER_NAME] = desiredServer(env);
  return entry ? "updated" : "created";
}

// Takes exactly the entry of this package out of the configuration object, never a neighbour whose name only looks like ours.
export function removeDesktopServer(data) {
  const servers = data?.mcpServers;
  if (!servers || typeof servers !== "object" || !Object.hasOwn(servers, MCP_SERVER_NAME)) return "not present";
  delete servers[MCP_SERVER_NAME];
  return "removed";
}

// Reason the configuration cannot be trusted for a diagnosis, or null when it is usable.
function configFault(path, data) {
  if (existsSync(path) && !data) return `${CONFIG_FILE} does not hold a JSON object`;
  const unsafe = data ? unsafeKeyOf(data) : null;
  return unsafe ? `${CONFIG_FILE} carries an unsafe \`${unsafe}\` key` : null;
}

// State of the registration in the Claude Desktop app, for a diagnosis that writes nothing and never throws.
export function desktopState(env = process.env, platform = process.platform) {
  const path = claudeDesktopConfigPath(env, platform);
  if (!desktopInstalled(env, platform)) return { installed: false, path, error: null, entry: null };
  const data = readJsonOrNull(path);
  const error = configFault(path, data);
  return { installed: true, path, error, entry: error ? null : registeredEntry(data) };
}

// Writes the configuration back, keeping a backup and the permission bits of the file, and never creating the directory of an app that is not installed.
export function writeDesktopConfig({ path, existed, data }) {
  const backup = existed ? backupPath(path) : null;
  if (backup) copyFileSync(path, backup);
  const mode = modeOf(path) ?? NEW_FILE_MODE;
  writeFileAtomic(path, `${JSON.stringify(data, null, 2)}\n`, { mode });
  return backup;
}
