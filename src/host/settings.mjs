import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { modeOf, writeFileAtomic } from "../config/store.mjs";
import { readJsonStrict } from "./json.mjs";
import { claudeConfigDir, claudeSettingsPath, shiftEntryPath } from "./paths.mjs";

const OWN_COMMAND_MARK = "bin/shift.mjs hook";

const HOOK_EVENTS = [
  { event: "SessionStart", hook: "session-start", timeout: 10 },
  { event: "UserPromptSubmit", hook: "prompt-context", timeout: 10 },
  { event: "SessionEnd", hook: "reflect", timeout: 15 },
];

// Command line registered in the host for one hook of this package.
export function hookCommand(hook, env = process.env) {
  return `node ${shiftEntryPath(env)} hook ${hook}`;
}

// Warning for a package path that carries a space, the only case where the unquoted hook command breaks; null when it is safe.
export function spacedRootWarning(root) {
  if (typeof root !== "string" || !root.includes(" ")) return null;
  return `shift: warning: the package path contains a space (${root}); the host may fail to run the hook command`;
}

// The three hook entries this package wants in the host settings, each with the timeout its work needs.
export function desiredHooks(env = process.env) {
  return HOOK_EVENTS.map(({ event, hook, timeout }) => ({ event, command: hookCommand(hook, env), timeout }));
}

// Reads the host settings file, treating absence as an empty object and broken content as a user error.
export function readHostSettings(env = process.env) {
  const path = claudeSettingsPath(env);
  const existed = existsSync(path);
  return { path, existed, data: readJsonStrict(path, {}) };
}

// Groups registered for one event, or an empty list when the event is absent or malformed.
function eventGroups(data, event) {
  const hooks = data.hooks;
  if (!hooks || typeof hooks !== "object") return [];
  return Array.isArray(hooks[event]) ? hooks[event] : [];
}

// Groups of one event, creating the containers when the merge needs them.
function ensureEventGroups(data, event) {
  if (!data.hooks || typeof data.hooks !== "object" || Array.isArray(data.hooks)) data.hooks = {};
  if (!Array.isArray(data.hooks[event])) data.hooks[event] = [];
  return data.hooks[event];
}

// Entries of one event that belong to this package, each with the group holding it.
function ownEntries(groups) {
  const found = [];
  for (const group of groups) {
    const entries = Array.isArray(group?.hooks) ? group.hooks : [];
    for (const entry of entries) {
      if (typeof entry?.command === "string" && entry.command.includes(OWN_COMMAND_MARK)) found.push({ group, entry });
    }
  }
  return found;
}

// Drops one entry, removing the group and the event key once they become empty.
function dropEntry(data, event, groups, { group, entry }) {
  group.hooks.splice(group.hooks.indexOf(entry), 1);
  if (!group.hooks.length) groups.splice(groups.indexOf(group), 1);
  if (!groups.length && data.hooks) delete data.hooks[event];
}

// Adds or repairs the entry of one event, leaving every third-party entry exactly as it was.
function mergeEvent(data, { event, command, timeout }) {
  const groups = ensureEventGroups(data, event);
  const own = ownEntries(groups);
  if (!own.length) {
    groups.push({ hooks: [{ type: "command", command, timeout }] });
    return "created";
  }
  const [first, ...extra] = own;
  const wasCurrent = first.entry.type === "command" && first.entry.command === command && first.entry.timeout === timeout;
  first.entry.type = "command";
  first.entry.command = command;
  first.entry.timeout = timeout;
  for (const duplicate of extra) dropEntry(data, event, groups, duplicate);
  return wasCurrent && !extra.length ? "already present" : "updated";
}

// Removes every entry of one event that belongs to this package.
function removeEvent(data, event) {
  const groups = eventGroups(data, event);
  const own = ownEntries(groups);
  if (!own.length) return "not present";
  for (const entry of own) dropEntry(data, event, groups, entry);
  return "removed";
}

// Brings the three hook entries of this package into the settings object, in place.
export function mergeHooks(data, env = process.env) {
  return desiredHooks(env).map((hook) => ({ event: hook.event, status: mergeEvent(data, hook) }));
}

// Takes the three hook entries of this package out of the settings object, in place.
export function removeHooks(data, env = process.env) {
  return desiredHooks(env).map((hook) => ({ event: hook.event, status: removeEvent(data, hook.event) }));
}

// State of each hook of this package in the settings object, for a diagnosis that writes nothing.
export function hookStatus(data, env = process.env) {
  return desiredHooks(env).map((hook) => {
    const [own] = ownEntries(eventGroups(data, hook.event));
    return { event: hook.event, expected: hook.command, current: own ? own.entry.command : null };
  });
}

// Timestamped name of the backup taken before the first write of a run.
function backupPath(path) {
  return `${path}.bak-${new Date().toISOString().replace(/[-:.]/g, "")}`;
}

// Writes the settings back, keeping a backup and the permission bits the user had set on the file.
export function writeHostSettings(env, { path, existed, data }) {
  mkdirSync(claudeConfigDir(env), { recursive: true });
  const backup = existed ? backupPath(path) : null;
  if (backup) copyFileSync(path, backup);
  const mode = modeOf(path) ?? undefined;
  writeFileAtomic(path, `${JSON.stringify(data, null, 2)}\n`, { mode });
  return backup;
}
