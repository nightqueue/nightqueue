import { UserError } from "./errors.mjs";
import { assertName, emptySlots } from "./schema.mjs";
import { connectionTypes } from "../integrations/registry.mjs";

export const CONNECTION_TYPES = connectionTypes();

// Returns the descriptor of a supported connection type.
export function requireType(type) {
  const descriptor = CONNECTION_TYPES.get(type);
  if (!descriptor) {
    throw new UserError(`unknown connection type \`${type}\`; supported: ${[...CONNECTION_TYPES.keys()].join(", ")}`);
  }
  return descriptor;
}

// Returns the NAME of the connection bound to a type in an org (by org id), never the secret.
export function connectionFor(config, orgId, type) {
  const name = config?.orgConnections?.[orgId]?.[type];
  return typeof name === "string" && name ? name : null;
}

// Lists the ids of the orgs pointing at a connection.
export function orgsUsingConnection(config, name) {
  return Object.entries(config?.orgConnections ?? {})
    .filter(([, slots]) => Object.values(slots ?? {}).includes(name))
    .map(([orgId]) => orgId);
}

// The slot map of an org id, created empty the first time a binding lands on it.
function slotsFor(config, orgId) {
  config.orgConnections ??= {};
  config.orgConnections[orgId] ??= emptySlots();
  return config.orgConnections[orgId];
}

// Tells whether a stored secret exists for the connection, without reading its value.
export function hasConnection(secrets, name) {
  return Boolean(secrets?.connections?.[name]);
}

// Returns the declared type of a connection, without reading the secret value.
export function typeOf(secrets, name) {
  const type = secrets?.connections?.[name]?.type;
  return typeof type === "string" ? type : null;
}

// The only place in the project that returns the record holding the secret value.
export function secretOf(secrets, name) {
  return secrets?.connections?.[name] ?? null;
}

// Lists the connections with type, secret presence and the ids of the orgs bound to them, never a secret value.
export function listConnections(config, secrets) {
  const rows = new Map();
  for (const [name, entry] of Object.entries(secrets.connections)) {
    rows.set(name, { name, type: entry.type, present: true, orgs: orgsUsingConnection(config, name) });
  }
  for (const slots of Object.values(config?.orgConnections ?? {})) {
    for (const [type, name] of Object.entries(slots ?? {})) {
      if (!name || rows.has(name)) continue;
      rows.set(name, { name, type, present: false, orgs: orgsUsingConnection(config, name) });
    }
  }
  return [...rows.values()];
}

// Builds config and secrets with the new connection, binding it to the org's slot only when that slot is empty.
export function addConnection({ config, secrets, name, type, orgId, secret }) {
  assertName("connection", name);
  const descriptor = requireType(type);
  if (typeof secret !== "string" || !secret) throw new UserError("empty secret; nothing was stored");
  if (hasConnection(secrets, name)) throw new UserError(`connection \`${name}\` already exists; remove it first`);
  secrets.connections[name] = { type, [descriptor.secretFields[0]]: secret };
  const occupiedBy = connectionFor(config, orgId, type);
  if (!occupiedBy) slotsFor(config, orgId)[type] = name;
  return { config, secrets, orgId, bound: !occupiedBy, occupiedBy };
}

// Binds (or rebinds) an existing connection to the slot of its type in an org.
export function bindConnection({ config, secrets, name, orgId }) {
  const type = typeOf(secrets, name);
  if (!type) throw new UserError(`unknown connection \`${name}\``);
  requireType(type);
  const previous = connectionFor(config, orgId, type);
  slotsFor(config, orgId)[type] = name;
  return { config, type, previous };
}

// Unbinds the connection from every org and deletes it from secrets.
export function removeConnection({ config, secrets, name }) {
  if (!hasConnection(secrets, name)) throw new UserError(`unknown connection \`${name}\``);
  const unboundFrom = orgsUsingConnection(config, name);
  for (const slots of Object.values(config?.orgConnections ?? {})) {
    for (const [type, bound] of Object.entries(slots ?? {})) {
      if (bound === name) slots[type] = null;
    }
  }
  delete secrets.connections[name];
  return { config, secrets, unboundFrom };
}

// Tests the connection against the service of its type, without exposing the secret in the return.
export async function testConnection({ name, secrets, fetchImpl = fetch, timeoutMs = 5000 }) {
  const secret = secretOf(secrets, name);
  if (!secret) throw new UserError(`unknown connection \`${name}\``);
  const descriptor = requireType(secret.type);
  const result = await descriptor.test(secret, { fetchImpl, timeoutMs });
  return { type: secret.type, ...result };
}
