import { UserError } from "./errors.mjs";

export const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
export const SCHEMA_VERSION = 1;

const DEFAULT_ORG = "default";

// Seconds between two lease heartbeats of a runner; the upper bound keeps three heartbeats inside the lease grace.
export const LEASE_HEARTBEAT_DEFAULT_S = 5;
export const LEASE_HEARTBEAT_RANGE = { min: 1, max: 20 };

// Modes of `queue.keepAwake`: whether the machine is held awake while a runner or one of its jobs lives.
export const KEEP_AWAKE_MODES = ["auto", "always", "off"];
export const KEEP_AWAKE_DEFAULT = "auto";

// Tells whether the value is a plain object usable as a map.
function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Creates an empty map without prototype: a key lookup never inherits anything from a hand-edited file.
export function emptyMap() {
  return Object.create(null);
}

// Creates the connection slots of an org, one per supported type.
export function emptySlots() {
  const slots = emptyMap();
  slots.github = null;
  return slots;
}

// Initial structure of config.json.
export function emptyConfig() {
  const orgs = emptyMap();
  orgs[DEFAULT_ORG] = { displayName: "Default", connections: emptySlots() };
  return {
    version: SCHEMA_VERSION,
    defaultOrg: DEFAULT_ORG,
    orgs,
    projects: emptyMap(),
    queue: { maxConcurrent: null, resumeSession: false, leaseHeartbeatS: LEASE_HEARTBEAT_DEFAULT_S, keepAwake: KEEP_AWAKE_DEFAULT },
    embedding: null,
  };
}

// Initial structure of secrets.json.
export function emptySecrets() {
  return { version: SCHEMA_VERSION, connections: emptyMap() };
}

// Validates an org, project or connection name.
export function assertName(kind, value) {
  if (typeof value !== "string" || !NAME_RE.test(value)) {
    throw new UserError(
      `invalid ${kind} name \`${value ?? ""}\`: use lowercase letters, digits, '.', '_' or '-', starting with a letter or digit, max 64 characters`,
    );
  }
  return value;
}

// Converts a name derived from a basename into the form the validator accepts.
export function normalizeName(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-._]+/, "")
    .replace(/[-._]+$/, "");
}

// Refuses a file written by a newer version, instead of downgrading it on the next write.
function assertSupportedVersion(fileName, raw) {
  const version = raw.version;
  if (typeof version === "number" && version > SCHEMA_VERSION) {
    throw new UserError(
      `${fileName} was written by a newer nightshift (version ${version}); this nightshift supports version ${SCHEMA_VERSION} — upgrade nightshift or move the file out of the way`,
    );
  }
}

// Normalizes the connection slots of an org.
function normalizeSlots(raw) {
  const slots = emptySlots();
  if (!isPlainObject(raw)) return slots;
  for (const [type, value] of Object.entries(raw)) {
    slots[type] = typeof value === "string" && value ? value : null;
  }
  return slots;
}

// Normalizes an org entry.
function normalizeOrg(name, entry) {
  const source = isPlainObject(entry) ? entry : {};
  const displayName = typeof source.displayName === "string" && source.displayName ? source.displayName : null;
  return {
    displayName: displayName ?? (name === DEFAULT_ORG ? "Default" : name),
    connections: normalizeSlots(source.connections),
  };
}

// Normalizes the org map, making sure the default org exists.
function normalizeOrgs(raw, defaultOrg) {
  const orgs = emptyMap();
  if (isPlainObject(raw)) {
    for (const [name, entry] of Object.entries(raw)) orgs[name] = normalizeOrg(name, entry);
  }
  if (!orgs[defaultOrg]) orgs[defaultOrg] = normalizeOrg(defaultOrg, null);
  return orgs;
}

// Normalizes the project map, dropping entries without a path.
function normalizeProjects(raw, defaultOrg) {
  const projects = emptyMap();
  if (!isPlainObject(raw)) return projects;
  for (const [name, entry] of Object.entries(raw)) {
    if (!isPlainObject(entry) || typeof entry.path !== "string" || !entry.path) continue;
    projects[name] = { path: entry.path, org: typeof entry.org === "string" && entry.org ? entry.org : defaultOrg };
  }
  return projects;
}

// Warns about a project pointing at an unknown org, without rewriting the operator data.
function warnOnOrphanProjects(projects, orgs, warn) {
  for (const [name, entry] of Object.entries(projects)) {
    if (orgs[entry.org]) continue;
    warn(
      `nightshift: warning: project \`${name}\` points to unknown org \`${entry.org}\`; run \`nightshift project move ${name} <org>\``,
    );
  }
}

// Heartbeat of the queue lease, clamped to the range that keeps a live runner ahead of the reclaim grace.
function normalizeHeartbeat(value) {
  const inRange =
    Number.isInteger(value) && value >= LEASE_HEARTBEAT_RANGE.min && value <= LEASE_HEARTBEAT_RANGE.max;
  return inRange ? value : LEASE_HEARTBEAT_DEFAULT_S;
}

// Answer already recorded for the semantic recall: only a decline is remembered, because an accepted answer is the installed library itself.
function normalizeEmbedding(value) {
  return value === "declined" ? "declined" : null;
}

// Whether the machine is held awake while a runner or job lives; anything but a documented mode normalizes to `auto`.
function normalizeKeepAwake(value) {
  return KEEP_AWAKE_MODES.includes(value) ? value : KEEP_AWAKE_DEFAULT;
}

// Fills defaults over a config read from disk or edited by hand.
export function normalizeConfig(raw, { warn = () => {} } = {}) {
  if (!isPlainObject(raw)) return emptyConfig();
  assertSupportedVersion("config.json", raw);
  const defaultOrg = typeof raw.defaultOrg === "string" && raw.defaultOrg ? raw.defaultOrg : DEFAULT_ORG;
  const maxConcurrent = raw.queue?.maxConcurrent;
  const orgs = normalizeOrgs(raw.orgs, defaultOrg);
  const projects = normalizeProjects(raw.projects, defaultOrg);
  warnOnOrphanProjects(projects, orgs, warn);
  return {
    version: SCHEMA_VERSION,
    defaultOrg,
    orgs,
    projects,
    queue: {
      maxConcurrent: Number.isInteger(maxConcurrent) && maxConcurrent > 0 ? maxConcurrent : null,
      resumeSession: raw.queue?.resumeSession === true,
      leaseHeartbeatS: normalizeHeartbeat(raw.queue?.leaseHeartbeatS),
      keepAwake: normalizeKeepAwake(raw.queue?.keepAwake),
    },
    embedding: normalizeEmbedding(raw.embedding),
  };
}

// Fills defaults over a secrets file read from disk.
export function normalizeSecrets(raw) {
  const secrets = emptySecrets();
  if (!isPlainObject(raw)) return secrets;
  assertSupportedVersion("secrets.json", raw);
  if (!isPlainObject(raw.connections)) return secrets;
  for (const [name, entry] of Object.entries(raw.connections)) {
    if (!isPlainObject(entry) || typeof entry.type !== "string" || !entry.type) continue;
    secrets.connections[name] = { ...entry };
  }
  return secrets;
}
