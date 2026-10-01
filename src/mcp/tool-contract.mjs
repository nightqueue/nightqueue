import { UserError } from "../config/errors.mjs";
import { decisionRef, itemRef } from "../memory/refs.mjs";
import { openStore } from "../store/open.mjs";
import { callerContext } from "./phase-context.mjs";

// The version of the tool input shapes; bump it whenever a tool's input shape changes incompatibly (contract 1 is the pre-v19 integer ids, 2 the refs, 3 the issue_* names).
export const TOOL_CONTRACT = 3;

const INTEGER_ID_CONTRACT = 1;

// While true an old integer id that resolves safely is accepted with a `deprecated_input` warning; remove in the next minor release (or set false to refuse it now).
export const GRACE_OLD_CONTRACT = true;

export const STALE_CONTRACT_ADVISORY = "this client's tool contract is older than the server";

// Inputs that took an internal integer id under contract 1 and take a ref now, by tool.
const OLD_ID_FIELDS = {
  queue_add: [{ field: "issue_id", kind: "item" }],
  issue_get: [{ field: "id", kind: "item" }],
  issue_comment: [{ field: "id", kind: "item" }],
  issue_save: [{ field: "decision_id", kind: "decision" }],
  issue_update: [
    { field: "id", kind: "item" },
    { field: "decision_id", kind: "decision" },
  ],
  decision_update: [
    { field: "id", kind: "decision" },
    { field: "superseded_by", kind: "decision" },
  ],
};

// The one line a client with cached older tool definitions is answered with.
export function staleContractLine() {
  return `your client has the tool definitions of an older nightqueue (contract ${TOOL_CONTRACT - 1}, this server is ${TOOL_CONTRACT}): start a new session or restart the MCP client`;
}

// The refusal that carries the stale-contract line alone, with no tool prefix.
export class StaleContractError extends UserError {
  constructor() {
    super(staleContractLine());
  }
}

// What one server instance remembers about the clients it served; in memory only, never in the database.
export function newContractState() {
  return { sawOldShape: false };
}

// Adds the contract number, and the deprecation line when there is one, to an object answer; a list answer keeps its shape.
export function withContract(answer, deprecated = []) {
  if (answer === null || typeof answer !== "object" || Array.isArray(answer)) return answer;
  return { ...answer, contract: TOOL_CONTRACT, ...(deprecated.length > 0 ? { deprecated_input: deprecated.join("; ") } : {}) };
}

// Reads an argument as trimmed text, or null.
function text(value) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

// The owner an old id must belong to: `{ projectId, orgId }`, from the project or org named, the job's project or the `cwd`; null when none is known.
async function callerOwner(args, store, env) {
  const asOwner = (project) => (project ? { projectId: project.id, orgId: project.org_id } : null);
  if (text(args.project)) return asOwner(await store.projects.byName(text(args.project)));
  if (text(args.org)) {
    const org = await store.orgs.byName(text(args.org));
    return org ? { projectId: null, orgId: org.id } : null;
  }
  const { projectId } = await callerContext(env);
  if (projectId) return asOwner(await store.projects.byId(projectId));
  return text(args.cwd) ? asOwner(await store.projects.at(text(args.cwd))) : null;
}

// Tells whether a row belongs to the owner's project or to its org.
function ownedByCaller(row, owner) {
  if (row.scope === "org") return owner.orgId !== null && row.org_id === owner.orgId;
  return owner.projectId !== null && (row.project_id ?? null) === owner.projectId;
}

// Renders a decision ref that needs no project context.
function qualifiedDecisionRef(row) {
  return row.scope !== "org" && row.project_id ? `${row.project_key}/D-${row.number}` : decisionRef(row);
}

// The ref of the row an old integer id names when the caller owns it, or null.
async function refOfOldId({ kind, id }, owner, store) {
  try {
    const row = kind === "item" ? await store.issues.getIssue(id) : await store.decisions.getDecision(id);
    if (!row || !ownedByCaller(row, owner)) return null;
    return kind === "item" ? itemRef(row) : qualifiedDecisionRef(row);
  } catch {
    return null;
  }
}

// Rewrites the old integer ids of a call to refs, or refuses with the stale-contract line; notes the old shape in the server's state.
export async function upgradeOldShapes(name, args, { env, state }) {
  const old = (OLD_ID_FIELDS[name] ?? []).filter(({ field }) => typeof args[field] === "number");
  if (old.length === 0) return { args, deprecated: [] };
  state.sawOldShape = true;
  if (!GRACE_OLD_CONTRACT) throw new StaleContractError();
  const store = openStore(env);
  const owner = await callerOwner(args, store, env);
  const upgraded = { ...args };
  const deprecated = [];
  for (const { field, kind } of old) {
    const ref = owner ? await refOfOldId({ kind, id: args[field] }, owner, store) : null;
    if (ref === null) throw new StaleContractError();
    upgraded[field] = ref;
    deprecated.push(`\`${field}\` ${args[field]} is an internal id of contract ${INTEGER_ID_CONTRACT} and resolved to ${ref}; send the ref, the id will be refused after the grace release`);
  }
  return { args: upgraded, deprecated };
}
