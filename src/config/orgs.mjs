import { UserError } from "./errors.mjs";
import { isId } from "./ids.mjs";
import { assertName, emptySlots } from "./schema.mjs";

// The org edge: names resolved to registry rows through a store, and the config's bindings keyed by org id.

// The registered org with that name; an unknown one is refused, listing the existing orgs (a null store is an empty registry).
export async function requireOrg(store, name) {
  const org = store && typeof name === "string" && name ? await store.orgs.byName(name) : null;
  if (org) return org;
  const existing = store ? (await store.orgs.list()).map((entry) => entry.name) : [];
  throw new UserError(`unknown org \`${name ?? ""}\`; existing orgs: ${existing.length ? existing.join(", ") : "(none)"}`);
}

// The default org of the home: the one config.json names (by id, or by name before the v18 strip), else the earliest org.
export async function defaultOrg(store, config) {
  const named = config?.defaultOrg;
  const found = typeof named === "string" && named ? await (isId(named) ? store.orgs.byId(named) : store.orgs.byName(named)) : null;
  if (found) return found;
  const [earliest] = await store.orgs.list();
  if (!earliest) throw new UserError("the registry has no org; run `nightqueue setup` to create the default one");
  return earliest;
}

// The connection slots config.json binds to an org id, one per supported type.
export function slotsOf(config, orgId) {
  return { ...emptySlots(), ...(config?.orgConnections?.[orgId] ?? {}) };
}

// Lists the orgs with their key and old keys, the default marker, the connection slots and the project count.
export async function listOrgs(store, config) {
  const fallback = await defaultOrg(store, config);
  const projects = await store.projects.list();
  const aliases = await store.orgs.keyAliases();
  return (await store.orgs.list()).map((org) => ({
    id: org.id,
    name: org.name,
    key: org.key,
    aliases: aliases[org.id] ?? [],
    isDefault: org.id === fallback.id,
    connections: slotsOf(config, org.id),
    projects: projects.filter((project) => project.org_id === org.id).length,
  }));
}

// Creates a new org under the key asked for, or a free one derived from its name.
export async function addOrg(store, name, key = null) {
  assertName("org", name);
  if (await store.orgs.byName(name)) throw new UserError(`org \`${name}\` already exists`);
  return await store.orgs.add(name, key);
}

// Gives an org a new key; its old key keeps resolving to it.
export async function setOrgKey(store, name, key) {
  const org = await requireOrg(store, name);
  return await store.orgs.setKey(org.id, key);
}

// Renames an org: one registry row, so every binding, project and default keyed by its id follows.
export async function renameOrg(store, oldName, newName) {
  const org = await requireOrg(store, oldName);
  assertName("org", newName);
  if (oldName === newName) throw new UserError(`org \`${oldName}\` already has that name`);
  if (await store.orgs.byName(newName)) throw new UserError(`org \`${newName}\` already exists`);
  return await store.orgs.rename(org.id, newName);
}

// Removes an org that is not the default one; the registry refuses one still owning projects or rows, and the config drops its bindings.
export async function removeOrg(store, config, name) {
  const org = await requireOrg(store, name);
  if (org.id === (await defaultOrg(store, config)).id) throw new UserError(`cannot remove org \`${name}\`: it is the default org`);
  await store.orgs.remove(org.id);
  if (config.orgConnections) delete config.orgConnections[org.id];
  return config;
}
