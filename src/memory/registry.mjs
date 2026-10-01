import { UserError } from "../config/errors.mjs";
import { isId, newId } from "../config/ids.mjs";
import { projectContaining } from "../config/projects.mjs";
import { DEFAULT_ORG_NAME } from "../config/schema.mjs";
import { hasColumn } from "./columns.mjs";
import { DATA_TABLES } from "./ddl.mjs";
import { requireKey, suggestKey } from "./refs.mjs";
import { orgTargetOf, projectTargetOf } from "./scope.mjs";
import { inTransaction } from "./tx.mjs";

// The only SQL over `orgs` and `projects`: every other module reaches a name through here.

export { DEFAULT_ORG_NAME };

const PROJECT_VIEW = `SELECT p.id, p.name, p.key, p.path, p.org_id, o.name AS org, o.key AS org_key, p.created_at
  FROM projects AS p JOIN orgs AS o ON o.id = p.org_id`;

const ORG_VIEW = "SELECT id, name, key, created_at FROM orgs";

const KEY_TAKEN = "owner key taken";

// Tells whether a SQLite failure is the violation of a UNIQUE constraint on the given column.
function isUniqueViolation(err, column) {
  return /UNIQUE constraint failed/i.test(String(err?.message ?? "")) && String(err.message).includes(column);
}

// Tells whether a SQLite failure is a foreign key refusing the write.
function isForeignKeyViolation(err) {
  return /FOREIGN KEY constraint failed/i.test(String(err?.message ?? ""));
}

// Tells whether a SQLite failure is the key guard refusing a key another owner holds.
function isKeyTaken(err) {
  return String(err?.message ?? "").includes(KEY_TAKEN) || isUniqueViolation(err, ".key");
}

// The org with the given name, or null.
export function orgByName(db, name) {
  return db.prepare(`${ORG_VIEW} WHERE name = ?`).get(String(name ?? "")) ?? null;
}

// The org with the given id, or null.
export function orgById(db, id) {
  return db.prepare(`${ORG_VIEW} WHERE id = ?`).get(String(id ?? "")) ?? null;
}

// Every org, in the order they were created.
export function listOrgs(db) {
  return db.prepare(`${ORG_VIEW} ORDER BY created_at, id`).all();
}

// The earliest org, the default one of a home whose config names none; null on an empty registry.
export function earliestOrg(db) {
  return db.prepare(`${ORG_VIEW} ORDER BY created_at, id LIMIT 1`).get() ?? null;
}

// Every key held right now: the project and org keys and the old keys of both.
export function takenKeys(db) {
  const rows = db
    .prepare(
      `SELECT key FROM projects UNION ALL SELECT key FROM orgs
       UNION ALL SELECT key FROM project_key_aliases UNION ALL SELECT key FROM org_key_aliases`,
    )
    .all();
  return new Set(rows.map((row) => row.key));
}

// A free key derived from a project or org name, one no owner holds now or held before.
export function suggestFreeKey(db, name, kind) {
  return suggestKey(name, takenKeys(db), { kind });
}

// Who holds a key, current or old: `{ kind, id, name, current }`, or null when nobody does.
export function keyHolder(db, key) {
  const text = String(key ?? "");
  return (
    db
      .prepare(
        `SELECT 'project' AS kind, id, name, 1 AS current FROM projects WHERE key = ?1
         UNION ALL SELECT 'org', id, name, 1 FROM orgs WHERE key = ?1
         UNION ALL SELECT 'project', p.id, p.name, 0 FROM project_key_aliases AS a JOIN projects AS p ON p.id = a.project_id WHERE a.key = ?1
         UNION ALL SELECT 'org', o.id, o.name, 0 FROM org_key_aliases AS a JOIN orgs AS o ON o.id = a.org_id WHERE a.key = ?1
         LIMIT 1`,
      )
      .all(text)
      .map((row) => ({ kind: row.kind, id: row.id, name: row.name, current: row.current === 1 }))[0] ?? null
  );
}

// The owner a key names, current or old, as the scope target of its project or org, or null.
export function ownerByKey(db, key) {
  const holder = keyHolder(db, key);
  if (holder?.kind === "project") return projectTargetOf(projectById(db, holder.id));
  if (holder?.kind === "org") return orgTargetOf(orgById(db, holder.id));
  return null;
}

