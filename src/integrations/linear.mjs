import { refsInTextOrder } from "./find-refs.mjs";
import { requestJson } from "./http.mjs";

const API = "https://api.linear.app/graphql";
const VIEWER_QUERY = "query { viewer { id name } }";
const ISSUE_QUERY =
  "query($id: String!) { issue(id: $id) { id identifier title description url priority priorityLabel createdAt updatedAt " +
  "state { name type } labels { nodes { name } } assignee { name } parent { identifier title } attachments { nodes { title url } } " +
  "comments(first: 20) { nodes { body createdAt user { name } } } team { key states { nodes { id name type position } } } } }";
const CLOSE_QUERY =
  "query($id: String!) { issue(id: $id) { id identifier state { name type } team { states { nodes { id name type position } } } } }";
const DESCRIBE_QUERY = "query($id: String!) { issue(id: $id) { identifier title url } }";
const UPDATE_MUTATION = "mutation($id: String!, $stateId: String!) { issueUpdate(id: $id, input: { stateId: $stateId }) { success } }";
const ATTACH_MUTATION = "mutation($issueId: String!, $url: String!, $title: String!, $subtitle: String) { attachmentCreate(input: { issueId: $issueId, url: $url, title: $title, subtitle: $subtitle }) { success } }";
const COMMENT_MUTATION ="mutation($issueId: String!, $body: String!) { commentCreate(input: { issueId: $issueId, body: $body }) { success } }";
const ISSUES_QUERY =
  "query($filter: IssueFilter, $first: Int) { issues(filter: $filter, first: $first, orderBy: updatedAt) { " +
  "nodes { identifier title url priority priorityLabel updatedAt state { name type } team { key } labels { nodes { name } } } " +
  "pageInfo { hasNextPage } } }";
