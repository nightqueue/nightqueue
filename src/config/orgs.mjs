import { UserError } from "./errors.mjs";
import { assertName, emptyMap, emptySlots } from "./schema.mjs";

// This module is pure over the config object: it mutates and returns the same object, without I/O.

// Returns an org entry, or null when it does not exist.
export function getOrg(config, name) {
  return config?.orgs?.[name] ?? null;
}

// Returns the required org, listing the existing ones when it is missing.
export function requireOrg(config, name) {
  const org = getOrg(config, name);
  if (org) return org;
  const existing = Object.keys(config?.orgs ?? {});
  throw new UserError(`unknown org \`${name}\`; existing orgs: ${existing.length ? existing.join(", ") : "(none)"}`);
}

// Counts the projects bound to an org.
function countProjects(config, name) {
  return Object.values(config.projects).filter((project) => project.org === name).length;
}

// Lists the orgs with display name, connection slots and project count.
export function listOrgs(config) {
  return Object.entries(config.orgs).map(([name, org]) => ({
    name,
    displayName: org.displayName,
    isDefault: name === config.defaultOrg,
    connections: { ...org.connections },
    projects: countProjects(config, name),
  }));
}

// Creates a new org.
export function addOrg(config, name, { displayName } = {}) {
  assertName("org", name);
  if (config.orgs[name]) throw new UserError(`org \`${name}\` already exists`);
  config.orgs[name] = { displayName: displayName || name, connections: emptySlots() };
  return config;
}

// Rewrites a map replacing one key, keeping the original key order.
function renameKey(map, oldKey, newKey) {
  const next = emptyMap();
  for (const [key, value] of Object.entries(map)) next[key === oldKey ? newKey : key] = value;
  return next;
}

// Renames an org preserving position, display name, slots, projects and the default org.
export function renameOrg(config, oldName, newName) {
  requireOrg(config, oldName);
  assertName("org", newName);
  if (oldName === newName) throw new UserError(`org \`${oldName}\` already has that name`);
  if (config.orgs[newName]) throw new UserError(`org \`${newName}\` already exists`);
  config.orgs = renameKey(config.orgs, oldName, newName);
  for (const project of Object.values(config.projects)) {
    if (project.org === oldName) project.org = newName;
  }
  if (config.defaultOrg === oldName) config.defaultOrg = newName;
  return config;
}

// Removes an org that is neither the default one nor pointed at by any project.
export function removeOrg(config, name) {
  requireOrg(config, name);
  if (name === config.defaultOrg) throw new UserError(`cannot remove org \`${name}\`: it is the default org`);
  const used = Object.keys(config.projects).filter((project) => config.projects[project].org === name);
  if (used.length) {
    throw new UserError(`cannot remove org \`${name}\`: ${used.length} project(s) still point to it: ${used.join(", ")}`);
  }
  delete config.orgs[name];
  return config;
}