// Refuses a key another owner holds (current or old); the caller's own old key is not in the way.
function refuseTakenKey(db, key, { kind, id }) {
  const holder = keyHolder(db, key);
  if (!holder || (holder.kind === kind && holder.id === id && !holder.current)) return;
  const what = holder.current ? "the key" : "an old key";
  throw new UserError(`key \`${key}\` is taken: it is ${what} of ${holder.kind} \`${holder.name}\``);
}

// The key a new owner gets: the one asked for, validated and free, or a free one derived from its name.
function newOwnerKey(db, { name, key, kind }) {
  if (key === undefined || key === null || key === "") return suggestKey(name, takenKeys(db), { kind });
  const wanted = requireKey(key);
  refuseTakenKey(db, wanted, { kind, id: null });
  return wanted;
}

// The project with the given name, with its org name, or null.
export function projectByName(db, name) {
  return db.prepare(`${PROJECT_VIEW} WHERE p.name = ?`).get(String(name ?? "")) ?? null;
}

// The project with the given id, with its org name, or null.
export function projectById(db, id) {
  return db.prepare(`${PROJECT_VIEW} WHERE p.id = ?`).get(String(id ?? "")) ?? null;
}

// The integrations of a project as an object, or null when it has none, its value is unreadable or the column is not there yet.
export function projectIntegrations(db, id) {
  if (!hasColumn(db, "projects", "integrations")) return null;
  const row = db.prepare("SELECT integrations FROM projects WHERE id = ?").get(String(id ?? ""));
  return parseIntegrations(row?.integrations);
}

// Tells whether a value is a plain object with at least one key.
function isFilledObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length > 0;
}

