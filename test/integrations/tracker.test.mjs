import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { loadSecrets, saveSecrets } from "../../src/config/store.mjs";
import { withProviders } from "../../src/integrations/registry.mjs";
import { github } from "../../src/integrations/github.mjs";
import { linear } from "../../src/integrations/linear.mjs";
import {
  resetTrackerCache,
  trackerComment,
  trackerCreate,
  trackerInstructionLines,
  trackerIssues,
  trackerRead,
  trackerUpdate,
} from "../../src/integrations/tracker.mjs";
import { makeHome } from "../../test-support/memory.mjs";

const API_KEY = "lin_api_secret_0123456789";
const SECRET_MESSAGE = "secret-ish TOKEN lin_api_x";
const ISSUE_NODE = {
  identifier: "MK-42",
  title: "Fix the login",
  url: "https://linear.app/acme/issue/MK-42/fix-the-login",
  priority: 2,
  priorityLabel: "High",
  updatedAt: "2026-10-02T10:00:00.000Z",
  state: { name: "Todo", type: "unstarted" },
  team: { key: "MK" },
  labels: { nodes: [{ name: "bug" }] },
};
const TEAMS = { nodes: [{ key: "MK", name: "Mobile", projects: { nodes: [{ name: "Auth" }] } }] };

beforeEach(() => resetTrackerCache());

// A fake fetch answering the issues and teams queries, recording each operation it served.
function fakeFetch({ issues = { data: { issues: { nodes: [ISSUE_NODE], pageInfo: { hasNextPage: true } } } }, teams = { data: { teams: TEAMS } }, status = 200 } = {}) {
  const calls = [];
  const impl = async (url, options) => {
    const body = JSON.parse(options.body);
    const operation = body.query.includes("issues(") ? "issues" : "teams";
    calls.push({ operation, variables: body.variables });
    return { status, headers: new Map(), json: async () => (operation === "issues" ? issues : teams) };
  };
  return { impl, calls };
}

// A home holding the home-wide linear connection, or none.
function trackerHome(t, name, { connected = true } = {}) {
  const env = makeHome(t, name);
  if (connected) {
    const secrets = loadSecrets(env, { warn: () => {} });
    secrets.connections.linear = { type: "linear", apiKey: API_KEY };
    saveSecrets(secrets, env);
  }
  return env;
}

test("the server instruction line is derived from the tracker providers of the build", () => {
  assert.deepEqual(trackerInstructionLines(), [
    'Linear issues come from `tracker_issues`; queue from one with `origin: [{kind: "linear", ref}]` and the nightqueue `project`',
    "`tracker_read` reads one Linear issue whole and `tracker_issues` searches by `text` and `label`; `tracker_create`, `tracker_comment` and `tracker_update` write to Linear only after the person said yes to the exact change, and are refused inside a queue job",
  ]);
});

test("a home with no tracker connection answers no-connection with the command that adds it", async (t) => {
  const env = trackerHome(t, "tracker-none", { connected: false });
  const fetch = fakeFetch();
  const answer = await trackerIssues({}, { env, fetchImpl: fetch.impl });
  assert.deepEqual(answer, {
    ok: false,
    error: "no-connection",
    provider: "linear",
    hint: 'connect it: echo "$LINEAR_API_KEY" | nightqueue connection add linear --type linear',
  });
  assert.equal(fetch.calls.length, 0);
});

test("a build with no tracker provider answers no-connection naming none", async (t) => {
  const env = trackerHome(t, "tracker-no-provider");
  const answer = await withProviders([github], () => trackerIssues({}, { env, fetchImpl: fakeFetch().impl }));
  assert.deepEqual(answer, { ok: false, error: "no-connection", provider: null, hint: "this build has no tracker provider" });
});

test("issues come back with their filters, the team upper-cased and the defaults applied", async (t) => {
  const env = trackerHome(t, "tracker-ok");
  const fetch = fakeFetch();
  const answer = await trackerIssues({ team: " mk ", project: "Auth", include_filters: true }, { env, fetchImpl: fetch.impl });
  assert.equal(answer.ok, true);
  assert.equal(answer.provider, "linear");
  assert.equal(answer.truncated, true);
  assert.deepEqual(answer.items.map((item) => item.ref), ["MK-42"]);
  assert.deepEqual(answer.filters, { teams: [{ key: "MK", name: "Mobile" }], projects: [{ name: "Auth", teams: ["MK"] }] });
  const issuesCall = fetch.calls.find((call) => call.operation === "issues");
  assert.equal(issuesCall.variables.first, 25);
  assert.deepEqual(issuesCall.variables.filter.team, { key: { eq: "MK" } });
  assert.deepEqual(issuesCall.variables.filter.project, { name: { eq: "Auth" } });
  assert.deepEqual(issuesCall.variables.filter.state, { type: { nin: ["completed", "canceled"] } });
});

