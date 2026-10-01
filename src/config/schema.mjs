import { UserError } from "./errors.mjs";

export const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
export const SCHEMA_VERSION = 1;

// The name of the org the registry of a new home starts with.
export const DEFAULT_ORG_NAME = "default";

// The keys config.json owns and normalizes; every other top-level key is kept verbatim.
const OWNED_KEYS = new Set(["version", "defaultOrg", "orgConnections", "queue", "embedding"]);

// Seconds between two lease heartbeats of a runner; the upper bound keeps three heartbeats inside the lease grace.
export const LEASE_HEARTBEAT_DEFAULT_S = 5;
export const LEASE_HEARTBEAT_RANGE = { min: 1, max: 20 };

// Modes of `queue.keepAwake`: whether the machine is held awake while a runner or one of its jobs lives.
export const KEEP_AWAKE_MODES = ["auto", "always", "off"];
export const KEEP_AWAKE_DEFAULT = "auto";

// Ceilings of `queue.bashTimeoutS`, handed to every `claude` child as BASH_DEFAULT_TIMEOUT_MS/BASH_MAX_TIMEOUT_MS.
export const BASH_TIMEOUT_DEFAULT = Object.freeze({ default: 900, max: 3600 });

// Hard timeout of one `queue close` attempt, in seconds.
export const CLOSE_TIMEOUT_DEFAULT_S = 1800;
export const CLOSE_TIMEOUT_RANGE = { min: 60, max: 3600 };

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

// Initial structure of config.json: queue settings, the connection bindings per org id and the default org id.
export function emptyConfig() {
  return {
    version: SCHEMA_VERSION,
    defaultOrg: null,
    orgConnections: emptyMap(),
    queue: {
      maxConcurrent: null,
      resumeSession: false,
      leaseHeartbeatS: LEASE_HEARTBEAT_DEFAULT_S,
      keepAwake: KEEP_AWAKE_DEFAULT,
      bashTimeoutS: { ...BASH_TIMEOUT_DEFAULT },
      inheritUserEnvironment: false,
      closeTimeoutS: CLOSE_TIMEOUT_DEFAULT_S,
    },
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
      `${fileName} was written by a newer nightqueue (version ${version}); this nightqueue supports version ${SCHEMA_VERSION} — upgrade nightqueue or move the file out of the way`,
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

// Normalizes the connection bindings, one slot map per org id.
function normalizeOrgConnections(raw) {
  const bindings = emptyMap();
  if (!isPlainObject(raw)) return bindings;
  for (const [orgId, slots] of Object.entries(raw)) bindings[orgId] = normalizeSlots(slots);
  return bindings;
}

// The top-level keys config.json does not own, kept verbatim so no write ever drops what it does not understand.
function unownedKeys(raw) {
  return Object.fromEntries(Object.entries(raw).filter(([key]) => !OWNED_KEYS.has(key)));
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

// Ceilings of the bash timeouts handed to the child CLI; anything but two positive integers with max >= default falls back to the documented default.
function normalizeBashTimeout(value) {
  const source = isPlainObject(value) ? value : {};
  const isValid =
    Number.isInteger(source.default) && source.default > 0 && Number.isInteger(source.max) && source.max >= source.default;
  return isValid ? { default: source.default, max: source.max } : { ...BASH_TIMEOUT_DEFAULT };
}

// Hard timeout of a close attempt; anything but an integer inside the documented range falls back to the default.
function normalizeCloseTimeout(value) {
  const inRange = Number.isInteger(value) && value >= CLOSE_TIMEOUT_RANGE.min && value <= CLOSE_TIMEOUT_RANGE.max;
  return inRange ? value : CLOSE_TIMEOUT_DEFAULT_S;
}

// Fills defaults over a config read from disk or edited by hand, keeping every key it does not own as it is.
export function normalizeConfig(raw) {
  if (!isPlainObject(raw)) return emptyConfig();
  assertSupportedVersion("config.json", raw);
  const maxConcurrent = raw.queue?.maxConcurrent;
  return {
    version: SCHEMA_VERSION,
    defaultOrg: typeof raw.defaultOrg === "string" && raw.defaultOrg ? raw.defaultOrg : null,
    orgConnections: normalizeOrgConnections(raw.orgConnections),
    queue: {
      maxConcurrent: Number.isInteger(maxConcurrent) && maxConcurrent > 0 ? maxConcurrent : null,
      resumeSession: raw.queue?.resumeSession === true,
      leaseHeartbeatS: normalizeHeartbeat(raw.queue?.leaseHeartbeatS),
      keepAwake: normalizeKeepAwake(raw.queue?.keepAwake),
      bashTimeoutS: normalizeBashTimeout(raw.queue?.bashTimeoutS),
      inheritUserEnvironment: raw.queue?.inheritUserEnvironment === true,
      closeTimeoutS: normalizeCloseTimeout(raw.queue?.closeTimeoutS),
    },
    embedding: normalizeEmbedding(raw.embedding),
    ...unownedKeys(raw),
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
