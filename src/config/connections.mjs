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

// The connection names one binding holds: a slot's name, or the list of a kind bound to many connections.
function boundNames(binding) {
  if (Array.isArray(binding)) return binding.filter((name) => typeof name === "string" && name);
  return typeof binding === "string" && binding ? [binding] : [];
}

// Tells whether a type's connection serves the whole home and binds to no org.
function isHomeType(type) {
  return requireType(type).scope === "home";
}

// Tells whether a type binds an org to many connections instead of a single slot.
function isManyType(type) {
  return requireType(type).cardinality === "many";
}

// Lists the ids of the orgs pointing at a connection.
export function orgsUsingConnection(config, name) {
  return Object.entries(config?.orgConnections ?? {})
    .filter(([, slots]) => Object.values(slots ?? {}).some((binding) => boundNames(binding).includes(name)))
    .map(([orgId]) => orgId);
}

// Adds a connection to the org's list of a many type, once.
function addToOrgList(config, orgId, type, name) {
  const slots = slotsFor(config, orgId);
  const names = boundNames(slots[type]);
  slots[type] = names.includes(name) ? names : [...names, name];
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

// The name of the home's one stored connection of a type, the first by name when several are stored, or null.
export function homeConnectionName(secrets, type) {
  const names = Object.keys(secrets?.connections ?? {}).sort();
  return names.find((name) => secrets.connections[name]?.type === type) ?? null;
}

// Refuses a second connection of a home-wide type, naming the one the home already has.
export function assertHomeFree(secrets, type) {
  const first = homeConnectionName(secrets, type);
  if (first) throw new UserError(`a home has one \`${type}\` connection: \`${first}\`; remove it first`);
}

// One `connection list` row of a stored connection: a home-scoped one serves no org and says so.
function storedRow(config, name, type) {
  if (CONNECTION_TYPES.get(type)?.scope === "home") return { name, type, present: true, orgs: [], scope: "home" };
  return { name, type, present: true, orgs: orgsUsingConnection(config, name) };
}

// Lists the connections with type, secret presence and the ids of the orgs bound to them, never a secret value.
export function listConnections(config, secrets) {
  const rows = new Map();
  for (const [name, entry] of Object.entries(secrets.connections)) {
    rows.set(name, storedRow(config, name, entry.type));
  }
  for (const slots of Object.values(config?.orgConnections ?? {})) {
    for (const [type, binding] of Object.entries(slots ?? {})) {
      for (const name of boundNames(binding)) {
        if (!rows.has(name)) rows.set(name, { name, type, present: false, orgs: orgsUsingConnection(config, name) });
      }
    }
  }
  return [...rows.values()];
}

// Validates one extra field value against its declaration, answering the value or its declared default.
function extraValue(type, field, given) {
  if (given === undefined) {
    if (field.required) throw new UserError(`a ${type} connection needs --set ${field.name}=<value> (${field.format ?? "a value"})`);
    return field.default;
  }
  if (typeof given !== "string" || !given || (typeof field.check === "function" && !field.check(given))) {
    throw new UserError(`\`--set ${field.name}\` of a ${type} connection takes ${field.format ?? "a value"}`);
  }
  return given;
}

// Validates the extra fields given for a connection type, filling the declared defaults; an undeclared field is refused.
export function connectionExtras(type, extra = {}) {
  const fields = requireType(type).extraFields ?? [];
  const declared = fields.map((field) => field.name);
  const unknown = Object.keys(extra ?? {}).find((name) => !declared.includes(name));
  if (unknown !== undefined) {
    throw new UserError(`a ${type} connection has no field \`${unknown}\`; fields: ${declared.length ? declared.join(", ") : "(none)"}`);
  }
  const values = {};
  for (const field of fields) {
    const value = extraValue(type, field, extra?.[field.name]);
    if (value !== undefined) values[field.name] = value;
  }
  return values;
}

// The fields a type derives from its secret at `connection add` (asking its service), secret and type never among them.
export async function completeConnection({ type, secret, extra = {}, fetchImpl = fetch, timeoutMs = 5000 }) {
  const descriptor = requireType(type);
  if (typeof descriptor.complete !== "function") return {};
  if (typeof secret !== "string" || !secret) throw new UserError("empty secret; nothing was stored");
  const secretField = descriptor.secretFields[0];
  const completed = await descriptor.complete({ type, [secretField]: secret, ...extra }, { fetchImpl, timeoutMs });
  const hidden = new Set(["type", ...descriptor.secretFields, ...Object.keys(extra)]);
  return Object.fromEntries(Object.entries(completed ?? {}).filter(([field]) => !hidden.has(field)));
}

// Builds config and secrets with the new connection: bound to the org's slot only when that slot is empty, appended to the org's list for a many type, bound to nothing for a home type.
export function addConnection({ config, secrets, name, type, orgId, secret, extra = {}, derived = {} }) {
  assertName("connection", name);
  const descriptor = requireType(type);
  const fields = connectionExtras(type, extra);
  if (typeof secret !== "string" || !secret) throw new UserError("empty secret; nothing was stored");
  if (hasConnection(secrets, name)) throw new UserError(`connection \`${name}\` already exists; remove it first`);
  const home = descriptor.scope === "home";
  if (home) assertHomeFree(secrets, type);
  secrets.connections[name] = { type, [descriptor.secretFields[0]]: secret, ...fields, ...derived };
  if (home) return { config, secrets, orgId: null, bound: false, home: true, occupiedBy: null };
  if (isManyType(type)) {
    addToOrgList(config, orgId, type, name);
    return { config, secrets, orgId, bound: true, occupiedBy: null };
  }
  const occupiedBy = connectionFor(config, orgId, type);
  if (!occupiedBy) slotsFor(config, orgId)[type] = name;
  return { config, secrets, orgId, bound: !occupiedBy, occupiedBy };
}

// Binds (or rebinds) an existing connection to the slot of its type in an org, or adds it to the org's list of a many type.
export function bindConnection({ config, secrets, name, orgId }) {
  const type = typeOf(secrets, name);
  if (!type) throw new UserError(`unknown connection \`${name}\``);
  if (isHomeType(type)) throw new UserError(`connection \`${name}\` (${type}) serves the whole home and binds to no org`);
  if (isManyType(type)) {
    addToOrgList(config, orgId, type, name);
    return { config, type, previous: null };
  }
  const previous = connectionFor(config, orgId, type);
  slotsFor(config, orgId)[type] = name;
  return { config, type, previous };
}

// The type an org binding declares for a connection whose secret may be missing, or null when no org binds it.
function boundTypeOf(config, name) {
  for (const slots of Object.values(config?.orgConnections ?? {})) {
    const found = Object.entries(slots ?? {}).find(([, binding]) => boundNames(binding).includes(name));
    if (found) return found[0];
  }
  return null;
}

// Unbinds a connection from one org only, from its slot and its lists; a stored or merely bound connection is accepted.
export function unbindConnection({ config, secrets, name, orgId }) {
  const type = typeOf(secrets, name) ?? boundTypeOf(config, name);
  if (!type) throw new UserError(`unknown connection \`${name}\``);
  if (CONNECTION_TYPES.has(type) && isHomeType(type)) throw new UserError(`connection \`${name}\` (${type}) serves the whole home and binds to no org`);
  const slots = config?.orgConnections?.[orgId];
  let wasBound = false;
  for (const [slotType, bound] of Object.entries(slots ?? {})) {
    if (!boundNames(bound).includes(name)) continue;
    wasBound = true;
    slots[slotType] = Array.isArray(bound) ? bound.filter((listed) => listed !== name) : null;
  }
  return { config, type, wasBound };
}

// The one-line reason of a test result, never carrying the secret: the type's own sentence when it declares one.
export function testReason(type, result) {
  const reason = CONNECTION_TYPES.get(type)?.reason;
  if (typeof reason === "function") return reason(result);
  if (result?.status === null || result?.status === undefined) return `no answer (${result?.detail ?? "network failure"})`;
  return `${type} answered ${result.status}`;
}

// The `lastTest` a test result stands for: ok, when, the service's status and, on a failure, the reason.
export function lastTestOf({ type, result, at }) {
  const status = Number.isInteger(result?.status) ? result.status : null;
  return result?.ok === true ? { ok: true, at, status } : { ok: false, at, status, reason: testReason(type, result) };
}

// Tells whether two connection records are the same connection: same type and the same secret fields.
function sameConnection(stored, tested) {
  const fields = CONNECTION_TYPES.get(stored?.type)?.secretFields;
  if (!Array.isArray(fields) || !fields.length || stored.type !== tested?.type) return false;
  return fields.every((field) => typeof stored[field] === "string" && stored[field] === tested[field]);
}

// Records the outcome of a test on the record that was tested, answering the stored `lastTest` or null when that record is gone or was replaced.
export function recordTest({ secrets, name, tested, result, at }) {
  const record = secrets?.connections?.[name];
  if (!record || !sameConnection(record, tested)) return null;
  record.lastTest = lastTestOf({ type: record.type, result, at });
  return record.lastTest;
}

// Unbinds the connection from every org and deletes it from secrets.
export function removeConnection({ config, secrets, name }) {
  if (!hasConnection(secrets, name)) throw new UserError(`unknown connection \`${name}\``);
  const unboundFrom = orgsUsingConnection(config, name);
  for (const slots of Object.values(config?.orgConnections ?? {})) {
    for (const [type, bound] of Object.entries(slots ?? {})) {
      if (Array.isArray(bound)) slots[type] = bound.filter((listed) => listed !== name);
      else if (bound === name) slots[type] = null;
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