// A stored integrations value as a non-empty plain object, or null.
function parseIntegrations(text) {
  if (typeof text !== "string" || !text) return null;
  try {
    const parsed = JSON.parse(text);
    return isFilledObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// Writes a project's integrations as JSON text; null or an empty object stores NULL.
export function setProjectIntegrations(db, { id, value }) {
  if (!projectById(db, id)) throw new UserError(`unknown project id \`${id}\``);
  const isEmpty = value === null || value === undefined || (typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0);
  if (!isEmpty && !isFilledObject(value)) throw new UserError("project integrations must be an object of settings per provider");
  db.prepare("UPDATE projects SET integrations = ? WHERE id = ?").run(isEmpty ? null : JSON.stringify(value), String(id));
  return projectIntegrations(db, id);
}

// Every project, path-less ones included, in the order they were registered.
export function listProjects(db) {
  return db.prepare(`${PROJECT_VIEW} ORDER BY p.rowid`).all();
}

// The projects of one org, in the order they were registered.
export function projectsOfOrg(db, orgId) {
  return db.prepare(`${PROJECT_VIEW} WHERE p.org_id = ? ORDER BY p.rowid`).all(String(orgId ?? ""));
}

// The project whose checkout contains the directory, the longest path winning; null when none does.
export function projectAt(db, cwd) {
  return projectContaining(listProjects(db), cwd);
}

// The usage error a key the guard refused means: the friendly refusal naming the holder, or a generic one in a race.
function keyTakenError(db, key, owner) {
  try {
    refuseTakenKey(db, key, owner);
  } catch (err) {
    return err;
  }
  return new UserError(`key \`${key}\` is taken by another project or org`);
}

const SUGGESTION_ATTEMPTS = 3;

// Runs an owner insert with its key; a suggested key a racer took first is suggested again, an asked key never is.
function insertWithKey(db, { name, key, kind }, insert) {
  for (let attempt = 1; ; attempt += 1) {
    const ownerKey = newOwnerKey(db, { name, key, kind });
    try {
      return insert(ownerKey);
    } catch (err) {
      const asked = !(key === undefined || key === null || key === "");
      if (!isKeyTaken(err)) throw err;
      if (asked || attempt >= SUGGESTION_ATTEMPTS) throw keyTakenError(db, ownerKey, { kind, id: null });
    }
  }
}

// Creates an org with the given key, or a free one derived from its name, and answers its row; a taken name or key is a usage error.
export function insertOrg(db, name, key = null) {
  try {
    return insertWithKey(db, { name, key, kind: "org" }, (orgKey) =>
      db.prepare("INSERT INTO orgs (id, name, key) VALUES (?, ?, ?) RETURNING id, name, key, created_at").get(newId(), name, orgKey),
    );
  } catch (err) {
    if (isUniqueViolation(err, "orgs.name")) throw new UserError(`org \`${name}\` already exists`);
    throw err;
  }
}

// The usage error a UNIQUE violation of a project write means, or the error itself.
function projectWriteError(db, err, { name, path }) {
  if (isUniqueViolation(err, "projects.name")) return new UserError(`project name \`${name}\` is already taken`);
  if (isUniqueViolation(err, "projects.path")) {
    const holder = db.prepare("SELECT name FROM projects WHERE path = ?").get(path);
    return new UserError(`\`${path}\` is already registered as \`${holder?.name ?? "another project"}\``);
  }
  if (isForeignKeyViolation(err)) return new UserError(`unknown org for project \`${name}\``);
  return err;
}

// Registers a project (a null path is a project known only from history) with the given key, or a free one derived from its name, and answers its row.
export function insertProject(db, { name, path = null, orgId, key = null }) {
  try {
    const { id } = insertWithKey(db, { name, key, kind: "project" }, (projectKey) =>
      db.prepare("INSERT INTO projects (id, name, key, path, org_id) VALUES (?, ?, ?, ?, ?) RETURNING id").get(newId(), name, projectKey, path, orgId),
    );
    return projectById(db, id);
  } catch (err) {
    throw projectWriteError(db, err, { name, path });
  }
}

// Creates the `default` org of a registry that has none, so every home always has a default org.
export function ensureDefaultOrg(db) {
  if (db.prepare("SELECT 1 FROM orgs LIMIT 1").get()) return;
  const key = suggestKey(DEFAULT_ORG_NAME, takenKeys(db), { kind: "org" });
  db.prepare("INSERT INTO orgs (id, name, key) SELECT ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM orgs)").run(newId(), DEFAULT_ORG_NAME, key);
}

// The table, alias table and owner column of a key owner kind.
const KEY_OWNERS = Object.freeze({
  project: { table: "projects", aliases: "project_key_aliases", column: "project_id", byId: projectById },
  org: { table: "orgs", aliases: "org_key_aliases", column: "org_id", byId: orgById },
});

// Gives an owner a new key in one transaction: the old key becomes an alias that keeps resolving, and one's own old key is reclaimed.
function setOwnerKey(db, kind, { id, key }) {
  const owner = KEY_OWNERS[kind];
  return inTransaction(db, () => {
    const wanted = requireKey(key);
    const row = owner.byId(db, id);
    if (!row) throw new UserError(`unknown ${kind} id \`${id}\``);
    if (row.key === wanted) throw new UserError(`${kind} \`${row.name}\` already has key \`${wanted}\``);
    refuseTakenKey(db, wanted, { kind, id });
    db.prepare(`DELETE FROM ${owner.aliases} WHERE key = ? AND ${owner.column} = ?`).run(wanted, id);
    db.prepare(`UPDATE ${owner.table} SET key = ? WHERE id = ?`).run(wanted, id);
    db.prepare(`INSERT INTO ${owner.aliases} (key, ${owner.column}) VALUES (?, ?)`).run(row.key, id);
    return { row: owner.byId(db, id), oldKey: row.key, key: wanted };
  });
}

// The old keys of every owner of a kind, oldest first, keyed by the owner id.
export function keyAliases(db, kind) {
  const owner = KEY_OWNERS[kind];
  if (!owner) throw new Error(`unknown key owner kind \`${kind}\``);
  const rows = db.prepare(`SELECT key, ${owner.column} AS owner_id FROM ${owner.aliases} ORDER BY created_at, rowid`).all();
  const aliases = {};
  for (const row of rows) (aliases[row.owner_id] ??= []).push(row.key);
  return aliases;
}

// Gives a project a new key; its old key keeps resolving to it.
export function setProjectKey(db, { id, key }) {
  return setOwnerKey(db, "project", { id, key });
}

// Gives an org a new key; its old key keeps resolving to it.
export function setOrgKey(db, { id, key }) {
  return setOwnerKey(db, "org", { id, key });
}

// Renames an org: one row, because every other table owns rows by the org's id.
export function renameOrg(db, { id, name }) {
  if (!orgById(db, id)) throw new UserError(`unknown org id \`${id}\``);
  try {
    db.prepare("UPDATE orgs SET name = ? WHERE id = ?").run(name, id);
  } catch (err) {
    if (isUniqueViolation(err, "orgs.name")) throw new UserError(`org \`${name}\` already exists`);
    throw err;
  }
  return orgById(db, id);
}

// Renames a project: one row, because every other table owns rows by the project's id.
export function renameProject(db, { id, name }) {
  const project = projectById(db, id);
  if (!project) throw new UserError(`unknown project id \`${id}\``);
  try {
    db.prepare("UPDATE projects SET name = ? WHERE id = ?").run(name, id);
  } catch (err) {
    throw projectWriteError(db, err, { name, path: project.path });
  }
  return projectById(db, id);
}

// Moves a project to another org and/or gives it a new checkout path; only the fields passed change.
export function moveProject(db, { id, orgId, path }) {
  const project = projectById(db, id);
  if (!project) throw new UserError(`unknown project id \`${id}\``);
  try {
    db.prepare("UPDATE projects SET org_id = ?, path = ? WHERE id = ?").run(orgId ?? project.org_id, path === undefined ? project.path : path, id);
  } catch (err) {
    throw projectWriteError(db, err, { name: project.name, path });
  }
  return projectById(db, id);
}

// The rows a project or an org still owns, per data table that has the owner's id column and only where there is any.
export function ownedRowCounts(db, { projectId, orgId }) {
  const [column, id] = projectId ? ["project_id", projectId] : ["org_id", orgId];
  return DATA_TABLES.filter((table) => hasColumn(db, table, column))
    .map((table) => ({ table, total: db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = ?`).get(id).n }))
    .filter((entry) => entry.total > 0);
}

// The refusal of removing an owner of rows, listing what it owns.
function ownedRowsError(kind, name, owned) {
  const detail = owned.map((entry) => `${entry.total} ${entry.table.replaceAll("_", " ")}`).join(", ");
  return new UserError(`cannot remove ${kind} \`${name}\`: it still owns ${detail}; nothing was removed`);
}

// Deletes one registry row; the foreign keys refuse it while any data row still points to it, and the refusal lists those rows.
function deleteOwner(db, { table, kind, row, owner }) {
  try {
    db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(row.id);
  } catch (err) {
    if (!isForeignKeyViolation(err)) throw err;
    throw ownedRowsError(kind, row.name, ownedRowCounts(db, owner));
  }
  return row;
}

// Removes a project; the database refuses one that still owns rows.
export function removeProject(db, id) {
  const project = projectById(db, id);
  if (!project) throw new UserError(`unknown project id \`${id}\``);
  return deleteOwner(db, { table: "projects", kind: "project", row: project, owner: { projectId: id } });
}

// Removes an org that no project points to; the database refuses one that still owns rows.
export function removeOrg(db, id) {
  const org = orgById(db, id);
  if (!org) throw new UserError(`unknown org id \`${id}\``);
  const members = projectsOfOrg(db, id).map((project) => project.name);
  if (members.length) {
    throw new UserError(`cannot remove org \`${org.name}\`: ${members.length} project(s) still point to it: ${members.join(", ")}`);
  }
  return deleteOwner(db, { table: "orgs", kind: "org", row: org, owner: { orgId: id } });
}

// The project id a data row is owned by: an id, or null for a global row; anything else is refused before it reaches SQL.
export function projectIdOrNull(value) {
  if (value === undefined || value === null || value === "") return null;
  if (isId(value)) return value;
  throw new UserError(`expected a project id, got \`${String(value)}\`; resolve the project name at the edge`);
}

// Sets the current `project`, `project_path`, `project_key`, `org` and `org_key` on rows that carry `project_id` / `org_id`.
export function attachNames(db, rows) {
  const list = Array.isArray(rows) ? rows : [];
  for (const row of list) {
    if (row && "project_id" in row) {
      const project = row.project_id ? projectById(db, row.project_id) : null;
      row.project = project?.name ?? null;
      row.project_path = project?.path ?? null;
      row.project_key = project?.key ?? null;
    }
    if (row && "org_id" in row) {
      const org = row.org_id ? orgById(db, row.org_id) : null;
      row.org = org?.name ?? null;
      row.org_key = org?.key ?? null;
    }
  }
  return list;
}
