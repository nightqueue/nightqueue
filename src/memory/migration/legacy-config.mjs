import { UserError } from "../../config/errors.mjs";
import { isId, newId } from "../../config/ids.mjs";
import { lockPath, runIfLockFree } from "../../config/lock.mjs";
import { configPath } from "../../config/paths.mjs";
import { loadRawConfig, serialize, writeFileAtomic } from "../../config/store.mjs";
import { hasColumn } from "../columns.mjs";
import { DATA_TABLES } from "../ddl.mjs";
import * as registry from "../registry.mjs";

// The registry a v17 `config.json` carried (`projects`, `orgs`, `defaultOrg` by name), read with the v17 normalization, and
// the two things done with it: the import into the database and, once imported, the strip of the file.

const V17_DEFAULT_ORG = "default";
const ORG_OWNING_TABLES = ["decisions", "roadmap_items"];

// Tells whether the value is a plain object usable as a map.
function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Tells whether a raw config still carries the v17 registry keys.
export function hasLegacyRegistry(raw) {
  return isPlainObject(raw) && (Object.hasOwn(raw, "projects") || Object.hasOwn(raw, "orgs"));
}

// Tells whether a raw config still names its default org by name instead of by id.
function hasNamedDefaultOrg(raw) {
  return isPlainObject(raw) && typeof raw.defaultOrg === "string" && raw.defaultOrg !== "" && !isId(raw.defaultOrg);
}

// The connection slots of a v17 org entry, one per type, null when unbound.
function v17Slots(raw) {
  const slots = { github: null };
  if (!isPlainObject(raw)) return slots;
  for (const [type, value] of Object.entries(raw)) slots[type] = typeof value === "string" && value ? value : null;
  return slots;
}

// The v17 registry of a raw config, normalized exactly as the v17 build did: the default org always exists, a project without a path is dropped.
export function readV17Registry(raw) {
  const source = isPlainObject(raw) ? raw : {};
  const defaultOrg = typeof source.defaultOrg === "string" && source.defaultOrg ? source.defaultOrg : V17_DEFAULT_ORG;
  const orgs = new Map();
  if (isPlainObject(source.orgs)) {
    for (const [name, entry] of Object.entries(source.orgs)) orgs.set(name, v17Slots(isPlainObject(entry) ? entry.connections : null));
  }
  if (!orgs.has(defaultOrg)) orgs.set(defaultOrg, v17Slots(null));
  const projects = [];
  if (isPlainObject(source.projects)) {
    for (const [name, entry] of Object.entries(source.projects)) {
      if (!isPlainObject(entry) || typeof entry.path !== "string" || !entry.path) continue;
      projects.push({ name, path: entry.path, org: typeof entry.org === "string" && entry.org ? entry.org : defaultOrg });
    }
  }
  return { defaultOrg, orgs, projects };
}

// The id of the org with the given name, or null; a read both the v18 and the current registry shape answer.
function orgIdByName(db, name) {
  return db.prepare("SELECT id FROM orgs WHERE name = ?").get(name)?.id ?? null;
}

// Tells whether a project with the given name is registered; a read both registry shapes answer.
function hasProjectNamed(db, name) {
  return Boolean(db.prepare("SELECT 1 FROM projects WHERE name = ?").get(name));
}

// The registry writes of the import in the shape the database has: keyed (a fresh database) or the v18 shape (inside the v18 migration).
function registryWriter(db) {
  if (hasColumn(db, "orgs", "key")) {
    return {
      insertOrg: (name) => registry.insertOrg(db, name),
      insertProject: (spec) => registry.insertProject(db, spec),
      ensureDefaultOrg: () => registry.ensureDefaultOrg(db),
    };
  }
  return {
    insertOrg: (name) => db.prepare("INSERT INTO orgs (id, name) VALUES (?, ?)").run(newId(), name),
    insertProject: ({ name, path, orgId }) => db.prepare("INSERT INTO projects (id, name, path, org_id) VALUES (?, ?, ?, ?)").run(newId(), name, path, orgId),
    ensureDefaultOrg: () =>
      db.prepare("INSERT INTO orgs (id, name) SELECT ?, ? WHERE NOT EXISTS (SELECT 1 FROM orgs)").run(newId(), registry.DEFAULT_ORG_NAME),
  };
}

// Creates every named org the registry does not know yet, in the order given.
function insertMissingOrgs(db, writer, names) {
  for (const name of names) {
    if (!orgIdByName(db, name)) writer.insertOrg(name);
  }
}

// The org names the data rows own something under, in table order.
function historyOrgNames(db) {
  return ORG_OWNING_TABLES.filter((table) => hasColumn(db, table, "org")).flatMap((table) =>
    db.prepare(`SELECT org FROM ${table} WHERE org IS NOT NULL GROUP BY org ORDER BY MIN(rowid)`).all().map((row) => row.org),
  );
}

