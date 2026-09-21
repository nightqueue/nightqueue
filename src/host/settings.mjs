import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { backupPath, modeOf, writeFileAtomic } from "../config/store.mjs";
import { readJsonStrict } from "./json.mjs";
import { claudeConfigDir, claudeSettingsPath, cliEntryPath } from "./paths.mjs";

const OWN_COMMAND_MARKS = ["bin/nightshift.mjs hook", "bin/shift.mjs hook"];

const HOOK_EVENTS = [
  { event: "SessionStart", hook: "session-start", timeout: 10 },
  { event: "UserPromptSubmit", hook: "prompt-context", timeout: 10 },
  { event: "SessionEnd", hook: "reflect", timeout: 15 },
  { event: "PreToolUse", hook: "agent-foreground", timeout: 5, matcher: "Agent|Task|Bash|Read|Grep|Glob" },
];

// Command line registered in the host for one hook of this package.
export function hookCommand(hook, env = process.env) {
  return `node ${cliEntryPath(env)} hook ${hook}`;
}

// Warning for a package path that carries a space, the only case where the unquoted hook command breaks; null when it is safe.
export function spacedRootWarning(root) {
  if (typeof root !== "string" || !root.includes(" ")) return null;
  return `nightshift: warning: the package path contains a space (${root}); the host may fail to run the hook command`;
}

// The four hook entries this package wants in the host settings, each with the timeout its work needs and, when it applies, the matcher restricting it.
export function desiredHooks(env = process.env) {
  return HOOK_EVENTS.map(({ event, hook, timeout, matcher }) => ({
    event,
    command: hookCommand(hook, env),
    timeout,
    ...(matcher ? { matcher } : {}),
  }));
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

// Tells whether one registered command is ours, under the current entry name or the one an older install wrote.
function isOwnCommand(command) {
  return typeof command === "string" && OWN_COMMAND_MARKS.some((mark) => command.includes(mark));
}

// Tells whether every entry of a group belongs to this package, which is the only case its matcher can be touched.
function groupIsExclusive(group) {
  const entries = Array.isArray(group?.hooks) ? group.hooks : [];
  return entries.length > 0 && entries.every((entry) => isOwnCommand(entry?.command));
}

// Tells whether the matcher of the group holding our entry is the wanted one, a group shared with a third party always counting as current.
function matcherIsCurrent(group, matcher) {
  return !groupIsExclusive(group) || group.matcher === matcher;
}

// Entries of one event that belong to this package, each with the group holding it.
function ownEntries(groups) {
  const found = [];
  for (const group of groups) {
    const entries = Array.isArray(group?.hooks) ? group.hooks : [];
    for (const entry of entries) {
      if (isOwnCommand(entry?.command)) found.push({ group, entry });
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

// Adds or repairs the entry of one event, leaving every third-party entry - and the matcher of any group holding one - exactly as it was.
function mergeEvent(data, { event, command, timeout, matcher }) {
  const groups = ensureEventGroups(data, event);
  const own = ownEntries(groups);
  if (!own.length) {
    const group = matcher ? { matcher, hooks: [] } : { hooks: [] };
    group.hooks.push({ type: "command", command, timeout });
    groups.push(group);
    return "created";
  }
  const [first, ...extra] = own;
  const entryCurrent = first.entry.type === "command" && first.entry.command === command && first.entry.timeout === timeout;
  const exclusive = groupIsExclusive(first.group);
  const matcherCurrent = matcherIsCurrent(first.group, matcher);
  first.entry.type = "command";
  first.entry.command = command;
  first.entry.timeout = timeout;
  if (exclusive) {
    if (matcher) first.group.matcher = matcher;
    else delete first.group.matcher;
  }
  for (const duplicate of extra) dropEntry(data, event, groups, duplicate);
  return entryCurrent && matcherCurrent && !extra.length ? "already present" : "updated";
}

// Removes every entry of one event that belongs to this package.
function removeEvent(data, event) {
  const groups = eventGroups(data, event);
  const own = ownEntries(groups);
  if (!own.length) return "not present";
  for (const entry of own) dropEntry(data, event, groups, entry);
  return "removed";
}

// Brings the four hook entries of this package into the settings object, in place.
export function mergeHooks(data, env = process.env) {
  return desiredHooks(env).map((hook) => ({ event: hook.event, status: mergeEvent(data, hook) }));
}

// Takes the four hook entries of this package out of the settings object, in place.
export function removeHooks(data, env = process.env) {
  return desiredHooks(env).map((hook) => ({ event: hook.event, status: removeEvent(data, hook.event) }));
}

// State of each hook of this package in the settings object, for a diagnosis that writes nothing.
export function hookStatus(data, env = process.env) {
  return desiredHooks(env).map((hook) => {
    const [own] = ownEntries(eventGroups(data, hook.event));
    return {
      event: hook.event,
      expected: hook.command,
      current: own ? own.entry.command : null,
      matcherCurrent: own ? matcherIsCurrent(own.group, hook.matcher) : true,
    };
  });
}

// The `--settings` payload of an isolated job: this package's own hooks plus the exclude of the operator's own CLAUDE.md.
export function jobSettings(env = process.env) {
  const data = {};
  mergeHooks(data, env);
  return { hooks: data.hooks, claudeMdExcludes: [join(claudeConfigDir(env), "CLAUDE.md")] };
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
