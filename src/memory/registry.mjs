import { UserError } from "../config/errors.mjs";
import { isId, newId } from "../config/ids.mjs";
import { projectContaining } from "../config/projects.mjs";
import { DEFAULT_ORG_NAME } from "../config/schema.mjs";
import { hasColumn } from "./columns.mjs";
import { DATA_TABLES } from "./ddl.mjs";

// The only SQL over `orgs` and `projects`: every other module reaches a name through here.

export { DEFAULT_ORG_NAME };

const PROJECT_VIEW = `SELECT p.id, p.name, p.path, p.org_id, o.name AS org, p.created_at
  FROM projects AS p JOIN orgs AS o ON o.id = p.org_id`;

// Tells whether a SQLite failure is the violation of a UNIQUE constraint on the given column.
function isUniqueViolation(err, column) {
  return /UNIQUE constraint failed/i.test(String(err?.message ?? "")) && String(err.message).includes(column);
}

// Tells whether a SQLite failure is a foreign key refusing the write.
function isForeignKeyViolation(err) {
  return /FOREIGN KEY constraint failed/i.test(String(err?.message ?? ""));
}

// The org with the given name, or null.
export function orgByName(db, name) {
  return db.prepare("SELECT id, name, created_at FROM orgs WHERE name = ?").get(String(name ?? "")) ?? null;
}

// The org with the given id, or null.
export function orgById(db, id) {
  return db.prepare("SELECT id, name, created_at FROM orgs WHERE id = ?").get(String(id ?? "")) ?? null;
}

// Every org, in the order they were created.
export function listOrgs(db) {
  return db.prepare("SELECT id, name, created_at FROM orgs ORDER BY created_at, id").all();
}

// The earliest org, the default one of a home whose config names none; null on an empty registry.
export function earliestOrg(db) {
  return db.prepare("SELECT id, name, created_at FROM orgs ORDER BY created_at, id LIMIT 1").get() ?? null;
}

// The project with the given name, with its org name, or null.
export function projectByName(db, name) {
  return db.prepare(`${PROJECT_VIEW} WHERE p.name = ?`).get(String(name ?? "")) ?? null;
}

// The project with the given id, with its org name, or null.
export function projectById(db, id) {
  return db.prepare(`${PROJECT_VIEW} WHERE p.id = ?`).get(String(id ?? "")) ?? null;
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

// Creates an org and answers its row; a taken name is a usage error.
export function insertOrg(db, name) {
  try {
    return db.prepare("INSERT INTO orgs (id, name) VALUES (?, ?) RETURNING id, name, created_at").get(newId(), name);
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

// Registers a project (a null path is a project known only from history) and answers its row.
export function insertProject(db, { name, path = null, orgId }) {
  try {
    const { id } = db
      .prepare("INSERT INTO projects (id, name, path, org_id) VALUES (?, ?, ?, ?) RETURNING id")
      .get(newId(), name, path, orgId);
    return projectById(db, id);
  } catch (err) {
    throw projectWriteError(db, err, { name, path });
  }
}

// Creates the `default` org of a registry that has none, so every home always has a default org.
export function ensureDefaultOrg(db) {
  db.prepare("INSERT INTO orgs (id, name) SELECT ?, ? WHERE NOT EXISTS (SELECT 1 FROM orgs)").run(newId(), DEFAULT_ORG_NAME);
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

// Sets the current `project`, `project_path` and `org` names on rows that carry `project_id` / `org_id`.
export function attachNames(db, rows) {
  const list = Array.isArray(rows) ? rows : [];
  for (const row of list) {
    if (row && "project_id" in row) {
      const project = row.project_id ? projectById(db, row.project_id) : null;
      row.project = project?.name ?? null;
      row.project_path = project?.path ?? null;
    }
    if (row && "org_id" in row) row.org = row.org_id ? (orgById(db, row.org_id)?.name ?? null) : null;
  }
  return list;
}
