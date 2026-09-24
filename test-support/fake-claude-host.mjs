#!/usr/bin/env node
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const VERSION = "2.1.261 (Claude Code)";
const args = process.argv.slice(2);

// Records the call in the argv log the test reads back.
function logCall() {
  const path = process.env.NIGHTQUEUE_FAKE_CLAUDE_LOG;
  if (!path) return;
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(args)}\n`);
}

// Isolated configuration directory this fake is allowed to write into.
function configDir() {
  const dir = process.env.CLAUDE_CONFIG_DIR;
  if (!dir) {
    process.stderr.write("fake claude: CLAUDE_CONFIG_DIR is not set; refusing to touch the real host\n");
    process.exit(2);
  }
  return dir;
}

// Reads one JSON file of the host state, treating anything unreadable as empty.
function readState(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}

// Writes one JSON file of the host state.
function writeState(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
}

// Drops the scope flag with its value and the non-interactive flag, leaving only the meaningful arguments.
function withoutFlags(list) {
  const kept = [];
  for (let index = 0; index < list.length; index += 1) {
    if (list[index] === "--scope" || list[index] === "-s") {
      index += 1;
      continue;
    }
    if (list[index] === "-y" || list[index] === "--yes") continue;
    kept.push(list[index]);
  }
  return kept;
}

// Registers a server in the user level JSON, the file the real CLI writes at user scope.
function mcpAdd(rest) {
  const separator = rest.indexOf("--");
  const name = withoutFlags(rest.slice(0, separator === -1 ? rest.length : separator)).pop();
  const [command, ...serverArgs] = separator === -1 ? [] : rest.slice(separator + 1);
  const path = join(configDir(), ".claude.json");
  const data = readState(path);
  data.mcpServers = { ...data.mcpServers, [name]: { type: "stdio", command, args: serverArgs, env: {} } };
  writeState(path, data);
}

// Unregisters a server from the user level JSON.
function mcpRemove(rest) {
  const name = withoutFlags(rest).pop();
  const path = join(configDir(), ".claude.json");
  const data = readState(path);
  if (data.mcpServers) delete data.mcpServers[name];
  writeState(path, data);
}

// Name declared by the marketplace manifest of a local source.
function manifestName(source) {
  const manifest = readState(join(source, ".claude-plugin", "marketplace.json"));
  return typeof manifest.name === "string" ? manifest.name : "unknown";
}

// Registers a local marketplace in the host state.
function marketplaceAdd(source) {
  const path = join(configDir(), "plugins", "known_marketplaces.json");
  const data = readState(path);
  data[manifestName(source)] = { source, installLocation: source, lastUpdated: Date.now() };
  writeState(path, data);
}

// Forgets a marketplace of the host state.
function marketplaceRemove(name) {
  const path = join(configDir(), "plugins", "known_marketplaces.json");
  const data = readState(path);
  delete data[name];
  writeState(path, data);
}

// Installs a plugin in the host state, with the shape the real CLI writes.
function pluginInstall(ref) {
  const path = join(configDir(), "plugins", "installed_plugins.json");
  const data = readState(path);
  const plugins = data.plugins && typeof data.plugins === "object" ? data.plugins : {};
  plugins[ref] = [{ scope: "user", installPath: join(configDir(), "plugins", ref), version: "0.1.0" }];
  writeState(path, { version: 2, plugins });
}

// Uninstalls a plugin from the host state.
function pluginUninstall(ref) {
  const path = join(configDir(), "plugins", "installed_plugins.json");
  const data = readState(path);
  const plugins = data.plugins && typeof data.plugins === "object" ? data.plugins : {};
  delete plugins[ref];
  writeState(path, { version: 2, plugins });
}

// Applies the plugin subcommands of the fake.
function runPlugin(rest) {
  const [sub, ...tail] = rest;
  if (sub === "marketplace" && tail[0] === "add") return marketplaceAdd(tail[1]);
  if (sub === "marketplace" && tail[0] === "remove") return marketplaceRemove(tail[1]);
  if (sub === "install") return pluginInstall(withoutFlags(tail)[0]);
  if (sub === "uninstall") return pluginUninstall(withoutFlags(tail)[0]);
  return fail(`unknown plugin subcommand \`${sub}\``);
}

// Ends the process the way the real CLI ends on a bad call.
function fail(message, code = 1) {
  process.stderr.write(`fake claude: ${message}\n`);
  process.exit(code);
}

// Applies the call, emulating only the subcommands the setup uses.
function main() {
  logCall();
  const exitCode = Number.parseInt(process.env.NIGHTQUEUE_FAKE_CLAUDE_EXIT ?? "0", 10) || 0;
  if (exitCode) fail(`refusing to run (NIGHTQUEUE_FAKE_CLAUDE_EXIT=${exitCode})`, exitCode);
  const [command, ...rest] = args;
  if (command === "--version" || command === "-v") return process.stdout.write(`${VERSION}\n`);
  if (command === "--help") return process.stdout.write("Options:\n  --agent <agent>  Agent for the current session\n");
  if (command === "mcp" && rest[0] === "add") return mcpAdd(rest.slice(1));
  if (command === "mcp" && rest[0] === "remove") return mcpRemove(rest.slice(1));
  if (command === "plugin") return runPlugin(rest);
  return fail(`unknown command \`${args.join(" ")}\``);
}

main();