test("without include_filters no teams query runs and no filters key is answered", async (t) => {
  const env = trackerHome(t, "tracker-no-filters");
  const fetch = fakeFetch();
  const answer = await trackerIssues({ state: "all", limit: 50 }, { env, fetchImpl: fetch.impl });
  assert.equal("filters" in answer, false);
  assert.deepEqual(fetch.calls.map((call) => call.operation), ["issues"]);
  assert.equal(fetch.calls[0].variables.first, 50);
  assert.equal("state" in fetch.calls[0].variables.filter, false);
});

test("the filters are read once within five minutes and again after", async (t) => {
  const env = trackerHome(t, "tracker-cache");
  const fetch = fakeFetch();
  let clock = 1_000_000;
  const now = () => clock;
  await trackerIssues({ include_filters: true }, { env, fetchImpl: fetch.impl, now });
  clock += 299_000;
  const cached = await trackerIssues({ include_filters: true }, { env, fetchImpl: fetch.impl, now });
  assert.equal(fetch.calls.filter((call) => call.operation === "teams").length, 1);
  assert.deepEqual(cached.filters.teams, [{ key: "MK", name: "Mobile" }]);
  clock += 2_000;
  await trackerIssues({ include_filters: true }, { env, fetchImpl: fetch.impl, now });
  assert.equal(fetch.calls.filter((call) => call.operation === "teams").length, 2);
});

// A fake fetch whose workspace has the one given team.
function workspaceFetch(teamKey) {
  return fakeFetch({ teams: { data: { teams: { nodes: [{ key: teamKey, name: teamKey, projects: { nodes: [] } }] } } } });
}

// Replaces the key of the home's linear connection.
function setKey(env, apiKey) {
  const secrets = loadSecrets(env, { warn: () => {} });
  secrets.connections.linear = { type: "linear", apiKey };
  saveSecrets(secrets, env);
}

test("a replaced key does not serve the old workspace's filters, and swapping back reads again", async (t) => {
  const env = trackerHome(t, "tracker-cache-key");
  const now = () => 1_000_000;
  setKey(env, "lin_api_A");
  const a = await trackerIssues({ include_filters: true }, { env, fetchImpl: workspaceFetch("AAA").impl, now });
  assert.equal(a.filters.teams[0].key, "AAA");

  setKey(env, "lin_api_B");
  const b = await trackerIssues({ include_filters: true }, { env, fetchImpl: workspaceFetch("BBB").impl, now });
  assert.equal(JSON.stringify(b.filters).includes("AAA"), false, JSON.stringify(b.filters));
  assert.equal(JSON.stringify(b.filters).includes("BBB"), true);

  setKey(env, "lin_api_A");
  const back = workspaceFetch("AAA");
  const c = await trackerIssues({ include_filters: true }, { env, fetchImpl: back.impl, now });
  assert.deepEqual(c.filters.teams, [{ key: "AAA", name: "AAA" }]);
  assert.equal(back.calls.filter((call) => call.operation === "teams").length, 1);
  assert.ok(![a, b, c].some((answer) => JSON.stringify(answer).includes("lin_api_")));
});

test("the same key within the TTL reads the filters once", async (t) => {
  const env = trackerHome(t, "tracker-cache-same-key");
  const fetch = workspaceFetch("MK");
  const now = () => 1_000_000;
  await trackerIssues({ include_filters: true }, { env, fetchImpl: fetch.impl, now });
  const second = await trackerIssues({ include_filters: true }, { env, fetchImpl: fetch.impl, now });
  assert.equal(fetch.calls.filter((call) => call.operation === "teams").length, 1);
  assert.ok(!JSON.stringify(second).includes("lin_api_"));
});

test("an empty result is an answer, not an error", async (t) => {
  const env = trackerHome(t, "tracker-empty");
  const fetch = fakeFetch({ issues: { data: { issues: { nodes: [], pageInfo: { hasNextPage: false } } } } });
  const answer = await trackerIssues({ team: "NOPE" }, { env, fetchImpl: fetch.impl });
  assert.deepEqual(answer, { ok: true, provider: "linear", items: [], truncated: false });
});

test("a refused query answers provider-unavailable with a fixed hint and leaks nothing", async (t) => {
  const env = trackerHome(t, "tracker-refused");
  const refused = await trackerIssues({}, { env, fetchImpl: fakeFetch({ issues: { errors: [{ message: SECRET_MESSAGE }] } }).impl });
  assert.deepEqual(refused, { ok: false, error: "provider-unavailable", provider: "linear", hint: "issues not read (the service refused the query)" });
  const down = await trackerIssues({ include_filters: true }, { env, fetchImpl: fakeFetch({ status: 401 }).impl });
  assert.equal(down.error, "provider-unavailable");
  assert.equal(down.hint, "issues not read (HTTP 401)");
  for (const answer of [refused, down]) {
    const text = JSON.stringify(answer);
    assert.equal(text.includes("lin_api_"), false);
    assert.equal(text.includes(SECRET_MESSAGE), false);
  }
});

