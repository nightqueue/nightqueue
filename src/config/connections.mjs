import { UserError } from "./errors.mjs";
import { requireOrg } from "./orgs.mjs";
import { assertName } from "./schema.mjs";

const GITHUB_API = "https://api.github.com";

// Converts the GitHub API response into the connection test result.
async function githubResult(res) {
  const status = res.status;
  if (status < 200 || status >= 300) return { ok: false, status, login: null, scopes: null, detail: `HTTP ${status}` };
  const body = await res.json();
  return {
    ok: true,
    status,
    login: body?.login ?? null,
    scopes: res.headers.get("x-oauth-scopes") ?? null,
    detail: "ok",
  };
}

// Validates the token of a GitHub connection, without exposing the value in the result.
async function testGithub(secret, { fetchImpl = fetch, timeoutMs = 5000 } = {}) {
  try {
    const res = await fetchImpl(`${GITHUB_API}/user`, {
      method: "GET",
      headers: { Authorization: `Bearer ${secret.token}`, Accept: "application/vnd.github+json" },
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
    return await githubResult(res);
  } catch (err) {
    const timedOut = err?.name === "TimeoutError" || err?.name === "AbortError";
    const detail = timedOut ? `timeout (${Math.round(timeoutMs / 1000)}s)` : "network failure";
    return { ok: false, status: null, login: null, scopes: null, detail };
  }
}

export const CONNECTION_TYPES = new Map([["github", { secretFields: ["token"], extraFields: [], test: testGithub }]]);

// Returns the descriptor of a supported connection type.
export function requireType(type) {
  const descriptor = CONNECTION_TYPES.get(type);
  if (!descriptor) {
    throw new UserError(`unknown connection type \`${type}\`; supported: ${[...CONNECTION_TYPES.keys()].join(", ")}`);
  }
  return descriptor;
}

// Returns the NAME of the connection bound to a type in an org, never the secret.
export function connectionFor(config, orgName, type) {
  const name = config?.orgs?.[orgName]?.connections?.[type];
  return typeof name === "string" && name ? name : null;
}

// Lists the orgs pointing at a connection.
export function orgsUsingConnection(config, name) {
  return Object.entries(config.orgs)
    .filter(([, org]) => Object.values(org.connections).includes(name))
    .map(([orgName]) => orgName);
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

// Lists the connections with type, secret presence and bound orgs, never a secret value.
export function listConnections(config, secrets) {
  const rows = new Map();
  for (const [name, entry] of Object.entries(secrets.connections)) {
    rows.set(name, { name, type: entry.type, present: true, orgs: orgsUsingConnection(config, name) });
  }
  for (const org of Object.values(config.orgs)) {
    for (const [type, name] of Object.entries(org.connections)) {
      if (!name || rows.has(name)) continue;
      rows.set(name, { name, type, present: false, orgs: orgsUsingConnection(config, name) });
    }
  }
  return [...rows.values()];
}

// Builds config and secrets with the new connection, binding it to the org slot only when that slot is empty.
export function addConnection({ config, secrets, name, type, org, secret }) {
  assertName("connection", name);
  const descriptor = requireType(type);
  const orgName = org ?? config.defaultOrg;
  requireOrg(config, orgName);
  if (typeof secret !== "string" || !secret) throw new UserError("empty secret; nothing was stored");
  if (hasConnection(secrets, name)) throw new UserError(`connection \`${name}\` already exists; remove it first`);
  secrets.connections[name] = { type, [descriptor.secretFields[0]]: secret };
  const occupiedBy = connectionFor(config, orgName, type);
  if (!occupiedBy) config.orgs[orgName].connections[type] = name;
  return { config, secrets, org: orgName, bound: !occupiedBy, occupiedBy };
}

// Binds (or rebinds) an existing connection to the slot of its type in an org.
export function bindConnection({ config, secrets, name, org }) {
  const type = typeOf(secrets, name);
  if (!type) throw new UserError(`unknown connection \`${name}\``);
  requireOrg(config, org);
  requireType(type);
  const previous = connectionFor(config, org, type);
  config.orgs[org].connections[type] = name;
  return { config, type, previous };
}

// Unbinds the connection from every org and deletes it from secrets.
export function removeConnection({ config, secrets, name }) {
  if (!hasConnection(secrets, name)) throw new UserError(`unknown connection \`${name}\``);
  const unboundFrom = orgsUsingConnection(config, name);
  for (const org of Object.values(config.orgs)) {
    for (const [type, bound] of Object.entries(org.connections)) {
      if (bound === name) org.connections[type] = null;
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
