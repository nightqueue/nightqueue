import { UserError } from "../config/errors.mjs";
import { isId } from "../config/ids.mjs";
import { GLOBAL_KEY, decisionRef } from "./refs.mjs";
import * as registry from "./registry.mjs";

export { decisionRef };

export const SCOPE_CONFLICT = "pass either `project` or `org`, never both: a decision or a roadmap item has one owner";
export const SCOPE_MISSING = "pass `project` (the registered NAME) or `org` (a registered org) to name the owner";

// The owner clause every write and every exact read of these two tables shares.
export const OWNER_CLAUSE = "scope = ? AND project_id IS ? AND org_id IS ?";

// Tells whether a reference names something, because an empty string names nothing.
function isNamed(value) {
  return typeof value === "string" && value.trim() !== "";
}

// Refuses an owner id that is not an id, so a name passed where an id belongs never reaches SQL.
function requireOwnerId(kind, value) {
  if (isId(value)) return value;
  throw new UserError(`expected ${kind === "org" ? "an" : "a"} ${kind} id, got \`${String(value)}\`; resolve the ${kind} name at the edge`);
}

// Target of a registered project row (as the registry answers it): the project and the org whose rows it also reads.
export function projectTargetOf(project) {
  return {
    scope: "project",
    projectId: project.id,
    orgId: project.org_id ?? null,
    project: project.name,
    org: project.org ?? null,
    key: project.key ?? null,
  };
}

// Target of a registered org row.
export function orgTargetOf(org) {
  return { scope: "org", projectId: null, orgId: org.id, project: null, org: org.name, key: org.key ?? null };
}

// The target of the global project owner: rows that belong to no project.
const GLOBAL_TARGET = Object.freeze({ scope: "project", projectId: null, orgId: null, project: null, org: null, key: GLOBAL_KEY });

// The ref of a target's decision number, rendered from the target's current key.
export function targetDecisionRef(target, number) {
  return decisionRef({ scope: target.scope, project_id: target.projectId, org_key: target.key, number });
}

// Target of a project id (null for the global owner), with its org read from the registry.
export function projectScope(db, projectId) {
  if (projectId === null || projectId === undefined) return GLOBAL_TARGET;
  const project = registry.projectById(db, requireOwnerId("project", projectId));
  if (!project) throw new UserError(`unknown project id \`${projectId}\``);
  return projectTargetOf(project);
}

// Target of an org id, refusing an org the registry does not know.
function orgScope(db, orgId) {
  const org = registry.orgById(db, requireOwnerId("org", orgId));
  if (!org) throw new UserError(`unknown org id \`${orgId}\``);
  return orgTargetOf(org);
}

// Owner a call names: `projectId` (null for global) XOR `orgId`, both validated against the registry.
export function requireScopeTarget(db, { projectId, orgId } = {}) {
  if (isNamed(projectId) && isNamed(orgId)) throw new UserError(SCOPE_CONFLICT);
  if (isNamed(orgId)) return orgScope(db, orgId);
  if (projectId === null || isNamed(projectId)) return projectScope(db, projectId);
  throw new UserError(SCOPE_MISSING);
}

// Owner a reference names: a project id (null for global), or the `{ projectId }` / `{ orgId }` shape.
export function requireOwnerTarget(db, owner) {
  const spec = typeof owner === "string" || owner === null ? { projectId: owner } : (owner ?? {});
  return requireScopeTarget(db, spec);
}

// Owner a stored row belongs to, the group its numbering and its positions live in; names are the ones attached to the row.
export function rowOwner(row) {
  const org = row?.scope === "org";
  return {
    scope: org ? "org" : "project",
    projectId: org ? null : (row?.project_id ?? null),
    orgId: org ? (row?.org_id ?? null) : null,
    project: org ? null : (row?.project ?? null),
    org: org ? (row?.org ?? null) : null,
  };
}

// Read target of a stored row: an org row reads its org, a project row reads its project and that project's org.
export function rowTarget(db, row) {
  return row?.scope === "org" ? rowOwner(row) : projectScope(db, row?.project_id ?? null);
}

// The `{ projectId }` or `{ orgId }` a target is passed on with, which never carries both.
export function ownerRef(target) {
  return target.scope === "org" ? { orgId: target.orgId } : { projectId: target.projectId };
}

// The `{ project }` or `{ org }` NAME a target is shown with, which never carries both.
export function ownerNames(target) {
  return target.scope === "org" ? { org: target.org } : { project: target.project };
}

// The three values `OWNER_CLAUSE` binds: a project row never carries an org, an org row never a project.
export function ownerValues(target) {
  return target.scope === "org" ? ["org", null, target.orgId] : ["project", target.projectId, null];
}

// Owner NAME of a row, with names attached or already in view shape.
export function ownerOf(row) {
  if (row?.scope === "org") return row.org ?? row.owner ?? null;
  return row?.project ?? row?.owner ?? null;
}

// How a row names its owner in a refusal: an org row belongs to an org, a project row to a project.
export function ownerDescription(row) {
  return row?.scope === "org" ? `org \`${ownerOf(row)}\`` : `project \`${ownerOf(row) ?? "global"}\``;
}

// Rows a target sees: its own and, for a project, the rows of its org; `prefix` qualifies the columns of a join.
export function visibility(target, prefix = "") {
  const at = prefix ? `${prefix}.` : "";
  if (target.scope === "org") return { clause: `(${at}scope = 'org' AND ${at}org_id = ?)`, values: [target.orgId] };
  return {
    clause: `((${at}scope = 'project' AND (${at}project_id = ? OR ${at}project_id IS NULL)) OR (${at}scope = 'org' AND ${at}org_id = ?))`,
    values: [target.projectId, target.orgId],
  };
}

// Tells whether an owner may link a row of another owner: its own rows and, for a project, the rows of its org.
export function seesRow(target, row) {
  if (row?.scope === "org") return (row.org_id ?? null) !== null && row.org_id === target.orgId;
  return target.scope === "project" && (row?.project_id ?? null) === (target.projectId ?? null);
}

// Tells whether two rows have the same owner.
export function sameOwner(a, b) {
  const [left, right] = [rowOwner(a), rowOwner(b)];
  return left.scope === right.scope && left.projectId === right.projectId && left.orgId === right.orgId;
}

// The org rows of a list, ahead of the rest, each group in the order it arrived.
export function orgFirst(rows) {
  const list = Array.isArray(rows) ? rows : [];
  return [...list.filter((row) => row?.scope === "org"), ...list.filter((row) => row?.scope !== "org")];
}
