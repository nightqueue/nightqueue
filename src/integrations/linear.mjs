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
  "nodes { identifier title url priority priorityLabel updatedAt state { name type } team { key } project { name } labels { nodes { name color } } } " +
  "pageInfo { hasNextPage } } }";
const TEAMS_QUERY = "query { teams { nodes { key name projects { nodes { name } } } } }";
const READ_QUERY =
  "query($id: String!) { issue(id: $id) { identifier title description url priority priorityLabel createdAt updatedAt " +
  "state { name type } team { key name } project { name } assignee { name } labels { nodes { name } } parent { identifier title } " +
  "attachments { nodes { title url } } comments(first: 50, orderBy: createdAt) { nodes { body createdAt user { name } } pageInfo { hasNextPage } } } }";
const EDIT_CONTEXT_QUERY = "query($id: String!) { issue(id: $id) { id identifier team { key states { nodes { id name type position } } } } }";
const TEAM_QUERY = "query($key: String!) { teams(first: 2, filter: { key: { eq: $key } }) { nodes { id key states { nodes { id name type position } } } } }";
const LABELS_QUERY =
  "query($key: String!) { issueLabels(first: 250, filter: { or: [{ team: { key: { eq: $key } } }, { team: { null: true } }] }) { nodes { id name isGroup } } }";
const USERS_QUERY =
  "query($who: String!) { users(first: 5, filter: { or: [{ name: { eqIgnoreCase: $who } }, { displayName: { eqIgnoreCase: $who } }, { email: { eqIgnoreCase: $who } }] }) { nodes { id name } } }";
const CREATE_MUTATION = "mutation($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { identifier title url } } }";
const EDIT_MUTATION =
  "mutation($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success issue { identifier title url priority priorityLabel " +
  "state { name type } assignee { name } labels { nodes { name } } } } }";
