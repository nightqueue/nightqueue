import { requestJson } from "./http.mjs";

const DEFAULT_URL = "https://sentry.io";
const CLOSE_STATUSES = Object.freeze(["resolved", "resolvedInNextRelease"]);
const ISSUE_LINK = /https:\/\/(?:[a-z0-9-]+\.)*sentry\.io\/(?:organizations\/[\w.-]+\/)?issues\/(\d+)/i;
const NAMED_SHORT_ID = /\bsentry[\s:#]+([A-Z][A-Z0-9_]*-[A-Z0-9]+)\b/i;
const SHORT_ID = /^[A-Z][A-Z0-9_]*-[A-Z0-9]+$/i;
const ORG_SLUG = /^[a-z0-9][a-z0-9_-]*$/i;
const HTTPS_ORIGIN = /^https:\/\/[a-z0-9.-]+(?::\d+)?\/?$/i;
const MAX_FRAMES = 30;
const MAX_BREADCRUMBS = 20;
const MAX_FIELD = 300;

// Reads a Sentry reference: an issue link, a short id written right after the word sentry, or (explicitly given) a bare id.
function parseSentry(text, { explicit = false } = {}) {
  const linked = ISSUE_LINK.exec(text)?.[1];
  if (linked) return linked;
  const named = NAMED_SHORT_ID.exec(text)?.[1];
  if (named) return named.toUpperCase();
  if (!explicit) return null;
  const bare = text.trim();
  if (/^\d+$/.test(bare)) return bare;
  return SHORT_ID.test(bare) ? bare.toUpperCase() : null;
}

// The API root of a connection: its url without a trailing slash, sentry.io when none is stored.
function apiRoot(record) {
  const base = typeof record?.url === "string" && record.url ? record.url.replace(/\/$/, "") : DEFAULT_URL;
  return `${base}/api/0/organizations/${encodeURIComponent(record?.org ?? "")}`;
}

// The headers every Sentry request carries.
function authHeaders(record) {
  return { Authorization: `Bearer ${record.token}`, Accept: "application/json" };
}

// Validates the auth token and org of a Sentry connection, without exposing the token in the result.
async function testSentry(record, { fetchImpl = fetch, timeoutMs = 5000 } = {}) {
  const answer = await requestJson(fetchImpl, `${apiRoot(record)}/`, { headers: authHeaders(record), timeoutMs });
  if (!answer.ok) return { ok: false, status: answer.status, org: null, detail: answer.detail };
  return { ok: true, status: answer.status, org: answer.body?.slug ?? null, detail: "ok" };
}

// Describes a successful Sentry connection test in one line.
function summarizeSentry(result) {
  return `org=${result.org ?? "(none)"}`;
}

// The numeric issue id of a reference, resolving a short id through the API; answers { id } or { detail }.
async function issueIdOf(ref, { record, http }) {
  if (/^\d+$/.test(ref)) return { id: ref };
  const answer = await http(`${apiRoot(record)}/shortids/${encodeURIComponent(ref)}/`, { headers: authHeaders(record) });
  const id = answer.ok ? String(answer.body?.groupId ?? "") : "";
  if (/^\d+$/.test(id)) return { id };
  return { detail: `short id ${ref} not resolved (${answer.ok ? "no issue id" : answer.detail})` };
}

// A value of the service as one bounded line of text.
function oneLine(value) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > MAX_FIELD ? `${text.slice(0, MAX_FIELD)}...` : text;
}

// The issue's own facts as markdown lines.
function issueLines(ref, issue) {
  return [
    `# Sentry issue ${oneLine(issue.shortId || ref)}: ${oneLine(issue.title)}`,
    "",
    `- culprit: ${oneLine(issue.culprit)}`,
    `- level: ${oneLine(issue.level)}, status: ${oneLine(issue.status)}`,
    `- events: ${oneLine(issue.count)}, users: ${oneLine(issue.userCount)}`,
    `- first seen: ${oneLine(issue.firstSeen)}, last seen: ${oneLine(issue.lastSeen)}`,
    `- link: ${oneLine(issue.permalink)}`,
  ];
}

// The data of the event entries of one type.
function entriesOf(event, type) {
  const entries = Array.isArray(event?.entries) ? event.entries : [];
  return entries.filter((entry) => entry?.type === type).map((entry) => entry.data);
}

// The exception values of an event.
function exceptionValues(event) {
  return entriesOf(event, "exception").flatMap((data) => (Array.isArray(data?.values) ? data.values : []));
}

