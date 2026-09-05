import { UserError } from "./errors.mjs";

export const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
export const SCHEMA_VERSION = 1;

const DEFAULT_ORG = "default";

// Diz se o valor e um objeto simples aproveitavel como mapa.
function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Cria um mapa vazio sem prototipo: leitura por chave nunca herda nada de um arquivo editado a mao.
export function emptyMap() {
  return Object.create(null);
}

// Cria os slots de connection de uma org, um por tipo suportado.
export function emptySlots() {
  const slots = emptyMap();
  slots.github = null;
  return slots;
}

// Estrutura inicial de config.json.
export function emptyConfig() {
  const orgs = emptyMap();
  orgs[DEFAULT_ORG] = { displayName: "Default", connections: emptySlots() };
  return { version: SCHEMA_VERSION, defaultOrg: DEFAULT_ORG, orgs, projects: emptyMap(), queue: { maxConcurrent: 2 } };
}

// Estrutura inicial de secrets.json.
export function emptySecrets() {
  return { version: SCHEMA_VERSION, connections: emptyMap() };
}

// Valida um nome de org, projeto ou connection.
export function assertName(kind, value) {
  if (typeof value !== "string" || !NAME_RE.test(value)) {
    throw new UserError(
      `invalid ${kind} name \`${value ?? ""}\`: use lowercase letters, digits, '.', '_' or '-', starting with a letter or digit, max 64 characters`,
    );
  }
  return value;
}

// Converte um nome derivado de basename para a forma aceita pelo validador.
export function normalizeName(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-._]+/, "")
    .replace(/[-._]+$/, "");
}

// Recusa um arquivo gravado por uma versao mais nova, em vez de rebaixa-lo na proxima escrita.
function assertSupportedVersion(fileName, raw) {
  const version = raw.version;
  if (typeof version === "number" && version > SCHEMA_VERSION) {
    throw new UserError(
      `${fileName} was written by a newer shift (version ${version}); this shift supports version ${SCHEMA_VERSION} — upgrade shift or move the file out of the way`,
    );
  }
}

// Normaliza os slots de connection de uma org.
function normalizeSlots(raw) {
  const slots = emptySlots();
  if (!isPlainObject(raw)) return slots;
  for (const [type, value] of Object.entries(raw)) {
    slots[type] = typeof value === "string" && value ? value : null;
  }
  return slots;
}

// Normaliza uma entrada de org.
function normalizeOrg(name, entry) {
  const source = isPlainObject(entry) ? entry : {};
  const displayName = typeof source.displayName === "string" && source.displayName ? source.displayName : null;
  return {
    displayName: displayName ?? (name === DEFAULT_ORG ? "Default" : name),
    connections: normalizeSlots(source.connections),
  };
}

// Normaliza o mapa de orgs, garantindo a existencia da org default.
function normalizeOrgs(raw, defaultOrg) {
  const orgs = emptyMap();
  if (isPlainObject(raw)) {
    for (const [name, entry] of Object.entries(raw)) orgs[name] = normalizeOrg(name, entry);
  }
  if (!orgs[defaultOrg]) orgs[defaultOrg] = normalizeOrg(defaultOrg, null);
  return orgs;
}

// Normaliza o mapa de projetos, descartando entradas sem path.
function normalizeProjects(raw, defaultOrg) {
  const projects = emptyMap();
  if (!isPlainObject(raw)) return projects;
  for (const [name, entry] of Object.entries(raw)) {
    if (!isPlainObject(entry) || typeof entry.path !== "string" || !entry.path) continue;
    projects[name] = { path: entry.path, org: typeof entry.org === "string" && entry.org ? entry.org : defaultOrg };
  }
  return projects;
}

// Avisa sobre projeto apontando para org inexistente, sem reescrever o dado do operador.
function warnOnOrphanProjects(projects, orgs, warn) {
  for (const [name, entry] of Object.entries(projects)) {
    if (orgs[entry.org]) continue;
    warn(
      `shift: warning: project \`${name}\` points to unknown org \`${entry.org}\`; run \`shift project move ${name} <org>\``,
    );
  }
}

// Preenche defaults sobre um config lido do disco ou editado a mao.
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
    queue: { maxConcurrent: Number.isInteger(maxConcurrent) && maxConcurrent > 0 ? maxConcurrent : 2 },
  };
}

// Preenche defaults sobre um secrets lido do disco.
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