test("a failed filters read refuses the whole answer and is not cached", async (t) => {
  const env = trackerHome(t, "tracker-filters-down");
  const answer = await trackerIssues({ include_filters: true }, { env, fetchImpl: fakeFetch({ teams: { errors: [{ message: SECRET_MESSAGE }] } }).impl });
  assert.deepEqual(answer, { ok: false, error: "provider-unavailable", provider: "linear", hint: "teams not read (the service refused the query)" });
  const fetch = fakeFetch();
  const retried = await trackerIssues({ include_filters: true }, { env, fetchImpl: fetch.impl });
  assert.equal(retried.ok, true);
  assert.equal(fetch.calls.filter((call) => call.operation === "teams").length, 1);
});

test("a fetch that throws answers a fixed hint without its message", async (t) => {
  const env = trackerHome(t, "tracker-throws");
  const answer = await trackerIssues({}, {
    env,
    fetchImpl: async () => {
      throw new Error(SECRET_MESSAGE);
    },
  });
  assert.deepEqual(answer, { ok: false, error: "provider-unavailable", provider: "linear", hint: "issues not read (network failure)" });
});

test("text and label search combine with the other filters, and without them the filter has no search key", async (t) => {
  const env = trackerHome(t, "tracker-search");
  const fetch = fakeFetch();
  await trackerIssues({ team: "mk", state: "all", text: " login ", label: "Bug" }, { env, fetchImpl: fetch.impl });
  assert.deepEqual(fetch.calls[0].variables.filter, {
    team: { key: { eq: "MK" } },
    or: [{ title: { containsIgnoreCase: "login" } }, { description: { containsIgnoreCase: "login" } }],
    labels: { some: { name: { eqIgnoreCase: "Bug" } } },
  });
  await trackerIssues({ team: "mk", text: " ", label: null }, { env, fetchImpl: fetch.impl });
  assert.deepEqual(fetch.calls[1].variables, { filter: { team: { key: { eq: "MK" } }, state: { type: { nin: ["completed", "canceled"] } } }, first: 25 });
});

test("the issues answer keeps labels as names and carries labelDetails with their colors", async (t) => {
  const env = trackerHome(t, "tracker-label-colors");
  const labels = { nodes: [{ name: "Bug", color: "#eb5757" }, { name: "plain" }, { name: "odd", color: 7 }] };
  const issues = { data: { issues: { nodes: [{ ...ISSUE_NODE, labels }], pageInfo: { hasNextPage: false } } } };
  const answer = await trackerIssues({}, { env, fetchImpl: fakeFetch({ issues }).impl });
  assert.deepEqual(answer.items[0].labels, ["Bug", "plain", "odd"]);
  assert.deepEqual(answer.items[0].labelDetails, [
    { name: "Bug", color: "#eb5757" },
    { name: "plain", color: null },
    { name: "odd", color: null },
  ]);
});

// A fake fetch holding an old issue outside the recent ones: only a filter on its number reaches it.
function oldIssueFetch() {
  const old = { ...ISSUE_NODE, identifier: "DLW-136", title: "Old one" };
  const calls = [];
  const impl = async (url, options) => {
    const body = JSON.parse(options.body);
    calls.push(body.variables);
    const { filter } = body.variables;
    const hit = filter.number?.eq === 136 && (!filter.team || filter.team.key.eq === "DLW");
    return { status: 200, headers: new Map(), json: async () => ({ data: { issues: { nodes: hit ? [old] : [ISSUE_NODE], pageInfo: { hasNextPage: false } } } }) };
  };
  return { impl, calls };
}

test("a text id search reaches the provider through trackerIssues and returns the old issue", async (t) => {
  const env = trackerHome(t, "tracker-id-search");
  for (const args of [{ text: "dlw 136" }, { text: "DLW-136" }, { text: "136" }, { text: "136", team: "dlw" }]) {
    const fetch = oldIssueFetch();
    const answer = await trackerIssues(args, { env, fetchImpl: fetch.impl });
    assert.deepEqual(answer.items.map((item) => item.ref), ["DLW-136"], JSON.stringify(args));
    assert.equal(fetch.calls[0].filter.number.eq, 136);
    assert.equal("or" in fetch.calls[0].filter, false);
  }
});

