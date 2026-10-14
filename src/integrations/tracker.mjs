// The issue tracker behind the `tracker_*` tools: the home's tracker connection lists, reads and writes issues, no service is named here.
import { createHash } from "node:crypto";
import { refuseTrackerWriteInsideJob } from "../queue/home-guard.mjs";
import { homeConnection } from "./connections.mjs";
import { quietFiles } from "./coverage.mjs";
import { requestJson } from "./http.mjs";
import { trackerProviders } from "./registry.mjs";

export const TRACKER_STATES = Object.freeze(["open", "closed", "all"]);
export const TRACKER_LIMIT = Object.freeze({ min: 1, max: 50, fallback: 25 });
export const TRACKER_BOUNDS = Object.freeze({ title: 255, body: 50_000, text: 200, label: 100 });

const FILTERS_TTL_MS = 300_000;
const TRACKER_TIMEOUT_MS = 15_000;
const READ_FAILED = "the tracker read failed";
const WRITE_FAILED = "the tracker write failed";
const MAY_HAVE_APPLIED = "; it may still have been applied - read the issue before trying again";
const KEPT_ERRORS = Object.freeze(["not-found", "invalid-input"]);
const OPERATION_VERBS = Object.freeze({ issues: "list", issue: "read", create: "create", comment: "comment on", update: "update" });
const UPDATE_FIELDS = Object.freeze(["title", "description", "priority", "state", "assignee", "labels_add", "labels_remove"]);
const PRIORITY_RULE = "priority is an integer 0..4 (0 none, 1 urgent, 2 high, 3 medium, 4 low)";

const filtersCache = new Map();

// Empties the module-level filters cache; test-only.
export function resetTrackerCache() {
  filtersCache.clear();
}

// The kind with its first letter in upper case, as a sentence names the service.
function serviceLabel(kind) {
  return kind.charAt(0).toUpperCase() + kind.slice(1);
}

// The server instruction lines naming the tools for every tracker provider of this build.
export function trackerInstructionLines() {
  return trackerProviders().flatMap(({ kind }) => [
    `${serviceLabel(kind)} issues come from \`tracker_issues\`; queue from one with \`origin: [{kind: "${kind}", ref}]\` and the nightqueue \`project\``,
    `\`tracker_read\` reads one ${serviceLabel(kind)} issue whole and \`tracker_issues\` searches by \`text\` and \`label\`; \`tracker_create\`, \`tracker_comment\` and \`tracker_update\` write to ${serviceLabel(kind)} only after the person said yes to the exact change, and are refused inside a queue job`,
  ]);
}

// A refusal answered as a normal tool answer, never as an error.
function refusal(error, provider, hint) {
  return { ok: false, error, provider, hint };
}

// The command line that stores the home's connection of a kind.
function connectHint(kind) {
  return `connect it: echo "$${kind.toUpperCase()}_API_KEY" | nightqueue connection add ${kind} --type ${kind}`;
}

