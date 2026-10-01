// The integrations' view of config.json and secrets.json: a record holding a secret never leaves src/integrations.

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

// The org's connections of a kind, secrets included: its slot record and the records of its list.
export function resolveForClose({ kind, orgId, config, secrets }) {
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