const STATES = [
  { id: "s-todo", name: "Todo", type: "unstarted", position: 0 },
  { id: "s-progress", name: "In Progress", type: "started", position: 1 },
  { id: "s-review-a", name: "Review", type: "started", position: 2 },
  { id: "s-review-b", name: "review", type: "started", position: 3 },
];
const LABELS = { nodes: [{ id: "l-bug", name: "bug", isGroup: false }, { id: "l-customer", name: "Customer", isGroup: false }, { id: "l-area", name: "Area", isGroup: true }] };
const FULL_ISSUE = {
  id: "uuid-49",
  identifier: "MK-49",
  title: "Fix the login",
  description: "The login breaks.",
  url: "https://linear.app/acme/issue/MK-49/fix-the-login",
  priority: 2,
  priorityLabel: "High",
  createdAt: "2026-10-01T10:00:00.000Z",
  updatedAt: "2026-10-02T10:00:00.000Z",
  state: { name: "Todo", type: "unstarted" },
  team: { key: "MK", name: "Mobile", states: { nodes: STATES } },
  project: { name: "Auth" },
  assignee: { name: "Ana" },
  labels: { nodes: [{ name: "bug" }] },
  parent: { identifier: "MK-1", title: "Auth epic" },
  attachments: { nodes: [{ title: "Sentry 4507", url: "https://sentry.io/issues/4507" }] },
  comments: {
    nodes: [
      { body: "second", createdAt: "2026-10-02T09:00:00.000Z", user: { name: "Bo" } },
      { body: "first", createdAt: "2026-10-01T11:00:00.000Z", user: { name: "Ana" } },
    ],
    pageInfo: { hasNextPage: false },
  },
};
const EDITED = { identifier: "MK-49", title: "Fix the login", url: FULL_ISSUE.url, priority: 1, priorityLabel: "Urgent", state: { name: "In Progress", type: "started" }, assignee: null, labels: { nodes: [{ name: "Customer" }] } };
const ROOTS = ["issueCreate", "issueUpdate", "commentCreate", "issueLabels", "users(", "viewer", "issues(", "teams", "issue("];
const READ_KEYS = ["description", "comments", "attachments", "assignee", "state", "priority", "labels", "team", "project"];

// The GraphQL root field a query names.
function rootOf(query) {
  return ROOTS.find((root) => query.includes(root))?.replace("(", "") ?? "unknown";
}

// The routes a whole tracker write needs, each overridable.
function writeRoutes(overrides = {}) {
  return {
    issue: { body: { data: { issue: FULL_ISSUE } } },
    teams: { body: { data: { teams: { nodes: [{ id: "team-mk", key: "MK", states: { nodes: STATES } }] } } } },
    issueLabels: { body: { data: { issueLabels: LABELS } } },
    viewer: { body: { data: { viewer: { id: "user-me", name: "Me" } } } },
    users: { body: (variables) => ({ data: { users: { nodes: variables.who === "ana" ? [{ id: "u-1", name: "Ana" }, { id: "u-2", name: "Ana B" }] : [{ id: "u-bo", name: "Bo" }] } } }) },
    issueCreate: { body: { data: { issueCreate: { success: true, issue: { identifier: "MK-50", title: "Fix the login", url: "https://linear.app/acme/issue/MK-50" } } } } },
    issueUpdate: { body: { data: { issueUpdate: { success: true, issue: EDITED } } } },
    commentCreate: { body: { data: { commentCreate: { success: true, comment: { url: "https://linear.app/acme/issue/MK-49#comment-1" } } } } },
    ...overrides,
  };
}

// A fake fetch answering by GraphQL root field, recording each operation and its variables.
function routedFetch(routes = writeRoutes()) {
  const calls = [];
  const impl = async (url, options) => {
    const { query, variables } = JSON.parse(options.body);
    const operation = rootOf(query);
    calls.push({ operation, variables });
    const route = routes[operation] ?? { status: 404 };
    if (route.throws) throw new Error(`boom ${API_KEY}`);
    const body = typeof route.body === "function" ? route.body(variables) : route.body;
    return { status: route.status ?? 200, headers: new Map(), json: async () => body ?? {} };
  };
  return { impl, calls };
}

// The operations of the recorded calls, in order.
function operations(fetch) {
  return fetch.calls.map((call) => call.operation);
}

test("tracker_read answers every field of the issue, comments oldest first", async (t) => {
  const env = trackerHome(t, "tracker-read");
  const fetch = routedFetch();
  const answer = await trackerRead({ ref: "https://linear.app/acme/issue/mk-49/fix" }, { env, fetchImpl: fetch.impl });
  assert.equal(answer.ok, true);
  assert.deepEqual(fetch.calls[0].variables, { id: "MK-49" });
  for (const key of READ_KEYS) assert.ok(key in answer.issue, key);
  assert.deepEqual(answer.issue.team, { key: "MK", name: "Mobile" });
  assert.equal(answer.issue.project, "Auth");
  assert.deepEqual(answer.issue.state, { name: "Todo", type: "unstarted" });
  assert.equal(answer.issue.priority, 2);
  assert.equal(answer.issue.assignee, "Ana");
  assert.deepEqual(answer.issue.labels, ["bug"]);
  assert.equal(answer.issue.description, "The login breaks.");
  assert.deepEqual(answer.issue.attachments, [{ title: "Sentry 4507", url: "https://sentry.io/issues/4507" }]);
  assert.deepEqual(answer.issue.comments.map((comment) => comment.body), ["first", "second"]);
  assert.equal(answer.issue.comments_truncated, false);
  assert.ok(!JSON.stringify(answer).includes(API_KEY));
});

