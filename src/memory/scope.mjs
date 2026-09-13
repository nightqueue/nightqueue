import { UserError } from "../config/errors.mjs";
import { requireOrg } from "../config/orgs.mjs";
import { projectByName } from "../config/projects.mjs";
import { loadConfig } from "../config/store.mjs";
import { resolveProjectName } from "./db.mjs";

export const SCOPE_CONFLICT = "pass either `project` or `org`, never both: a decision or a roadmap item has one owner";
export const SCOPE_MISSING = "pass `project` (the registered NAME) or `org` (an org of the config) to name the owner";

// The owner clause every write and every exact read of these two tables shares.
export const OWNER_CLAUSE = "scope = ? AND project IS ? AND org IS ?";

// Tells whether a reference names something, because an empty string names nothing.
function isNamed(value) {
  return typeof value === "string" && value.trim() !== "";
}

// Configuration of the home, without the warnings a read-only caller has no use for.
function config(env) {
  return loadConfig(env, { warn: () => {} });
}

// Owner triple of a project: its registered NAME and the org whose rows it also reads.
export function projectScope(project, env = process.env) {
  const name = resolveProjectName(project, env);
  return { scope: "project", project: name, org: name === null ? null : projectByName(config(env), name)?.org ?? null };
}

// Owner a call names: `project` XOR `org`, with the org validated against the config.
export function requireScopeTarget({ project, org } = {}, env = process.env) {
  if (isNamed(project) && isNamed(org)) throw new UserError(SCOPE_CONFLICT);
  if (isNamed(org)) {
    const name = org.trim();
    requireOrg(config(env), name);
    return { scope: "org", project: null, org: name };
  }
  if (!isNamed(project)) throw new UserError(SCOPE_MISSING);
  return projectScope(project, env);
}

// Owner a reference names: a project NAME, or the `{ project }` / `{ org }` shape of the tools.
export function requireOwnerTarget(owner, env = process.env) {
  return requireScopeTarget(typeof owner === "string" ? { project: owner } : owner ?? {}, env);
}

// Owner triple a stored row belongs to, the group its numbering and its positions live in.
export function rowOwner(row) {
  return { scope: row?.scope === "org" ? "org" : "project", project: row?.project ?? null, org: row?.org ?? null };
}

// Read target of a stored row: an org row reads its org, a project row reads its project and that project's org.
export function rowTarget(row, env = process.env) {
  return row?.scope === "org" ? rowOwner(row) : projectScope(row?.project ?? null, env);
}

// The `{ project }` or `{ org }` a target is passed on with, which never carries both.
export function ownerRef(target) {
  return target.scope === "org" ? { org: target.org } : { project: target.project };
}

// The three values `OWNER_CLAUSE` binds: a project row never carries an org, an org row never a project.
export function ownerValues(target) {
  return target.scope === "org" ? ["org", null, target.org] : ["project", target.project, null];
}

// Owner of a row, raw from the database or already in view shape.
export function ownerOf(row) {
  if (row?.scope === "org") return row.org ?? row.owner ?? null;
  return row?.project ?? row?.owner ?? null;
}

// How a row names its owner in a refusal: an org row belongs to an org, a project row to a project.
export function ownerDescription(row) {
  return row?.scope === "org" ? `org \`${ownerOf(row)}\`` : `project \`${ownerOf(row) ?? "global"}\``;
}

// The number prefix of a decision: only an org decision is owner-qualified, so `#7` never changes spelling.
export function ownerLabel(row) {
  return row?.scope === "org" ? `${ownerOf(row)}#${row.number}` : `#${row.number}`;
}

// The prefix a roadmap item's line carries: the org of an org item, nothing for a project item.
export function ownerPrefix(row) {
  return row?.scope === "org" ? `${ownerOf(row)} ` : "";
}

// Rows a target sees: its own and, for a project, the rows of its org; `prefix` qualifies the columns of a join.
export function visibility(target, prefix = "") {
  const at = prefix ? `${prefix}.` : "";
  if (target.scope === "org") return { clause: `(${at}scope = 'org' AND ${at}org = ?)`, values: [target.org] };
  return {
    clause: `((${at}scope = 'project' AND (${at}project = ? OR ${at}project IS NULL)) OR (${at}scope = 'org' AND ${at}org = ?))`,
    values: [target.project, target.org],
  };
}

// Tells whether an owner may link a row of another owner: its own rows and, for a project, the rows of its org.
export function seesRow(target, row) {
  if (row?.scope === "org") return row.org !== null && row.org === target.org;
  return target.scope === "project" && (row?.project ?? null) === (target.project ?? null);
}

// The org rows of a list, ahead of the rest, each group in the order it arrived.
export function orgFirst(rows) {
  const list = Array.isArray(rows) ? rows : [];
  return [...list.filter((row) => row?.scope === "org"), ...list.filter((row) => row?.scope !== "org")];
}
