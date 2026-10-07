// The issue-tracker read behind the `tracker_issues` tool: the home's tracker connection lists issues, no service is named here.
import { createHash } from "node:crypto";
import { homeConnection } from "./connections.mjs";
import { quietFiles } from "./coverage.mjs";
import { requestJson } from "./http.mjs";
import { trackerProviders } from "./registry.mjs";

export const TRACKER_STATES = Object.freeze(["open", "closed", "all"]);
export const TRACKER_LIMIT = Object.freeze({ min: 1, max: 50, fallback: 25 });

const FILTERS_TTL_MS = 300_000;
const TRACKER_TIMEOUT_MS = 15_000;
const READ_FAILED = "the tracker read failed";

const filtersCache = new Map();

// Empties the module-level filters cache; test-only.
export function resetTrackerCache() {
  filtersCache.clear();
}

// The kind with its first letter in upper case, as a sentence names the service.
function serviceLabel(kind) {
  return kind.charAt(0).toUpperCase() + kind.slice(1);
}

// The server instruction lines naming the tool for every tracker provider of this build.
export function trackerInstructionLines() {
  return trackerProviders().map(
    ({ kind }) =>
      `${serviceLabel(kind)} issues come from \`tracker_issues\`; queue from one with \`origin: {kind: "${kind}", ref}\` and the nightqueue \`project\``,
  );
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

// The tool arguments checked by type, with the defaults applied.
function trackerQuery(args) {
  const team = textOrNull(args?.team);
  const limit = Number.isInteger(args?.limit) && args.limit >= TRACKER_LIMIT.min && args.limit <= TRACKER_LIMIT.max ? args.limit : TRACKER_LIMIT.fallback;
  return {
    team: team ? team.toUpperCase() : null,
    project: textOrNull(args?.project),
    state: TRACKER_STATES.includes(args?.state) ? args.state : "open",
    limit,
  };
}

// Runs one provider read, answering its result or { detail } when it answered one or threw.
async function providerRead(read) {
  try {
    const answer = await read();
    if (answer && typeof answer === "object" && !("detail" in answer)) return answer;
    return { detail: typeof answer?.detail === "string" && answer.detail ? answer.detail : READ_FAILED };
  } catch {
    return { detail: READ_FAILED };
  }
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
  const filters = await providerRead(() => provider.tracker.filters({ connection, http }));
  if (!filters.detail) filtersCache.set(key, { at: now(), fingerprint, filters });
  return filters;
}

// Lists the issues of the home's tracker connection: { ok, provider, items, truncated, filters? } or a refusal { ok: false, error, provider, hint }.
export async function trackerIssues(args, { env, fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  const provider = trackerProviders()[0];
  if (!provider) return refusal("no-connection", null, "this build has no tracker provider");
  const connection = homeConnection(quietFiles(env).secrets, provider.kind);
  if (!connection) return refusal("no-connection", provider.kind, connectHint(provider.kind));
  const http = (url, options = {}) => requestJson(fetchImpl, url, { ...options, timeoutMs: TRACKER_TIMEOUT_MS });
  const wantsFilters = args?.include_filters === true;
  const [issues, filters] = await Promise.all([
    providerRead(() => provider.tracker.issues(trackerQuery(args), { connection, http })),
    wantsFilters ? cachedFilters({ provider, connection, http, now }) : null,
  ]);
  const failed = issues.detail ?? filters?.detail;
  if (failed) return refusal("provider-unavailable", provider.kind, failed);
  const items = Array.isArray(issues.items) ? issues.items : [];
  return { ok: true, provider: provider.kind, items, truncated: issues.truncated === true, ...(wantsFilters ? { filters } : {}) };
}