test("tracker_read keeps every field of a bare issue as null or an empty list", async (t) => {
  const env = trackerHome(t, "tracker-read-bare");
  const bare = { identifier: "MK-49", title: "Bare", state: { name: "Todo", type: "unstarted" }, team: { key: "MK", name: "Mobile" }, project: null, assignee: null, labels: { nodes: [] }, attachments: { nodes: [] }, comments: { nodes: [] } };
  const answer = await trackerRead({ ref: "MK-49" }, { env, fetchImpl: routedFetch(writeRoutes({ issue: { body: { data: { issue: bare } } } })).impl });
  assert.equal(answer.ok, true);
  for (const key of READ_KEYS) assert.ok(key in answer.issue, key);
  assert.equal(answer.issue.project, null);
  assert.equal(answer.issue.assignee, null);
  assert.equal(answer.issue.description, null);
  assert.deepEqual([answer.issue.labels, answer.issue.attachments, answer.issue.comments], [[], [], []]);
});

test("tracker_read answers not-found and an unreadable reference as normal refusals", async (t) => {
  const env = trackerHome(t, "tracker-read-missing");
  const missing = await trackerRead({ ref: "MK-404" }, { env, fetchImpl: routedFetch(writeRoutes({ issue: { body: { data: { issue: null } } } })).impl });
  assert.deepEqual(missing, { ok: false, error: "not-found", provider: "linear", hint: "issue MK-404 not found" });
  const fetch = routedFetch();
  const bad = await trackerRead({ ref: "not a ref" }, { env, fetchImpl: fetch.impl });
  assert.deepEqual(bad, { ok: false, error: "invalid-input", provider: "linear", hint: 'not an issue reference: "not a ref"' });
  assert.equal(fetch.calls.length, 0);
});

const ENTITY_NOT_FOUND = {
  body: {
    data: { issue: null },
    errors: [{ message: "Entity not found: Issue", path: ["issue"], extensions: { type: "invalid input", userPresentableMessage: "Could not find referenced Issue." } }],
  },
};

test("Linear's own entity-not-found answer is not-found for read, comment and update, and nothing is written", async (t) => {
  const env = trackerHome(t, "tracker-entity-not-found");
  const notFound = { ok: false, error: "not-found", provider: "linear", hint: "issue MK-404 not found" };
  const read = routedFetch(writeRoutes({ issue: ENTITY_NOT_FOUND }));
  assert.deepEqual(await trackerRead({ ref: "MK-404" }, { env, fetchImpl: read.impl }), notFound);
  const comment = routedFetch(writeRoutes({ issue: ENTITY_NOT_FOUND }));
  assert.deepEqual(await trackerComment({ ref: "MK-404", body: "Hello." }, { env, fetchImpl: comment.impl }), notFound);
  assert.deepEqual(operations(comment), ["issue"]);
  const update = routedFetch(writeRoutes({ issue: ENTITY_NOT_FOUND }));
  assert.deepEqual(await trackerUpdate({ ref: "MK-404", priority: 1 }, { env, fetchImpl: update.impl }), notFound);
  assert.deepEqual(operations(update), ["issue"]);
});

const NOT_FOUND_ERRORS = {
  "the referenced wording only": [{ message: "Could not find referenced Issue.", extensions: { type: "invalid input", userPresentableMessage: "Could not find referenced Issue." } }],
  "a user-presentable message only": [{ message: "Argument Validation Error", extensions: { userPresentableMessage: "Could not find referenced Issue." } }],
  "a not-found code": [{ message: "Issue not found", extensions: { code: "ENTITY_NOT_FOUND" } }],
  "a lower-case message": [{ message: "entity Not Found: Issue" }],
};
const OTHER_ERRORS = {
  "an authentication error": [{ message: "Authentication required", extensions: { type: "authentication error" } }],
  "a forbidden error": [{ message: "Forbidden" }],
  "a not-found mixed with an authentication error": [{ message: "Entity not found: Issue" }, { message: "nope", extensions: { type: "authentication error" } }],
};

test("every not-found wording Linear sends is not-found for read, comment and update, and nothing is written", async (t) => {
  const env = trackerHome(t, "tracker-not-found-wordings");
  const notFound = { ok: false, error: "not-found", provider: "linear", hint: "issue MK-404 not found" };
  for (const [wording, errors] of Object.entries(NOT_FOUND_ERRORS)) {
    const missing = { body: { data: null, errors } };
    assert.deepEqual(await trackerRead({ ref: "MK-404" }, { env, fetchImpl: routedFetch(writeRoutes({ issue: missing })).impl }), notFound, wording);
    const comment = routedFetch(writeRoutes({ issue: missing }));
    assert.deepEqual(await trackerComment({ ref: "MK-404", body: "Hi" }, { env, fetchImpl: comment.impl }), notFound, wording);
    assert.deepEqual(operations(comment), ["issue"], wording);
    const update = routedFetch(writeRoutes({ issue: missing }));
    assert.deepEqual(await trackerUpdate({ ref: "MK-404", priority: 1 }, { env, fetchImpl: update.impl }), notFound, wording);
    assert.deepEqual(operations(update), ["issue"], wording);
  }
  for (const [kind, errors] of Object.entries(OTHER_ERRORS)) {
    const answer = await trackerRead({ ref: "MK-404" }, { env, fetchImpl: routedFetch(writeRoutes({ issue: { body: { data: null, errors } } })).impl });
    assert.equal(answer.error, "provider-unavailable", kind);
  }
});

