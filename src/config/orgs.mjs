import { UserError } from "./errors.mjs";
import { assertName, emptyMap, emptySlots } from "./schema.mjs";

// Este modulo e puro sobre o objeto de config: muta e devolve o mesmo objeto, sem I/O.

// Devolve a entrada de uma org, ou null quando ela nao existe.
export function getOrg(config, name) {
  return config?.orgs?.[name] ?? null;
}

// Devolve a org exigida, listando as existentes quando ela nao existe.
export function requireOrg(config, name) {
  const org = getOrg(config, name);
  if (org) return org;
  const existing = Object.keys(config?.orgs ?? {});
  throw new UserError(`unknown org \`${name}\`; existing orgs: ${existing.length ? existing.join(", ") : "(none)"}`);
}

// Conta os projetos ligados a uma org.
function countProjects(config, name) {
  return Object.values(config.projects).filter((project) => project.org === name).length;
}

// Lista as orgs com display name, slots de connection e contagem de projetos.
export function listOrgs(config) {
  return Object.entries(config.orgs).map(([name, org]) => ({
    name,
    displayName: org.displayName,
    isDefault: name === config.defaultOrg,
    connections: { ...org.connections },
    projects: countProjects(config, name),
  }));
}

// Cria uma org nova.
export function addOrg(config, name, { displayName } = {}) {
  assertName("org", name);
  if (config.orgs[name]) throw new UserError(`org \`${name}\` already exists`);
  config.orgs[name] = { displayName: displayName || name, connections: emptySlots() };
  return config;
}

// Reescreve um mapa trocando uma chave, mantendo a ordem original das chaves.
function renameKey(map, oldKey, newKey) {
  const next = emptyMap();
  for (const [key, value] of Object.entries(map)) next[key === oldKey ? newKey : key] = value;
  return next;
}

// Renomeia uma org preservando posicao, display name, slots, projetos e a org default.
export function renameOrg(config, oldName, newName) {
  requireOrg(config, oldName);
  assertName("org", newName);
  if (oldName === newName) throw new UserError(`org \`${oldName}\` already has that name`);
  if (config.orgs[newName]) throw new UserError(`org \`${newName}\` already exists`);
  config.orgs = renameKey(config.orgs, oldName, newName);
  for (const project of Object.values(config.projects)) {
    if (project.org === oldName) project.org = newName;
  }
  if (config.defaultOrg === oldName) config.defaultOrg = newName;
  return config;
}

// Remove uma org que nao seja a default e nao tenha projetos apontando para ela.
export function removeOrg(config, name) {
  requireOrg(config, name);
  if (name === config.defaultOrg) throw new UserError(`cannot remove org \`${name}\`: it is the default org`);
  const used = Object.keys(config.projects).filter((project) => config.projects[project].org === name);
  if (used.length) {
    throw new UserError(`cannot remove org \`${name}\`: ${used.length} project(s) still point to it: ${used.join(", ")}`);
  }
  delete config.orgs[name];
  return config;
}