const TEAMS_QUERY = "query { teams { nodes { key name projects { nodes { name } } } } }";
const ISSUE_LINK = /https:\/\/linear\.app\/[a-z0-9][a-z0-9-]*\/issue\/([A-Za-z][A-Za-z0-9]*-\d+)(?:[/?#]|\b)/i;
const NAMED = /\b[Ll]inear[\s:#]+([A-Z][A-Z0-9]*-\d+)\b/;
const BARE = /^[A-Za-z][A-Za-z0-9]*-\d+$/;
const REFUSED = "the service refused the query";
const UNCONFIRMED = "the service did not confirm";
const DONE_TYPES = ["completed", "canceled"];
const MAX_FIELD = 300;
const MAX_COMMENT = 2000;

// The headers every Linear request carries: a personal API key goes in Authorization with no scheme.
function authHeaders(record) {
  return { Authorization: record.apiKey, Accept: "application/json" };
}

// A GraphQL answer as { ok, status, data } or { ok: false, detail }; the errors Linear sends with HTTP 200 never reach the detail.
function graphqlResult(answer) {
  if (!answer.ok) return { ok: false, status: answer.status, detail: answer.detail };
  if (Array.isArray(answer.body?.errors) && answer.body.errors.length) return { ok: false, status: answer.status, detail: REFUSED };
  return { ok: true, status: answer.status, data: answer.body?.data ?? null };
}

// Sends one GraphQL operation through the given http with the connection's key.
async function gql(http, record, query, variables = {}) {
  return graphqlResult(await http(API, { method: "POST", headers: authHeaders(record), body: { query, variables } }));
}

// Validates the API key of a Linear connection by reading its viewer, without exposing the key in the result.
async function testLinear(record, { fetchImpl = fetch, timeoutMs = 5000 } = {}) {
  const http = (url, options) => requestJson(fetchImpl, url, { ...options, timeoutMs });
  const answer = await gql(http, record, VIEWER_QUERY);
  if (!answer.ok) return { ok: false, status: answer.status, viewer: null, detail: answer.detail };
  const name = answer.data?.viewer?.name;
  return { ok: true, status: answer.status, viewer: typeof name === "string" && name ? name : null, detail: "ok" };
}

// Describes a successful Linear connection test in one line.
function summarizeLinear(result) {
  return `viewer=${result.viewer ?? "(none)"}`;
}

// Reads a Linear reference: an issue link, an upper-case key written right after the word linear, or (explicitly given) a bare key.
function parseLinear(text, { explicit = false } = {}) {
  const linked = ISSUE_LINK.exec(text)?.[1];
  if (linked) return linked.toUpperCase();
  const named = NAMED.exec(text)?.[1];
  if (named) return named;
  if (!explicit) return null;
  const bare = text.trim();
  return BARE.test(bare) ? bare.toUpperCase() : null;
}

// Lists every Linear reference a text carries, in text order.
function findLinear(text) {
  return refsInTextOrder(text, [
    { pattern: ISSUE_LINK, ref: (match) => match[1].toUpperCase() },
    { pattern: NAMED, ref: (match) => match[1] },
  ]);
}

// A value of the service as one bounded line of text.
function oneLine(value) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > MAX_FIELD ? `${text.slice(0, MAX_FIELD)}...` : text;
}

// The nodes of a GraphQL connection, or none when the service answered something else.
function nodesOf(connection) {
  return Array.isArray(connection?.nodes) ? connection.nodes : [];
}

// The issue's own facts as markdown lines.
function factLines(ref, issue) {
  const parent = issue.parent ? `${oneLine(issue.parent.identifier)} ${oneLine(issue.parent.title)}` : "none";
  return [
    `# Linear issue ${oneLine(issue.identifier || ref)}: ${oneLine(issue.title)}`,
    "",
    `- state: ${oneLine(issue.state?.name)} (${oneLine(issue.state?.type)})`,
    `- team: ${oneLine(issue.team?.key)}`,
    `- priority: ${oneLine(issue.priorityLabel)}`,
    `- assignee: ${oneLine(issue.assignee?.name) || "none"}`,
    `- created: ${oneLine(issue.createdAt)}, updated: ${oneLine(issue.updatedAt)}`,
    `- url: ${oneLine(issue.url)}`,
    `- parent: ${parent}`,
  ];
}

// A comment body cut to its bound, indented under its list item.
function commentBody(body) {
  const text = String(body ?? "").trim();
  const cut = text.length > MAX_COMMENT ? `${text.slice(0, MAX_COMMENT)}...` : text;
  return cut.split("\n").map((line) => `  ${line}`);
}

// The comments of the issue, oldest first, as markdown lines.
function commentLines(comments) {
  const ordered = [...comments].sort((a, b) => String(a?.createdAt ?? "").localeCompare(String(b?.createdAt ?? "")));
  return ordered.flatMap((comment) => [`- ${oneLine(comment?.createdAt)} ${oneLine(comment?.user?.name) || "unknown"}:`, ...commentBody(comment?.body)]);
}

// The description, labels, attachments and comments of the issue as markdown lines.
function detailLines(issue) {
  const description = typeof issue.description === "string" && issue.description.trim() ? issue.description.trim() : "(none)";
  return [
    "",
    "## Description",
    description,
    "",
    "## Labels",
    ...nodesOf(issue.labels).map((label) => `- ${oneLine(label?.name)}`),
    "",
    "## Attachments",
    ...nodesOf(issue.attachments).map((attachment) => `- ${oneLine(attachment?.title)} ${oneLine(attachment?.url)}`),
    "",
    "## Comments",
    ...commentLines(nodesOf(issue.comments)),
  ];
}

// The origins the issue's attachment urls name through the runtime's link reader, deduped in attachment order, and the urls no origin recognised.
function linkedOrigins(issue, linkOrigin) {
  const seen = new Set();
  const linked = [];
  const ignored = [];
  if (typeof linkOrigin !== "function") return { linked, ignored };
  for (const attachment of nodesOf(issue.attachments)) {
    const origin = linkOrigin(attachment?.url);
    if (!origin) ignored.push(attachment?.url);
    if (!origin || seen.has(`${origin.kind} ${origin.ref}`)) continue;
    seen.add(`${origin.kind} ${origin.ref}`);
    linked.push(origin);
  }
  return { linked, ignored };
}

// Fetches the whole issue as markdown with the origins its attachments link, or answers the reason it could not.
async function enrichLinear(ref, { connection, http, linkOrigin }) {
  const answer = await gql(http, connection, ISSUE_QUERY, { id: ref });
  if (!answer.ok) return { detail: `issue ${ref} not read (${answer.detail})` };
  const issue = answer.data?.issue;
  if (!issue || typeof issue !== "object") return { detail: `issue ${ref} not found` };
  return { markdown: `${[...factLines(ref, issue), ...detailLines(issue)].join("\n")}\n`, ...linkedOrigins(issue, linkOrigin) };
}

// The identifier, url and title of an issue, or the reason they could not be read.
async function describeLinear(ref, { slot, http }) {
  if (!slot) return { detail: "no linear connection in the home" };
  const answer = await gql(http, slot, DESCRIBE_QUERY, { id: ref });
  if (!answer.ok) return { detail: `issue ${ref} not read (${answer.detail})` };
  const issue = answer.data?.issue;
  if (typeof issue?.identifier !== "string" || typeof issue?.url !== "string") return { detail: `issue ${ref} not found` };
  return { label: issue.identifier, url: issue.url, title: oneLine(issue.title) };
}

// The first state of type completed of a team, by position, or null when the team has none.
function completedState(states) {
  const completed = states.filter((state) => state?.type === "completed" && typeof state.id === "string");
  const position = (state) => (Number.isFinite(state.position) ? state.position : Number.POSITIVE_INFINITY);
  return completed.sort((a, b) => position(a) - position(b))[0] ?? null;
}

// Runs one mutation and answers { ok } or { ok: false, detail }, a missing success flag counting as a failure.
async function mutate(http, record, { query, variables, field }) {
  const answer = await gql(http, record, query, variables);
  if (!answer.ok) return answer;
  return answer.data?.[field]?.success === true ? { ok: true } : { ok: false, detail: UNCONFIRMED };
}

// The comment left on the issue once its pull request merged.
function closeComment({ job, result }) {
  return `Merged ${result?.prUrl ?? "the merged pull request"} (${job?.ref ?? "unknown job"}, nightqueue)`;
}

// The notes of the PR attachment and the comment that did not succeed.
function missedActions({ attach, comment }) {
  const missed = [];
  if (!attach.ok) missed.push(`PR not attached (${attach.detail})`);
  if (!comment.ok) missed.push(`comment not posted (${comment.detail})`);
  return missed;
}

// Whether an action needs no retry: it succeeded, or it can never succeed for this close.
function isSettled(action) {
  return action.ok === true || action.settled === true;
}

// A warning answer: notified when no action is left to retry, else carrying the progress a retry resumes from.
function warningAnswer(note, { attach, comment }) {
  if (isSettled(attach) && comment.ok) return { status: "warning", note, notified: true };
  return { status: "warning", note, progress: { attached: isSettled(attach), commented: comment.ok } };
}

// The close answer once the state move succeeded or was not possible, depending on whether the PR was attached and the comment posted.
function closeAnswer({ ref, state, attach, comment }) {
  const missed = missedActions({ attach, comment });
  const head = state ? `issue ${ref} moved to ${oneLine(state.name)}` : `issue ${ref} has no completed state`;
  if (state && !missed.length) return { status: "done", note: head };
  const posted = !state && comment.ok ? ["comment posted"] : [];
  return warningAnswer([head, ...posted, ...missed].join("; "), { attach, comment });
}

// The close answer for an issue already completed or canceled, which keeps its state and only gets the PR attached and the comment.
function alreadyClosedAnswer({ ref, current, attach, comment }) {
  const name = typeof current.name === "string" && current.name.trim() ? oneLine(current.name) : current.type;
  const missed = missedActions({ attach, comment });
  const posted = comment.ok ? ["comment posted"] : [];
  const note = [`issue ${ref} already ${name}`, ...posted, ...missed].join("; ");
  if (!missed.length) return { status: "done", note };
  return warningAnswer(note, { attach, comment });
}

// Attaches the merged pull request to the issue as a link, Linear updating an attachment of the same url instead of adding one.
function attachPullRequest({ http, slot, issue, job, result }) {
  if (typeof result?.prUrl !== "string" || !result.prUrl) return { ok: false, detail: "no pull request url", settled: true };
  const title = Number.isInteger(result.prNumber) ? `Pull request #${result.prNumber}` : "Pull request";
  const subtitle = `merged · ${job?.ref ?? "unknown job"} · nightqueue`;
  return mutate(http, slot, { query: ATTACH_MUTATION, variables: { issueId: issue.id, url: result.prUrl, title, subtitle }, field: "attachmentCreate" });
}

// Posts the comment naming the merge on the issue.
function postCloseComment({ http, slot, issue, job, result }) {
  return mutate(http, slot, { query: COMMENT_MUTATION, variables: { issueId: issue.id, body: closeComment({ job, result }) }, field: "commentCreate" });
}

// Attaches the pull request, then comments naming the merge, skipping what an earlier close already did and answering both outcomes.
async function attachAndComment(call) {
  const attach = call.progress?.attached === true ? { ok: true } : await attachPullRequest(call);
  const comment = call.progress?.commented === true ? { ok: true } : await postCloseComment(call);
  return { attach, comment };
}

// Moves the issue the job came from to its team's first completed state, unless already closed, attaches the pull request and comments naming the merge.
async function closeLinearIssue({ ref, job, result, slot, http, progress }) {
  if (!slot) return { status: "skipped", note: "no linear connection in the home", notice: true };
  const read = await gql(http, slot, CLOSE_QUERY, { id: ref });
  const issue = read.ok ? read.data?.issue : null;
  if (!read.ok || !issue || typeof issue.id !== "string") return { status: "warning", note: `issue ${ref} not read (${read.ok ? "not found" : read.detail})` };
  const current = issue.state;
  if (DONE_TYPES.includes(current?.type)) {
    return alreadyClosedAnswer({ ref, current, ...(await attachAndComment({ http, slot, issue, job, result, progress })) });
  }
  const state = completedState(nodesOf(issue.team?.states));
  if (state) {
    const moved = await mutate(http, slot, { query: UPDATE_MUTATION, variables: { id: issue.id, stateId: state.id }, field: "issueUpdate" });
    if (!moved.ok) return { status: "warning", note: `issue ${ref} not moved to ${oneLine(state.name)} (${moved.detail})` };
  }
  return closeAnswer({ ref, state, ...(await attachAndComment({ http, slot, issue, job, result, progress })) });
}

// The issues filter built from the given fields only.
function issuesFilter({ team, project, state }) {
  const filter = {};
  if (team) filter.team = { key: { eq: team } };
  if (project) filter.project = { name: { eq: project } };
  if (state === "open") filter.state = { type: { nin: DONE_TYPES } };
  if (state === "closed") filter.state = { type: { in: DONE_TYPES } };
  return filter;
}

// One issue of the list as the tracker tool answers it.
function issueItem(node) {
  return {
    ref: String(node?.identifier ?? ""),
    title: String(node?.title ?? ""),
    team: node?.team?.key ?? null,
    state: { name: node?.state?.name ?? null, type: node?.state?.type ?? null },
    priority: Number.isFinite(node?.priority) ? node.priority : 0,
    priorityLabel: node?.priorityLabel ?? null,
    labels: nodesOf(node?.labels).map((label) => String(label?.name ?? "")).filter(Boolean),
    url: node?.url ?? null,
    updatedAt: node?.updatedAt ?? null,
  };
}

// Lists the issues matching the team, project and state filters, newest update first; answers { items, truncated } or { detail }.
async function listIssues({ team, project, state = "open", limit = 25 } = {}, { connection, http }) {
  const answer = await gql(http, connection, ISSUES_QUERY, { filter: issuesFilter({ team, project, state }), first: limit });
  if (!answer.ok) return { detail: `issues not read (${answer.detail})` };
  const issues = answer.data?.issues;
  return { items: nodesOf(issues).map(issueItem).filter((item) => item.ref), truncated: issues?.pageInfo?.hasNextPage === true };
}

// Merges the projects of every team by name, each naming the team keys it belongs to.
function mergedProjects(teams) {
  const byName = new Map();
  for (const team of teams) {
    for (const project of nodesOf(team?.projects)) {
      const name = String(project?.name ?? "");
      if (!name) continue;
      const keys = byName.get(name) ?? [];
      if (!keys.includes(team.key)) keys.push(team.key);
      byName.set(name, keys);
    }
  }
  return [...byName].map(([name, keys]) => ({ name, teams: keys }));
}

// Lists the teams and projects the issue list can be filtered by; answers { teams, projects } or { detail }.
async function listFilters({ connection, http }) {
  const answer = await gql(http, connection, TEAMS_QUERY);
  if (!answer.ok) return { detail: `teams not read (${answer.detail})` };
  const teams = nodesOf(answer.data?.teams).filter((team) => typeof team?.key === "string" && team.key);
  return { teams: teams.map((team) => ({ key: team.key, name: String(team.name ?? team.key) })), projects: mergedProjects(teams) };
}

export const linear = {
  kind: "linear",
  label: "Linear",
  description: "Reads the issues jobs come from and moves them along as the jobs close, for the whole home.",
  card: { order: 2, icon: "linear" },
  connection: {
    scope: "home",
    cardinality: "one",
    secretFields: ["apiKey"],
    extraFields: [],
    secretLabel: "API key",
    test: testLinear,
    summary: summarizeLinear,
  },
  capabilities: { post: false, read: true, resolve: true },
  origin: { parse: parseLinear, find: findLinear, enrich: enrichLinear, describe: describeLinear },
  onClosed: closeLinearIssue,
  tracker: { issues: listIssues, filters: listFilters },
};
