// The integrations' view of config.json and secrets.json: a record holding a secret never leaves src/integrations.
import { isHomeScoped } from "./registry.mjs";

// The name of the connection an org's single slot of a kind holds, or null.
export function orgSlot(config, orgId, kind) {
  const name = config?.orgConnections?.[orgId]?.[kind];
  return typeof name === "string" && name ? name : null;
}

// The names of the connections an org lists for a kind bound to many connections.
export function orgConnectionsOf(config, orgId, kind) {
  const list = config?.orgConnections?.[orgId]?.[kind];
  return Array.isArray(list) ? list.filter((name) => typeof name === "string" && name) : [];
}

// Tells whether the org uses the named connection of a kind, through its slot or its list.
export function orgUsesConnection({ config, orgId, kind, name }) {
  if (!name || !orgId) return false;
  return orgSlot(config, orgId, kind) === name || orgConnectionsOf(config, orgId, kind).includes(name);
}

// A connection record without its secret fields.
export function publicFields(record, descriptor) {
  const secretFields = new Set(descriptor?.secretFields ?? []);
  return Object.fromEntries(Object.entries(record ?? {}).filter(([field]) => !secretFields.has(field)));
}

// The stored record of a connection with its name, or null when it is missing or of another kind.
function namedRecord(secrets, name, kind) {
  const record = name ? secrets?.connections?.[name] : null;
  return record && record.type === kind ? { ...record, name } : null;
}

// The record of the home's one connection of a kind, secrets included; with several stored, the first by name.
export function homeConnection(secrets, kind) {
  const names = Object.keys(secrets?.connections ?? {}).sort();
  const name = names.find((candidate) => secrets.connections[candidate]?.type === kind);
  return namedRecord(secrets, name, kind);
}

// The connections of a kind that act for an org, secrets included: the home's one for a home-scoped kind, else the org's slot and list.
export function resolveForClose({ kind, orgId, config, secrets }) {
  if (isHomeScoped(kind)) return { slot: homeConnection(secrets, kind), connections: [] };
  const slot = namedRecord(secrets, orgSlot(config, orgId, kind), kind);
  const connections = orgConnectionsOf(config, orgId, kind)
    .map((name) => namedRecord(secrets, name, kind))
    .filter(Boolean);
  return { slot, connections };
}

// The record of one connection of a kind by name, secrets included, or null.
export function connectionRecord({ secrets, name, kind }) {
  return namedRecord(secrets, name, kind);
}