test("a GraphQL error that is not entity-not-found still answers provider-unavailable with the fixed text", async (t) => {
  const env = trackerHome(t, "tracker-auth-error");
  const authError = { body: { data: null, errors: [{ message: "Authentication required", extensions: { type: "authentication error" } }] } };
  const answer = await trackerRead({ ref: "MK-49" }, { env, fetchImpl: routedFetch(writeRoutes({ issue: authError })).impl });
  assert.deepEqual(answer, { ok: false, error: "provider-unavailable", provider: "linear", hint: "issue MK-49 not read (the service refused the query)" });
  const update = routedFetch(writeRoutes({ issue: authError }));
  const refused = await trackerUpdate({ ref: "MK-49", priority: 1 }, { env, fetchImpl: update.impl });
  assert.equal(refused.error, "provider-unavailable");
  assert.deepEqual(operations(update), ["issue"]);
});

test("tracker_create resolves the team, state, labels and assignee, then sends only the given fields", async (t) => {
  const env = trackerHome(t, "tracker-create");
  const fetch = routedFetch();
  const answer = await trackerCreate(
    { team: "mk", title: " Fix the login ", description: "Steps.", priority: 2, state: "todo", labels: ["Bug", "customer", "bug"], assignee: "me" },
    { env, fetchImpl: fetch.impl },
  );
  assert.deepEqual(answer, { ok: true, provider: "linear", issue: { ref: "MK-50", title: "Fix the login", url: "https://linear.app/acme/issue/MK-50" } });
  assert.deepEqual(operations(fetch), ["teams", "viewer", "issueLabels", "issueCreate"]);
  assert.deepEqual(fetch.calls[0].variables, { key: "MK" });
  assert.deepEqual(fetch.calls[3].variables, {
    input: { teamId: "team-mk", title: "Fix the login", description: "Steps.", priority: 2, stateId: "s-todo", assigneeId: "user-me", labelIds: ["l-bug", "l-customer"] },
  });

  const minimal = routedFetch();
  await trackerCreate({ team: "MK", title: "Just a title" }, { env, fetchImpl: minimal.impl });
  assert.deepEqual(operations(minimal), ["teams", "issueCreate"]);
  assert.deepEqual(minimal.calls[1].variables, { input: { teamId: "team-mk", title: "Just a title" } });
});

test("tracker_comment posts the body on the issue's id", async (t) => {
  const env = trackerHome(t, "tracker-comment");
  const fetch = routedFetch();
  const answer = await trackerComment({ ref: "MK-49", body: "Looked into it." }, { env, fetchImpl: fetch.impl });
  assert.deepEqual(answer, { ok: true, provider: "linear", ref: "MK-49", comment: { url: "https://linear.app/acme/issue/MK-49#comment-1" } });
  assert.deepEqual(operations(fetch), ["issue", "commentCreate"]);
  assert.deepEqual(fetch.calls[1].variables, { issueId: "uuid-49", body: "Looked into it." });
});

test("tracker_update sends only the changed fields with resolved ids and answers the issue as the tracker holds it", async (t) => {
  const env = trackerHome(t, "tracker-update");
  const fetch = routedFetch();
  const answer = await trackerUpdate(
    { ref: "MK-49", priority: 1, state: "in progress", assignee: "none", labels_add: ["customer"], labels_remove: ["bug"] },
    { env, fetchImpl: fetch.impl },
  );
  assert.equal(answer.ok, true);
  assert.deepEqual(answer.changed, ["priority", "state", "assignee", "labels_add", "labels_remove"]);
  assert.deepEqual(answer.issue.labels, ["Customer"]);
  assert.equal(answer.issue.assignee, null);
  assert.deepEqual(operations(fetch), ["issue", "issueLabels", "issueUpdate"]);
  assert.deepEqual(fetch.calls[2].variables, {
    id: "uuid-49",
    input: { priority: 1, stateId: "s-progress", assigneeId: null, addedLabelIds: ["l-customer"], removedLabelIds: ["l-bug"] },
  });

  const assign = routedFetch();
  await trackerUpdate({ ref: "MK-49", assignee: "bo@acme.io", description: "New text." }, { env, fetchImpl: assign.impl });
  assert.deepEqual(operations(assign), ["issue", "users", "issueUpdate"]);
  assert.deepEqual(assign.calls[2].variables.input, { description: "New text.", assigneeId: "u-bo" });
});