// The stack frames of the exceptions, innermost first and in-app frames before the others.
function topFrames(exceptions) {
  const frames = exceptions.flatMap((value) => (Array.isArray(value?.stacktrace?.frames) ? value.stacktrace.frames : [])).reverse();
  const ordered = [...frames.filter((frame) => frame?.inApp === true), ...frames.filter((frame) => frame?.inApp !== true)];
  return ordered.slice(0, MAX_FRAMES);
}

// The exception, frames, breadcrumbs and tags of the latest event as markdown lines; request, user and contexts are never read.
function eventLines(event) {
  const exceptions = exceptionValues(event);
  const crumbs = entriesOf(event, "breadcrumbs").flatMap((data) => (Array.isArray(data?.values) ? data.values : []));
  const tags = Array.isArray(event?.tags) ? event.tags : [];
  return [
    "",
    "## Exception",
    ...exceptions.map((value) => `- ${oneLine(value?.type)}: ${oneLine(value?.value)}`),
    "",
    "## Frames (innermost first, in-app first)",
    ...topFrames(exceptions).map((frame) => `- ${oneLine(frame?.filename)}:${oneLine(frame?.function)}:${oneLine(frame?.lineNo)}`),
    "",
    `## Breadcrumbs (last ${MAX_BREADCRUMBS})`,
    ...crumbs.slice(-MAX_BREADCRUMBS).map((crumb) => `- ${oneLine(crumb?.category)}: ${oneLine(crumb?.message)}`),
    "",
    "## Tags",
    ...tags.map((tag) => `- ${oneLine(tag?.key)}=${oneLine(tag?.value)}`),
  ];
}

// Fetches the issue and its latest event as markdown, or answers the reason it could not.
async function enrichSentry(ref, { connection, http }) {
  const resolved = await issueIdOf(ref, { record: connection, http });
  if (!resolved.id) return { detail: resolved.detail };
  const issueUrl = `${apiRoot(connection)}/issues/${resolved.id}/`;
  const issue = await http(issueUrl, { headers: authHeaders(connection) });
  if (!issue.ok) return { detail: `issue ${resolved.id} not read (${issue.detail})` };
  const event = await http(`${issueUrl}events/latest/`, { headers: authHeaders(connection) });
  const tail = event.ok ? eventLines(event.body) : ["", `Latest event not read (${event.detail}).`];
  return `${[...issueLines(ref, issue.body ?? {}), ...tail].join("\n")}\n`;
}

// The status a close sets on the issue: the project's `onClosed` setting, `resolved` when unset or unknown.
function closeStatusOf(settings) {
  return CLOSE_STATUSES.includes(settings?.onClosed) ? settings.onClosed : "resolved";
}

// The note left on the issue once it is resolved.
function closeNote(result) {
  const sha = typeof result?.mergeSha === "string" ? result.mergeSha.slice(0, 7) : "unknown";
  return `Fixed by ${result?.prUrl ?? "the merged pull request"}, merged as ${sha}`;
}

// Resolves the issue the job came from and leaves a best-effort note naming the merge.
async function closeSentryIssue({ ref, result, settings, slot, http }) {
  if (!slot) return { status: "skipped", note: "no sentry connection in the org", notice: true };
  const resolved = await issueIdOf(ref, { record: slot, http });
  if (!resolved.id) return { status: "warning", note: resolved.detail };
  const status = closeStatusOf(settings);
  const issueUrl = `${apiRoot(slot)}/issues/${resolved.id}/`;
  const update = await http(issueUrl, { method: "PUT", headers: authHeaders(slot), body: { status } });
  if (!update.ok) return { status: "warning", note: `issue ${resolved.id} not marked ${status} (${update.detail})` };
  const comment = await http(`${issueUrl}comments/`, { method: "POST", headers: authHeaders(slot), body: { text: closeNote(result) } });
  if (!comment.ok) return { status: "warning", note: `issue ${resolved.id} marked ${status}; note not posted (${comment.detail})`, notified: true };
  return { status: "done", note: `issue ${resolved.id} marked ${status}` };
}

export const sentry = {
  kind: "sentry",
  connection: {
    cardinality: "one",
    secretFields: ["token"],
    extraFields: [
      { name: "org", required: true, check: (value) => ORG_SLUG.test(value), format: "an organization slug such as acme" },
      { name: "url", required: false, default: DEFAULT_URL, check: (value) => HTTPS_ORIGIN.test(value), format: "an https origin such as https://sentry.example.com" },
    ],
    secretLabel: "auth token",
    test: testSentry,
    summary: summarizeSentry,
  },
  capabilities: { post: false, read: true, resolve: true },
  origin: { parse: parseSentry, enrich: enrichSentry },
  settings: { onClosed: { type: "enum", values: CLOSE_STATUSES, default: "resolved" } },
  onClosed: closeSentryIssue,
};
