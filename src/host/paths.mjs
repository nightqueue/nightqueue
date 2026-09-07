import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runtimePackageDir } from "../config/paths.mjs";

// Root of the package this process runs from, the identity of the running version.
export function packageRoot() {
  return resolve(fileURLToPath(new URL("../../", import.meta.url)));
}

// Root of the package the host is registered against: always the runtime prefix, never the directory this process runs from.
export function hostPackageRoot(env = process.env) {
  return runtimePackageDir(env);
}

// Absolute path of the CLI entry point, the one registered in the host.
export function shiftEntryPath(env = process.env) {
  return join(hostPackageRoot(env), "bin", "shift.mjs");
}

// Path of the marketplace manifest inside the runtime, the file the host reads.
export function hostManifestPath(env = process.env) {
  return join(hostPackageRoot(env), ".claude-plugin", "marketplace.json");
}

// Home directory of the user the host paths hang from, preferring the environment so a test never touches the real one.
export function userHome(env = process.env) {
  const raw = typeof env?.HOME === "string" ? env.HOME.trim() : "";
  return raw ? resolve(raw) : homedir();
}

// Value of CLAUDE_CONFIG_DIR, or an empty string when the host uses its default location.
function configDirOverride(env) {
  const raw = typeof env?.CLAUDE_CONFIG_DIR === "string" ? env.CLAUDE_CONFIG_DIR.trim() : "";
  return raw ? resolve(raw) : "";
}

// Configuration directory of the Claude Code host.
export function claudeConfigDir(env = process.env) {
  return configDirOverride(env) || join(userHome(env), ".claude");
}

// Path of the host settings file, always inside the configuration directory.
export function claudeSettingsPath(env = process.env) {
  return join(claudeConfigDir(env), "settings.json");
}

// Path of the user level JSON that holds the MCP servers: inside the configuration directory only when CLAUDE_CONFIG_DIR is set, a sibling of it otherwise.
export function claudeUserConfigPath(env = process.env) {
  const override = configDirOverride(env);
  return override ? join(override, ".claude.json") : join(userHome(env), ".claude.json");
}

// Directory where the host keeps the plugin state.
export function claudePluginsDir(env = process.env) {
  return join(claudeConfigDir(env), "plugins");
}

// Path of the file that lists the marketplaces known to the host.
export function knownMarketplacesPath(env = process.env) {
  return join(claudePluginsDir(env), "known_marketplaces.json");
}

// Path of the file that lists the plugins installed in the host.
export function installedPluginsPath(env = process.env) {
  return join(claudePluginsDir(env), "installed_plugins.json");
}

// Path of the marketplace manifest shipped with the package.
export function marketplaceManifestPath() {
  return join(packageRoot(), ".claude-plugin", "marketplace.json");
}