// A trimmed non-empty text, or null for anything else.
function textOrNull(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

// The trimmed non-empty texts of a list, deduplicated case-insensitively in their given order.
function textList(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  return value.map(textOrNull).filter((text) => {
    if (!text || seen.has(text.toLowerCase())) return false;
    seen.add(text.toLowerCase());
    return true;
  });
}

// The tool arguments checked by type, with the defaults applied.
function trackerQuery(args) {
  const team = textOrNull(args?.team);
  const limit = Number.isInteger(args?.limit) && args.limit >= TRACKER_LIMIT.min && args.limit <= TRACKER_LIMIT.max ? args.limit : TRACKER_LIMIT.fallback;
  return {
    team: team ? team.toUpperCase() : null,
    project: textOrNull(args?.project),
    state: TRACKER_STATES.includes(args?.state) ? args.state : "open",
    text: textOrNull(args?.text),
    label: textOrNull(args?.label),
    limit,
  };
}

// Runs one provider call, answering its result or { detail, error, uncertain } when it answered a failure or threw; a thrown message is never kept.
async function providerCall(call, failure) {
  try {
    const answer = await call();
    if (answer && typeof answer === "object" && !("detail" in answer)) return answer;
    return {
      detail: typeof answer?.detail === "string" && answer.detail ? answer.detail : failure,
      error: KEPT_ERRORS.includes(answer?.error) ? answer.error : null,
      uncertain: answer?.uncertain === true,
    };
  } catch {
    return { detail: failure, error: null, uncertain: failure === WRITE_FAILED };
  }
}

// The refusal a failed provider call answers, warning when a write may still have landed.
function failureRefusal(kind, failed) {
  const hint = failed.uncertain ? `${failed.detail}${MAY_HAVE_APPLIED}` : failed.detail;
  return refusal(failed.error ?? "provider-unavailable", kind, hint);
}

// The provider, connection and http an operation runs with, or the refusal when the home or the build cannot run it.
function trackerTarget({ env, fetchImpl = globalThis.fetch } = {}, op) {
  const provider = trackerProviders()[0];
  if (!provider) return { refused: refusal("no-connection", null, "this build has no tracker provider") };
  const connection = homeConnection(quietFiles(env).secrets, provider.kind);
  if (!connection) return { refused: refusal("no-connection", provider.kind, connectHint(provider.kind)) };
  if (typeof provider.tracker[op] !== "function") {
    return { refused: refusal("unsupported", provider.kind, `${provider.label ?? serviceLabel(provider.kind)} cannot ${OPERATION_VERBS[op]} issues`) };
  }
  const http = (url, options = {}) => requestJson(fetchImpl, url, { ...options, timeoutMs: TRACKER_TIMEOUT_MS });
  return { provider, connection, http };
}

// A short one-way digest of the connection's declared secret fields, so a replaced key misses the cache without the key being kept.
function secretFingerprint(provider, connection) {
  const fields = Array.isArray(provider.connection?.secretFields) ? provider.connection.secretFields : [];
  const material = fields.map((field) => String(connection?.[field] ?? "")).join("\0");
  return createHash("sha256").update(material).digest("hex").slice(0, 16);
}

// The team and project filters of a connection, from the cache while fresh and read with the same key, else read and stored.
async function cachedFilters({ provider, connection, http, now }) {
  const key = `${provider.kind}:${connection.name}`;
  const fingerprint = secretFingerprint(provider, connection);
  const cached = filtersCache.get(key);
  if (cached && cached.fingerprint === fingerprint && now() - cached.at < FILTERS_TTL_MS) return cached.filters;
  const filters = await providerCall(() => provider.tracker.filters({ connection, http }), READ_FAILED);
  if (!filters.detail) filtersCache.set(key, { at: now(), fingerprint, filters });
  return filters;
}

// Lists the issues of the home's tracker connection: { ok, provider, items, truncated, filters? } or a refusal { ok: false, error, provider, hint }.
export async function trackerIssues(args, { env, fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  const target = trackerTarget({ env, fetchImpl }, "issues");
  if (target.refused) return target.refused;
  const { provider, connection, http } = target;
  const wantsFilters = args?.include_filters === true;
  const [issues, filters] = await Promise.all([
    providerCall(() => provider.tracker.issues(trackerQuery(args), { connection, http }), READ_FAILED),
    wantsFilters ? cachedFilters({ provider, connection, http, now }) : null,
  ]);
  const failed = issues.detail ?? filters?.detail;
  if (failed) return refusal("provider-unavailable", provider.kind, failed);
  const items = Array.isArray(issues.items) ? issues.items : [];
  return { ok: true, provider: provider.kind, items, truncated: issues.truncated === true, ...(wantsFilters ? { filters } : {}) };
}

// The issue reference the provider reads from a text, or null.
function issueRef(provider, value) {
  const text = textOrNull(value);
  return text ? provider.origin?.parse?.(text, { explicit: true }) ?? null : null;
}

// The refusal of a reference the provider does not read as an issue.
function badRef(kind, value) {
  return refusal("invalid-input", kind, `not an issue reference: "${String(value ?? "").slice(0, 100)}"`);
}

// The problem of a text longer than its bound, or null.
function lengthProblem(name, value, max) {
  return typeof value === "string" && value.length > max ? `${name} is longer than ${max} characters` : null;
}

// The problem of a priority outside 0..4, or null when it is absent or valid.
function priorityProblem(priority) {
  if (priority === null || priority === undefined) return null;
  return Number.isInteger(priority) && priority >= 0 && priority <= 4 ? null : PRIORITY_RULE;
}

// The first problem of the title, description and priority of a write, or null.
function fieldProblem(fields) {
  return lengthProblem("title", fields.title, TRACKER_BOUNDS.title) ?? lengthProblem("description", fields.description, TRACKER_BOUNDS.body) ?? priorityProblem(fields.priority);
}

// Reads one issue whole: { ok, provider, issue } or a refusal; allowed inside a queue job.
export async function trackerRead(args, deps = {}) {
  const target = trackerTarget(deps, "issue");
  if (target.refused) return target.refused;
  const { provider, connection, http } = target;
  const ref = issueRef(provider, args?.ref);
  if (!ref) return badRef(provider.kind, args?.ref);
  const answer = await providerCall(() => provider.tracker.issue(ref, { connection, http }), READ_FAILED);
  if (answer.detail) return failureRefusal(provider.kind, answer);
  return { ok: true, provider: provider.kind, issue: answer.issue };
}

// The fields of a create, trimmed, with blanks counted as absent.
function createFields(args) {
  const team = textOrNull(args?.team);
  return {
    team: team ? team.toUpperCase() : null,
    title: textOrNull(args?.title),
    description: textOrNull(args?.description),
    priority: args?.priority ?? null,
    state: textOrNull(args?.state),
    labels: textList(args?.labels),
    assignee: textOrNull(args?.assignee),
  };
}

// The problem of a create's fields, or null.
function createProblem(fields) {
  if (!fields.team) return "team is required";
  if (!fields.title) return "title is required";
  if (fields.assignee?.toLowerCase() === "none") return "assignee none only applies to `tracker_update`; leave it out to create unassigned";
  return fieldProblem(fields);
}

// Creates an issue after the person's explicit ok: { ok, provider, issue } or a refusal; refused inside a queue job before anything is sent.
export async function trackerCreate(args, deps = {}) {
  refuseTrackerWriteInsideJob(deps.env, "`tracker_create`");
  const target = trackerTarget(deps, "create");
  if (target.refused) return target.refused;
  const { provider, connection, http } = target;
  const fields = createFields(args);
  const problem = createProblem(fields);
  if (problem) return refusal("invalid-input", provider.kind, problem);
  const answer = await providerCall(() => provider.tracker.create(fields, { connection, http }), WRITE_FAILED);
  if (answer.detail) return failureRefusal(provider.kind, answer);
  return { ok: true, provider: provider.kind, issue: answer.issue };
}

// Comments on an issue after the person's explicit ok: { ok, provider, ref, comment } or a refusal; refused inside a queue job before anything is sent.
export async function trackerComment(args, deps = {}) {
  refuseTrackerWriteInsideJob(deps.env, "`tracker_comment`");
  const target = trackerTarget(deps, "comment");
  if (target.refused) return target.refused;
  const { provider, connection, http } = target;
  const ref = issueRef(provider, args?.ref);
  if (!ref) return badRef(provider.kind, args?.ref);
  const body = textOrNull(args?.body);
  const problem = body ? lengthProblem("body", body, TRACKER_BOUNDS.body) : "body is required";
  if (problem) return refusal("invalid-input", provider.kind, problem);
  const answer = await providerCall(() => provider.tracker.comment({ ref, body }, { connection, http }), WRITE_FAILED);
  if (answer.detail) return failureRefusal(provider.kind, answer);
  return { ok: true, provider: provider.kind, ref: answer.ref, comment: answer.comment };
}

// The fields of an update, trimmed, with blanks counted as absent.
function updateFields(ref, args) {
  return {
    ref,
    title: textOrNull(args?.title),
    description: textOrNull(args?.description),
    priority: args?.priority ?? null,
    state: textOrNull(args?.state),
    assignee: textOrNull(args?.assignee),
    labels_add: textList(args?.labels_add),
    labels_remove: textList(args?.labels_remove),
  };
}

// The names of the fields an update changes.
function changedFields(fields) {
  return UPDATE_FIELDS.filter((name) => (Array.isArray(fields[name]) ? fields[name].length > 0 : fields[name] !== null));
}

// The problem of an update's fields, or null.
function updateProblem(fields) {
  if (!changedFields(fields).length) return `nothing to change: give at least one of ${UPDATE_FIELDS.join(", ")}`;
  const removed = new Set(fields.labels_remove.map((name) => name.toLowerCase()));
  const both = fields.labels_add.find((name) => removed.has(name.toLowerCase()));
  if (both) return `label "${both}" is both added and removed`;
  return fieldProblem(fields);
}

// Edits an issue after the person's explicit ok: { ok, provider, issue, changed } or a refusal; refused inside a queue job before anything is sent.
export async function trackerUpdate(args, deps = {}) {
  refuseTrackerWriteInsideJob(deps.env, "`tracker_update`");
  const target = trackerTarget(deps, "update");
  if (target.refused) return target.refused;
  const { provider, connection, http } = target;
  const ref = issueRef(provider, args?.ref);
  if (!ref) return badRef(provider.kind, args?.ref);
  const fields = updateFields(ref, args);
  const problem = updateProblem(fields);
  if (problem) return refusal("invalid-input", provider.kind, problem);
  const answer = await providerCall(() => provider.tracker.update(fields, { connection, http }), WRITE_FAILED);
  if (answer.detail) return failureRefusal(provider.kind, answer);
  return { ok: true, provider: provider.kind, issue: answer.issue, changed: changedFields(fields) };
}
