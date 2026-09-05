import { UserError } from "./errors.mjs";
import { requireOrg } from "./orgs.mjs";
import { assertName } from "./schema.mjs";

const GITHUB_API = "https://api.github.com";

// Converte a resposta da API do GitHub no resultado do teste de connection.
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

// Valida o token de uma connection GitHub, sem expor o valor no resultado.
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

// Devolve o descritor de um tipo de connection suportado.
export function requireType(type) {
  const descriptor = CONNECTION_TYPES.get(type);
  if (!descriptor) {
    throw new UserError(`unknown connection type \`${type}\`; supported: ${[...CONNECTION_TYPES.keys()].join(", ")}`);
  }
  return descriptor;
}

// Devolve o NOME da connection ligada a um tipo numa org, nunca o segredo.
export function connectionFor(config, orgName, type) {
  const name = config?.orgs?.[orgName]?.connections?.[type];
  return typeof name === "string" && name ? name : null;
}

// Lista as orgs que apontam para uma connection.
export function orgsUsingConnection(config, name) {
  return Object.entries(config.orgs)
    .filter(([, org]) => Object.values(org.connections).includes(name))
    .map(([orgName]) => orgName);
}

// Diz se existe segredo guardado para a connection, sem ler o valor.
export function hasConnection(secrets, name) {
  return Boolean(secrets?.connections?.[name]);
}

// Devolve o tipo declarado de uma connection, sem ler o valor do segredo.
export function typeOf(secrets, name) {
  const type = secrets?.connections?.[name]?.type;
  return typeof type === "string" ? type : null;
}

// Unico ponto do projeto que devolve o registro com o valor do segredo.
export function secretOf(secrets, name) {
  return secrets?.connections?.[name] ?? null;
}

// Lista as connections com tipo, presenca do segredo e orgs ligadas, sem valor de segredo.
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

// Monta config e secrets com a connection nova, ligando ao slot da org so quando ele esta vazio.
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

// Liga (ou religa) uma connection existente ao slot do tipo dela numa org.
export function bindConnection({ config, secrets, name, org }) {
  const type = typeOf(secrets, name);
  if (!type) throw new UserError(`unknown connection \`${name}\``);
  requireOrg(config, org);
  requireType(type);
  const previous = connectionFor(config, org, type);
  config.orgs[org].connections[type] = name;
  return { config, type, previous };
}

// Desliga a connection de todas as orgs e a remove do secrets.
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

// Testa a connection contra o servico do tipo dela, sem expor o segredo no retorno.
export async function testConnection({ name, secrets, fetchImpl = fetch, timeoutMs = 5000 }) {
  const secret = secretOf(secrets, name);
  if (!secret) throw new UserError(`unknown connection \`${name}\``);
  const descriptor = requireType(secret.type);
  const result = await descriptor.test(secret, { fetchImpl, timeoutMs });
  return { type: secret.type, ...result };
}
