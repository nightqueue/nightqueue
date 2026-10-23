import { UserError } from "../config/errors.mjs";

// The version of the tool input shapes; bump it whenever a tool's input shape changes incompatibly (contract 1 is the pre-v19 integer ids, 2 the refs, 3 the tracker renamed, 4 the tracker removed, 5 the tracker_issues tool, home-scoped connections and `queue_add` `origin: false`, 6 `origin` is a list of {kind, ref}, 7 the `lesson_delete` and `memory_delete` tools, 8 the decision tools removed, 9 the `connection_call` tool, 10 the `operator_consent` tool).
export const TOOL_CONTRACT = 10;

export const STALE_CONTRACT_ADVISORY = "this client's tool contract is older than the server";

const OLD_TRACKER_WORD = ["road", "map"].join("");
const REMOVED_TRACKER_WORD = ["iss", "ue"].join("");

// Tools an older contract had and a newer one removed: only a client with cached old definitions still calls them.
const REMOVED_TOOLS = Object.freeze(["decision_save", "decision_update", "decision_list", "decision_recall"]);

// Inputs an older contract named and a newer one renamed or removed, by tool: only a client with cached old definitions still sends them.
const RENAMED_FIELDS = {
  queue_add: [`${OLD_TRACKER_WORD}_item_id`, `${REMOVED_TRACKER_WORD}_id`],
};

// The refusal line of an input removed with the operator runs.
function operatorRunLine(field) {
  return `\`${field}\` was removed with the operator runs: operator runs no longer exist, so there is no run to bind or record; put what was found in \`prompt\``;
}

export const TIER_REMOVED_LINE =
  "`tier` was removed: every job runs the one /resolve pipeline (one model per agent, QA mode chosen by `run check 03`); drop it - a client still sending it is an older nightqueue plugin, update it";

// Inputs a newer contract removed, by tool, each with its refusal line: a call that still sends one with a value is refused, never silently stripped.
const RETIRED_FIELDS = {
  queue_add: { run_dir: operatorRunLine("run_dir"), tier: TIER_REMOVED_LINE },
  run_set: {
    origin: operatorRunLine("origin"),
    evidence_level: operatorRunLine("evidence_level"),
    plan_status: operatorRunLine("plan_status"),
  },
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

// Refuses a call to a tool a newer contract removed, and notes the old definitions in the server's state.
export function refuseRemovedTool(name, state) {
  if (!REMOVED_TOOLS.includes(name)) return;
  state.sawOldShape = true;
  throw new StaleContractError();
}

// Refuses a call carrying an input its tool renamed, before validation would strip it, and notes the old shape in the server's state.
export function refuseRenamedFields(name, args, state) {
  if (args === null || typeof args !== "object") return;
  const fields = RENAMED_FIELDS[name] ?? [];
  if (!fields.some((field) => Object.hasOwn(args, field))) return;
  state.sawOldShape = true;
  throw new StaleContractError();
}

// Inputs whose older contract took another shape, by tool: each answers whether a value is in the old shape.
const OLD_SHAPES = {
  queue_add: { origin: (value) => value !== null && value !== undefined && !Array.isArray(value) },
};

// Refuses a call carrying an input in the shape of an older contract, before validation would answer a generic error, and notes it in the server's state.
export function refuseOldShapes(name, args, state) {
  if (args === null || typeof args !== "object") return;
  const shapes = Object.entries(OLD_SHAPES[name] ?? {});
  if (!shapes.some(([field, isOld]) => Object.hasOwn(args, field) && isOld(args[field]))) return;
  state.sawOldShape = true;
  throw new StaleContractError();
}

// Tells whether a retired input carries a value: null, undefined and blank text are nothing to refuse.
function hasValue(value) {
  if (value === null || value === undefined) return false;
  return typeof value !== "string" || value.trim() !== "";
}

// Refuses a call carrying a value for a retired input, before validation would strip it silently.
export function refuseRetiredFields(name, args) {
  if (args === null || typeof args !== "object") return;
  const retired = Object.entries(RETIRED_FIELDS[name] ?? {});
  const found = retired.find(([key]) => Object.hasOwn(args, key) && hasValue(args[key]));
  if (found) throw new UserError(found[1]);
}

// What one server instance remembers about the clients it served; in memory only, never in the database.
export function newContractState() {
  return { sawOldShape: false };
}

// Adds the contract number to an object answer; a list answer keeps its shape.
export function withContract(answer) {
  if (answer === null || typeof answer !== "object" || Array.isArray(answer)) return answer;
  return { ...answer, contract: TOOL_CONTRACT };
}