// The project names the data rows own something under, in table order.
function historyProjectNames(db) {
  return DATA_TABLES.filter((table) => hasColumn(db, table, "project")).flatMap((table) =>
    db.prepare(`SELECT project FROM ${table} WHERE project IS NOT NULL GROUP BY project ORDER BY MIN(rowid)`).all().map((row) => row.project),
  );
}

// Refuses a v17 config where two projects share one checkout path, which only a hand edit produces.
function refuseSharedPaths(projects) {
  const byPath = new Map();
  for (const project of projects) {
    const other = byPath.get(project.path);
    if (other) {
      throw new UserError(`config projects \`${other}\` and \`${project.name}\` share the path ${project.path}; give one of them its own path in config.json`);
    }
    byPath.set(project.path, project.name);
  }
}

// Registers the projects of a v17 config the registry does not know yet, each with its path and its org.
function insertConfigProjects(db, writer, projects) {
  refuseSharedPaths(projects);
  for (const project of projects) {
    if (hasProjectNamed(db, project.name)) continue;
    writer.insertProject({ name: project.name, path: project.path, orgId: orgIdByName(db, project.org) });
  }
}

// The id of the home's default org: the v17 config's, else the one the config names by id or name, else the earliest (created when there is none).
function homeDefaultOrgId(db, writer, { raw, legacy }) {
  if (legacy) return orgIdByName(db, legacy.defaultOrg);
  const named = isPlainObject(raw) && typeof raw.defaultOrg === "string" ? raw.defaultOrg : null;
  const found = named && (isId(named) ? db.prepare("SELECT id FROM orgs WHERE id = ?").get(named)?.id : orgIdByName(db, named));
  if (found) return found;
  writer.ensureDefaultOrg();
  return db.prepare("SELECT id FROM orgs ORDER BY created_at, id LIMIT 1").get().id;
}

// Imports the v17 registry into the database, inside the caller's transaction: orgs, config projects, then every project known only from history.
export function importLegacyRegistry(db, raw) {
  const writer = registryWriter(db);
  const legacy = hasLegacyRegistry(raw) ? readV17Registry(raw) : null;
  if (legacy) {
    insertMissingOrgs(db, writer, [legacy.defaultOrg, ...legacy.orgs.keys(), ...legacy.projects.map((project) => project.org)]);
  }
  insertMissingOrgs(db, writer, historyOrgNames(db));
  const homeId = homeDefaultOrgId(db, writer, { raw, legacy });
  if (legacy) insertConfigProjects(db, writer, legacy.projects);
  for (const name of historyProjectNames(db)) {
    if (!hasProjectNamed(db, name)) writer.insertProject({ name, path: null, orgId: homeId });
  }
}

// The config and org names of a v17 registry the database does not hold, the ones a strip would lose.
function unimportedNames(db, legacy) {
  const orgs = [legacy.defaultOrg, ...legacy.orgs.keys()].filter((name) => !registry.orgByName(db, name)).map((name) => `org \`${name}\``);
  const projects = legacy.projects.filter((project) => !registry.projectByName(db, project.name)).map((project) => `project \`${project.name}\``);
  return [...new Set([...orgs, ...projects])];
}

// The connection bindings of the v17 orgs keyed by org id, never overwriting a binding the config already has.
function mappedConnections(db, raw, legacy) {
  const connections = isPlainObject(raw.orgConnections) ? { ...raw.orgConnections } : {};
  for (const [name, slots] of legacy.orgs) {
    const id = registry.orgByName(db, name)?.id;
    if (!id || connections[id] !== undefined || !Object.values(slots).some(Boolean)) continue;
    connections[id] = { ...slots };
  }
  return connections;
}

// The raw config without the v17 registry: bindings and the default org by id, every other key kept verbatim.
function strippedConfig(db, raw, legacy) {
  const next = { ...raw, orgConnections: mappedConnections(db, raw, legacy) };
  delete next.projects;
  delete next.orgs;
  if (!isId(raw.defaultOrg)) next.defaultOrg = registry.orgByName(db, legacy.defaultOrg).id;
  return next;
}

// Tells whether a raw config still needs the strip.
function stripPending(raw) {
  return hasLegacyRegistry(raw) || hasNamedDefaultOrg(raw);
}

// Rewrites config.json without the v17 registry once every name of it is in the database; it warns and keeps the file otherwise.
function stripUnderLock(db, env, warn) {
  const raw = loadRawConfig(env);
  if (!stripPending(raw)) return;
  const legacy = readV17Registry(raw);
  const missing = unimportedNames(db, legacy);
  if (missing.length) {
    warn(`nightqueue: warning: config.json still lists ${missing.join(", ")}, which the database does not know; the config keeps them`);
    return;
  }
  writeFileAtomic(configPath(env), serialize(strippedConfig(db, raw, legacy)));
}

// Strips the v17 registry out of config.json when it is still there; a lock another process holds defers it to the next open.
export function stripLegacyConfig(db, env, { warn }) {
  if (!stripPending(loadRawConfig(env))) return;
  runIfLockFree(lockPath(env), () => stripUnderLock(db, env, warn));
}