test("an unknown or ambiguous name, a group label or a bad field is refused with nothing written", async (t) => {
  const env = trackerHome(t, "tracker-refused-names");
  const cases = [
    [trackerUpdate, { ref: "MK-49", state: "Shipped" }, /^unknown state "Shipped" \(known: Todo, In Progress, Review, review\)$/],
    [trackerUpdate, { ref: "MK-49", state: "REVIEW" }, /^state "REVIEW" names 2 items$/],
    [trackerUpdate, { ref: "MK-49", labels_add: ["area"] }, /^label "area" is a group$/],
    [trackerUpdate, { ref: "MK-49", labels_add: ["nope"] }, /^unknown label "nope" \(known: bug, Customer, Area\)$/],
    [trackerUpdate, { ref: "MK-49", assignee: "ana" }, /^assignee "ana" names 2 people/],
    [trackerCreate, { team: "XX", title: "t" }, /^unknown team "XX"$/, writeRoutes({ teams: { body: { data: { teams: { nodes: [] } } } } })],
    [trackerUpdate, { ref: "MK-49" }, /^nothing to change/],
    [trackerUpdate, { ref: "MK-49", labels_add: ["Bug"], labels_remove: ["bug"] }, /^label "Bug" is both added and removed$/],
    [trackerUpdate, { ref: "MK-49", priority: 7 }, /^priority is an integer 0\.\.4/],
    [trackerCreate, { team: "MK" }, /^title is required$/],
    [trackerCreate, { team: "MK", title: "x".repeat(256) }, /^title is longer than 255 characters$/],
    [trackerCreate, { team: "MK", title: "t", assignee: "none" }, /^assignee none only applies to `tracker_update`/],
    [trackerComment, { ref: "MK-49", body: "  " }, /^body is required$/],
  ];
  for (const [entry, args, hint, routes] of cases) {
    const fetch = routedFetch(routes ?? writeRoutes());
    const answer = await entry(args, { env, fetchImpl: fetch.impl });
    assert.equal(answer.error, "invalid-input", JSON.stringify(args));
    assert.match(answer.hint, hint);
    assert.ok(!operations(fetch).some((operation) => ["issueCreate", "issueUpdate", "commentCreate"].includes(operation)), JSON.stringify(args));
  }
});

test("inside a queue job every write is refused before any call, whatever the home, and the read still answers", async (t) => {
  const env = { ...trackerHome(t, "tracker-in-job"), NIGHTQUEUE_JOB_ID: "7" };
  const writes = [
    ["`tracker_create`", trackerCreate, { team: "MK", title: "t" }],
    ["`tracker_comment`", trackerComment, { ref: "MK-49", body: "b" }],
    ["`tracker_update`", trackerUpdate, { ref: "MK-49", priority: 1 }],
  ];
  const fetch = routedFetch();
  for (const [action, entry, args] of writes) {
    await assert.rejects(entry(args, { env, fetchImpl: fetch.impl }), (err) => err.message.startsWith(`refused: ${action} inside J-7:`) && err.message.endsWith("Nothing was sent"));
  }
  assert.equal(fetch.calls.length, 0);
  assert.equal((await trackerRead({ ref: "MK-49" }, { env, fetchImpl: fetch.impl })).ok, true);
});

test("with no tracker connection every new entry answers no-connection and calls nothing", async (t) => {
  const env = trackerHome(t, "tracker-tools-none", { connected: false });
  const fetch = routedFetch();
  const entries = [
    [trackerRead, { ref: "MK-49" }],
    [trackerCreate, { team: "MK", title: "t" }],
    [trackerComment, { ref: "MK-49", body: "b" }],
    [trackerUpdate, { ref: "MK-49", priority: 1 }],
  ];
  for (const [entry, args] of entries) {
    assert.deepEqual(await entry(args, { env, fetchImpl: fetch.impl }), {
      ok: false,
      error: "no-connection",
      provider: "linear",
      hint: 'connect it: echo "$LINEAR_API_KEY" | nightqueue connection add linear --type linear',
    });
  }
  assert.equal(fetch.calls.length, 0);
});

test("a provider without the operation answers unsupported", async (t) => {
  const env = trackerHome(t, "tracker-unsupported");
  const readOnly = { ...linear, tracker: { issues: linear.tracker.issues, filters: linear.tracker.filters } };
  const answer = await withProviders([readOnly], () => trackerCreate({ team: "MK", title: "t" }, { env, fetchImpl: routedFetch().impl }));
  assert.deepEqual(answer, { ok: false, error: "unsupported", provider: "linear", hint: "Linear cannot create issues" });
});