const NOTE_MUTATION = "mutation($issueId: String!, $body: String!) { commentCreate(input: { issueId: $issueId, body: $body }) { success comment { url } } }";
const ISSUE_LINK = /https:\/\/linear\.app\/[a-z0-9][a-z0-9-]*\/issue\/([A-Za-z][A-Za-z0-9]*-\d+)(?:[/?#]|\b)/i;
const NAMED = /\b[Ll]inear[\s:#]+([A-Z][A-Z0-9]*-\d+)\b/;
const BARE = /^[A-Za-z][A-Za-z0-9]*-\d+$/;
const REFUSED = "the service refused the query";
const UNCONFIRMED = "the service did not confirm";
const NOT_FOUND_CODE = /not[\s_-]?found/i;
const NOT_FOUND_MESSAGE = /^entity not found\b|^could not find referenced\b/i;
const DONE_TYPES = ["completed", "canceled"];
const MAX_FIELD = 300;
const MAX_COMMENT = 2000;
const MAX_DESCRIPTION = 50_000;
const MAX_READ_COMMENT = 10_000;

// The headers every Linear request carries: a personal API key goes in Authorization with no scheme.
function authHeaders(record) {
  return { Authorization: record.apiKey, Accept: "application/json" };
}

// Whether one GraphQL error names an entity the service does not know.
function isNotFoundError(error) {
  const code = `${error?.extensions?.code ?? ""} ${error?.extensions?.type ?? ""}`;
  const messages = [error?.message, error?.extensions?.userPresentableMessage].filter((text) => typeof text === "string");
  return NOT_FOUND_CODE.test(code) || messages.some((text) => NOT_FOUND_MESSAGE.test(text.trim()));
}

// A GraphQL answer as { ok, status, data } or { ok: false, detail, missing, answered }; the errors Linear sends with HTTP 200 never reach the detail.
function graphqlResult(answer) {
  if (!answer.ok) return { ok: false, status: answer.status, detail: answer.detail, missing: false, answered: false };
  const errors = answer.body?.errors;
  if (Array.isArray(errors) && errors.length) return { ok: false, status: answer.status, detail: REFUSED, missing: errors.every(isNotFoundError), answered: true };
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

// The comments of an issue sorted oldest first.
function oldestFirst(comments) {
  return [...comments].sort((a, b) => String(a?.createdAt ?? "").localeCompare(String(b?.createdAt ?? "")));
}

// The comments of the issue, oldest first, as markdown lines.
function commentLines(comments) {
  return oldestFirst(comments).flatMap((comment) => [`- ${oneLine(comment?.createdAt)} ${oneLine(comment?.user?.name) || "unknown"}:`, ...commentBody(comment?.body)]);
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

// Whether the close resolved the job without a code change, with no pull request to name or attach.
function isNoChange(result) {
  return result?.resolution === "no-change";
}

// The comment left on the issue of a job resolved without a code change: the fact, then the run's conclusion.
function noChangeComment({ job, result }) {
  const head = `Resolved without a code change (${job?.ref ?? "unknown job"}, nightqueue).`;
  return result?.conclusion ? `${head}\n\n${result.conclusion}` : head;
}

// The comment left on the issue once its pull request merged, or once the job was resolved without change.
function closeComment({ job, result }) {
  if (isNoChange(result)) return noChangeComment({ job, result });
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

// Attaches the pull request (nothing to attach when resolved without change), then comments, skipping what an earlier close already did and answering both outcomes.
async function attachAndComment(call) {
  const nothingToAttach = call.progress?.attached === true || isNoChange(call.result);
  const attach = nothingToAttach ? { ok: true } : await attachPullRequest(call);
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

// The team key (null for a bare number) and number a search text names as an issue id, null when it is not one.
function issueIdIn(text) {
  const match = /^(?:([a-z][a-z0-9]*?)[-\s]?)?(\d+)$/i.exec(String(text ?? "").trim());
  return match ? { key: match[1] ? match[1].toUpperCase() : null, number: Number(match[2]) } : null;
}

// The issues filter built from the given fields only.
function issuesFilter({ team, project, state, text, label }) {
  const filter = {};
  const id = issueIdIn(text);
  if (team) filter.team = { key: { eq: team } };
  if (id?.key) filter.team = { key: { eq: id.key } };
  if (project) filter.project = { name: { eq: project } };
  if (state === "open") filter.state = { type: { nin: DONE_TYPES } };
  if (state === "closed") filter.state = { type: { in: DONE_TYPES } };
  if (id) filter.number = { eq: id.number };
  else if (text) filter.or = [{ title: { containsIgnoreCase: text } }, { description: { containsIgnoreCase: text } }];
  if (label) filter.labels = { some: { name: { eqIgnoreCase: label } } };
  return filter;
}

// The state of an issue as a name and a type, null when unread.
function stateOf(node) {
  return { name: node?.state?.name ?? null, type: node?.state?.type ?? null };
}

// The label names of an issue.
function labelNames(node) {
  return nodesOf(node?.labels).map((label) => String(label?.name ?? "")).filter(Boolean);
}

// The labels of an issue as { name, color }, color null when the service sent none.
function labelDetails(node) {
  return nodesOf(node?.labels)
    .filter((label) => String(label?.name ?? ""))
    .map((label) => ({ name: String(label.name), color: typeof label.color === "string" && label.color ? label.color : null }));
}

// One issue of the list as the tracker tool answers it.
function issueItem(node) {
  return {
    ref: String(node?.identifier ?? ""),
    title: String(node?.title ?? ""),
    team: node?.team?.key ?? null,
    project: node?.project?.name ?? null,
    state: stateOf(node),
    priority: Number.isFinite(node?.priority) ? node.priority : 0,
    priorityLabel: node?.priorityLabel ?? null,
    labels: labelNames(node),
    labelDetails: labelDetails(node),
    url: node?.url ?? null,
    updatedAt: node?.updatedAt ?? null,
  };
}

// Lists the issues matching the team, project, state, text and label filters, newest update first; answers { items, truncated } or { detail }.
async function listIssues({ team, project, state = "open", text, label, limit = 25 } = {}, { connection, http }) {
  const answer = await gql(http, connection, ISSUES_QUERY, { filter: issuesFilter({ team, project, state, text, label }), first: limit });
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

// The answer for an issue the service does not know.
function notFound(ref) {
  return { error: "not-found", detail: `issue ${ref} not found` };
}

// The answer for an input the service cannot act on, nothing being sent.
function invalidInput(detail) {
  return { error: "invalid-input", detail };
}

// A text cut to its bound, flagged when it was cut; null when it is not a text.
function boundedText(value, max) {
  if (typeof value !== "string") return { text: null, cut: false };
  return { text: value.length > max ? value.slice(0, max) : value, cut: value.length > max };
}

// One comment of a read issue, its body cut to its bound.
function readComment(comment) {
  return { author: oneLine(comment?.user?.name) || null, createdAt: comment?.createdAt ?? null, body: boundedText(comment?.body, MAX_READ_COMMENT).text ?? "" };
}

// The whole issue as the tracker read answers it, every field present even when empty.
function readItem(issue) {
  const description = boundedText(issue.description, MAX_DESCRIPTION);
  return {
    ref: String(issue.identifier ?? ""),
    title: String(issue.title ?? ""),
    url: issue.url ?? null,
    team: { key: issue.team?.key ?? null, name: issue.team?.name ?? null },
    project: issue.project?.name ?? null,
    state: stateOf(issue),
    priority: Number.isFinite(issue.priority) ? issue.priority : 0,
    priorityLabel: issue.priorityLabel ?? null,
    assignee: issue.assignee?.name ?? null,
    labels: labelNames(issue),
    parent: issue.parent ? { ref: issue.parent.identifier ?? null, title: issue.parent.title ?? null } : null,
    description: description.text,
    description_truncated: description.cut,
    attachments: nodesOf(issue.attachments).map((attachment) => ({ title: attachment?.title ?? null, url: attachment?.url ?? null })),
    comments: oldestFirst(nodesOf(issue.comments)).map(readComment),
    comments_truncated: issue.comments?.pageInfo?.hasNextPage === true,
    createdAt: issue.createdAt ?? null,
    updatedAt: issue.updatedAt ?? null,
  };
}

// Reads one issue whole for the tracker; answers { issue } or { error?, detail }.
async function readIssue(ref, { connection, http }) {
  const answer = await gql(http, connection, READ_QUERY, { id: ref });
  if (!answer.ok && answer.missing) return notFound(ref);
  if (!answer.ok) return { detail: `issue ${ref} not read (${answer.detail})` };
  const issue = answer.data?.issue;
  if (!issue || typeof issue !== "object") return notFound(ref);
  return { issue: readItem(issue) };
}

// Runs one write and answers { data } or { detail, uncertain }, uncertain when the write may have landed without a confirmation.
async function mutateData(http, record, { query, variables, field }) {
  const answer = await gql(http, record, query, variables);
  if (!answer.ok) return { detail: answer.detail, uncertain: answer.answered || answer.status === null || answer.status >= 500 };
  const payload = answer.data?.[field];
  return payload?.success === true ? { data: payload } : { detail: UNCONFIRMED, uncertain: true };
}

// The issue's id, identifier and team states a write acts on, or the reason they could not be read.
async function editContext(http, connection, ref) {
  const answer = await gql(http, connection, EDIT_CONTEXT_QUERY, { id: ref });
  if (!answer.ok && answer.missing) return notFound(ref);
  if (!answer.ok) return { detail: `issue ${ref} not read (${answer.detail})` };
  const issue = answer.data?.issue;
  return typeof issue?.id === "string" ? { value: issue } : notFound(ref);
}

// The team of a key with its states, or the reason it could not be read.
async function readTeam(http, connection, key) {
  const answer = await gql(http, connection, TEAM_QUERY, { key });
  if (!answer.ok) return { detail: `team ${key} not read (${answer.detail})` };
  const team = nodesOf(answer.data?.teams).find((node) => node?.key === key && typeof node.id === "string");
  return team ? { value: team } : invalidInput(`unknown team "${oneLine(key)}"`);
}

// The one item a name matches case-insensitively, or the refusal naming the known ones.
function pickByName(items, name, what) {
  const wanted = name.trim().toLowerCase();
  const matches = items.filter((item) => String(item?.name ?? "").trim().toLowerCase() === wanted);
  if (matches.length === 1) return { value: matches[0] };
  if (matches.length > 1) return invalidInput(`${what} "${oneLine(name)}" names ${matches.length} items`);
  const known = oneLine(items.map((item) => item?.name).filter(Boolean).join(", "));
  return invalidInput(`unknown ${what} "${oneLine(name)}" (known: ${known || "none"})`);
}

// The id of the team state a name matches, or the refusal.
function stateId(states, name) {
  const picked = pickByName(states.filter((state) => typeof state?.id === "string"), name, "state");
  return picked.detail ? picked : { value: picked.value.id };
}

// The ids of the labels the names match, by lower-case name, among the team's and the workspace's labels; a group label is refused.
async function labelIds({ http, connection, teamKey, names }) {
  const answer = await gql(http, connection, LABELS_QUERY, { key: teamKey });
  if (!answer.ok) return { detail: `labels not read (${answer.detail})` };
  const labels = nodesOf(answer.data?.issueLabels).filter((label) => typeof label?.id === "string");
  const ids = new Map();
  for (const name of names) {
    const picked = pickByName(labels, name, "label");
    if (picked.detail) return picked;
    if (picked.value.isGroup === true) return invalidInput(`label "${oneLine(name)}" is a group`);
    ids.set(name.toLowerCase(), picked.value.id);
  }
  return { value: ids };
}

// The id of the one person a name, display name or email names, or the refusal.
async function userId(http, connection, who) {
  const answer = await gql(http, connection, USERS_QUERY, { who });
  if (!answer.ok) return { detail: `people not read (${answer.detail})` };
  const users = nodesOf(answer.data?.users).filter((user) => typeof user?.id === "string");
  if (users.length === 1) return { value: users[0].id };
  if (users.length > 1) return invalidInput(`assignee "${oneLine(who)}" names ${users.length} people (${oneLine(users.map((user) => user.name).join(", "))})`);
  return invalidInput(`unknown assignee "${oneLine(who)}" (a name, display name, email, me or none)`);
}

// The assignee id of `me`, `none` (null) or a person, or the refusal.
async function assigneeId(http, connection, who) {
  const wanted = who.trim().toLowerCase();
  if (wanted === "none") return { value: null };
  if (wanted !== "me") return userId(http, connection, who);
  const answer = await gql(http, connection, VIEWER_QUERY);
  if (!answer.ok) return { detail: `viewer not read (${answer.detail})` };
  const id = answer.data?.viewer?.id;
  return typeof id === "string" ? { value: id } : { detail: "viewer not read (no id)" };
}

// Resolves the state, assignee and label names of a write into ids, before anything is sent.
async function resolveIds({ http, connection, team, fields }) {
  const ids = {};
  if (fields.state) {
    const state = stateId(nodesOf(team?.states), fields.state);
    if (state.detail) return state;
    ids.stateId = state.value;
  }
  if (fields.assignee) {
    const assignee = await assigneeId(http, connection, fields.assignee);
    if (assignee.detail) return assignee;
    ids.assigneeId = assignee.value;
  }
  const names = [...(fields.labels ?? []), ...(fields.labels_add ?? []), ...(fields.labels_remove ?? [])];
  if (!names.length) return { value: ids };
  const labels = await labelIds({ http, connection, teamKey: team?.key, names });
  if (labels.detail) return labels;
  return { value: { ...ids, labels: labels.value } };
}

// The given fields of a write with their resolved ids, nothing absent being sent.
function writeInput(fields, ids) {
  const input = {};
  const idsOf = (names) => names.map((name) => ids.labels.get(name.toLowerCase()));
  for (const field of ["title", "description", "priority"]) if (fields[field] != null) input[field] = fields[field];
  if ("stateId" in ids) input.stateId = ids.stateId;
  if ("assigneeId" in ids) input.assigneeId = ids.assigneeId;
  if (fields.labels?.length) input.labelIds = idsOf(fields.labels);
  if (fields.labels_add?.length) input.addedLabelIds = idsOf(fields.labels_add);
  if (fields.labels_remove?.length) input.removedLabelIds = idsOf(fields.labels_remove);
  return input;
}

// Creates an issue in a team with the given fields; answers { issue } or { error?, detail, uncertain? }.
async function createIssue(fields, { connection, http }) {
  const team = await readTeam(http, connection, fields.team);
  if (team.detail) return team;
  const ids = await resolveIds({ http, connection, team: team.value, fields });
  if (ids.detail) return ids;
  const input = { teamId: team.value.id, ...writeInput(fields, ids.value) };
  const sent = await mutateData(http, connection, { query: CREATE_MUTATION, variables: { input }, field: "issueCreate" });
  if (sent.detail) return { ...sent, detail: `issue not created in ${fields.team} (${sent.detail})` };
  const issue = sent.data.issue;
  return { issue: { ref: String(issue?.identifier ?? ""), title: String(issue?.title ?? ""), url: issue?.url ?? null } };
}

// Posts a comment on an issue; answers { ref, comment } or { error?, detail, uncertain? }.
async function commentIssue({ ref, body }, { connection, http }) {
  const context = await editContext(http, connection, ref);
  if (context.detail) return context;
  const sent = await mutateData(http, connection, { query: NOTE_MUTATION, variables: { issueId: context.value.id, body }, field: "commentCreate" });
  if (sent.detail) return { ...sent, detail: `comment not posted on ${ref} (${sent.detail})` };
  return { ref: String(context.value.identifier ?? ref), comment: { url: sent.data.comment?.url ?? null } };
}

// Changes the given fields of an issue; answers { issue } as the service holds it after the edit, or { error?, detail, uncertain? }.
async function updateIssue(fields, { connection, http }) {
  const context = await editContext(http, connection, fields.ref);
  if (context.detail) return context;
  const ids = await resolveIds({ http, connection, team: context.value.team, fields });
  if (ids.detail) return ids;
  const variables = { id: context.value.id, input: writeInput(fields, ids.value) };
  const sent = await mutateData(http, connection, { query: EDIT_MUTATION, variables, field: "issueUpdate" });
  if (sent.detail) return { ...sent, detail: `issue ${fields.ref} not updated (${sent.detail})` };
  const issue = sent.data.issue;
  return {
    issue: {
      ref: String(issue?.identifier ?? fields.ref),
      title: String(issue?.title ?? ""),
      url: issue?.url ?? null,
      state: stateOf(issue),
      priority: Number.isFinite(issue?.priority) ? issue.priority : 0,
      priorityLabel: issue?.priorityLabel ?? null,
      assignee: issue?.assignee?.name ?? null,
      labels: labelNames(issue),
    },
  };
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
  tracker: { issues: listIssues, filters: listFilters, issue: readIssue, create: createIssue, comment: commentIssue, update: updateIssue },
};
