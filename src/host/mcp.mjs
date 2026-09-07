import { isDeepStrictEqual } from "node:util";
import { readJsonOrNull } from "./json.mjs";
import { claudeUserConfigPath, shiftEntryPath } from "./paths.mjs";

export const MCP_SERVER_NAME = "nightshift";

// Server entry this package wants registered at user scope, always starting the CLI from the runtime.
export function desiredServer(env = process.env) {
  return { command: "node", args: [shiftEntryPath(env), "mcp"] };
}

// Reads the entry registered for this package, or null when the host does not know it.
export function readRegisteredServer(env = process.env) {
  const data = readJsonOrNull(claudeUserConfigPath(env));
  const servers = data?.mcpServers;
  if (!servers || typeof servers !== "object" || !Object.hasOwn(servers, MCP_SERVER_NAME)) return null;
  const entry = servers[MCP_SERVER_NAME];
  return entry && typeof entry === "object" ? entry : null;
}

// Tells whether a registered entry already starts this package from this very path.
export function serverIsCurrent(entry, env = process.env) {
  if (!entry || typeof entry !== "object") return false;
  const wanted = desiredServer(env);
  const args = Array.isArray(entry.args) ? entry.args : [];
  if (entry.command === wanted.command && isDeepStrictEqual(args, wanted.args)) return true;
  const line = [entry.command, ...args].filter((part) => typeof part === "string").join(" ");
  return line.endsWith(`${shiftEntryPath(env)} mcp`);
}

// Arguments of the call that registers the server at user scope.
export function mcpAddArgs(env = process.env) {
  const { command, args } = desiredServer(env);
  return ["mcp", "add", "--scope", "user", MCP_SERVER_NAME, "--", command, ...args];
}

// Arguments of the call that unregisters the server.
export function mcpRemoveArgs() {
  return ["mcp", "remove", "--scope", "user", MCP_SERVER_NAME];
}