test("a write the service did not confirm, or that failed on the wire, warns it may still have been applied", async (t) => {
  const env = trackerHome(t, "tracker-uncertain");
  const unconfirmed = await trackerCreate({ team: "MK", title: "t" }, { env, fetchImpl: routedFetch(writeRoutes({ issueCreate: { body: { data: { issueCreate: { success: false } } } } })).impl });
  assert.deepEqual(unconfirmed, {
    ok: false,
    error: "provider-unavailable",
    provider: "linear",
    hint: "issue not created in MK (the service did not confirm); it may still have been applied - read the issue before trying again",
  });
  const lost = await trackerComment({ ref: "MK-49", body: "b" }, { env, fetchImpl: routedFetch(writeRoutes({ commentCreate: { throws: true } })).impl });
  assert.equal(lost.hint, "comment not posted on MK-49 (network failure); it may still have been applied - read the issue before trying again");
  const refused = await trackerUpdate({ ref: "MK-49", priority: 1 }, { env, fetchImpl: routedFetch(writeRoutes({ issueUpdate: { status: 400, body: {} } })).impl });
  assert.equal(refused.hint, "issue MK-49 not updated (HTTP 400)");
});

const WARNING = "it may still have been applied - read the issue before trying again";
const NESTED_ERRORS = [{ message: "nested field failed" }];
const WRITES = {
  create: { route: "issueCreate", call: (deps) => trackerCreate({ team: "MK", title: "t" }, deps) },
  comment: { route: "commentCreate", call: (deps) => trackerComment({ ref: "MK-49", body: "b" }, deps) },
  update: { route: "issueUpdate", call: (deps) => trackerUpdate({ ref: "MK-49", priority: 1 }, deps) },
};

test("a write answered HTTP 200 with GraphQL errors, with or without success, warns it may still have been applied", async (t) => {
  const env = trackerHome(t, "tracker-uncertain-200");
  for (const [name, { route, call }] of Object.entries(WRITES)) {
    const landed = { body: { data: { [route]: { success: true, issue: { identifier: "MK-50" }, comment: { url: "u" } } }, errors: NESTED_ERRORS } };
    const empty = { body: { data: null, errors: NESTED_ERRORS } };
    for (const answer of [landed, empty]) {
      const refused = await call({ env, fetchImpl: routedFetch(writeRoutes({ [route]: answer })).impl });
      assert.equal(refused.ok, false, name);
      assert.ok(refused.hint.endsWith(WARNING), `${name}: ${refused.hint}`);
    }
    const crashed = await call({ env, fetchImpl: routedFetch(writeRoutes({ [route]: { status: 500, body: {} } })).impl });
    assert.ok(crashed.hint.endsWith(WARNING), `${name}: ${crashed.hint}`);
    const lost = await call({ env, fetchImpl: routedFetch(writeRoutes({ [route]: { throws: true } })).impl });
    assert.ok(lost.hint.endsWith(WARNING), `${name}: ${lost.hint}`);
  }
});

// Every new entry called once, answering each answer.
async function everyEntry(deps) {
  return [
    await trackerRead({ ref: "MK-49" }, deps),
    await trackerCreate({ team: "MK", title: "t" }, deps),
    await trackerComment({ ref: "MK-49", body: "b" }, deps),
    await trackerUpdate({ ref: "MK-49", priority: 1 }, deps),
  ];
}

// A provider whose every tracker operation throws an error carrying the key.
function throwingProvider() {
  const boom = async () => {
    throw new Error(`provider failed with ${API_KEY}`);
  };
  return { ...linear, tracker: { issues: boom, filters: boom, issue: boom, create: boom, comment: boom, update: boom } };
}

test("the key is in no answer: success, GraphQL error, HTTP failure, thrown fetch and thrown provider", async (t) => {
  const env = trackerHome(t, "tracker-no-key");
  const keyed = { errors: [{ message: `invalid key ${API_KEY}` }] };
  const keyedRoutes = Object.fromEntries(Object.keys(writeRoutes()).map((name) => [name, { body: keyed }]));
  const unauthorized = Object.fromEntries(Object.keys(writeRoutes()).map((name) => [name, { status: 401, body: { error: API_KEY } }]));
  const throwing = Object.fromEntries(Object.keys(writeRoutes()).map((name) => [name, { throws: true }]));
  const answers = {
    success: await everyEntry({ env, fetchImpl: routedFetch().impl }),
    graphql: await everyEntry({ env, fetchImpl: routedFetch(keyedRoutes).impl }),
    http: await everyEntry({ env, fetchImpl: routedFetch(unauthorized).impl }),
    fetch: await everyEntry({ env, fetchImpl: routedFetch(throwing).impl }),
    provider: await withProviders([throwingProvider()], () => everyEntry({ env, fetchImpl: routedFetch().impl })),
  };
  for (const [path, list] of Object.entries(answers)) {
    assert.equal(JSON.stringify(list).includes(API_KEY), false, `${path}: ${JSON.stringify(list)}`);
  }
  assert.ok(answers.success.every((answer) => answer.ok === true));
  assert.ok(answers.provider.every((answer) => answer.error === "provider-unavailable"));
  assert.equal(answers.provider[1].hint, "the tracker write failed; it may still have been applied - read the issue before trying again");
  assert.equal(answers.http[0].hint, "issue MK-49 not read (HTTP 401)");
});
