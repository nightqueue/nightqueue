import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { loadSecrets, saveSecrets } from "../../src/config/store.mjs";
import { withProviders } from "../../src/integrations/registry.mjs";
import { github } from "../../src/integrations/github.mjs";
import { resetTrackerCache, trackerInstructionLines, trackerIssues } from "../../src/integrations/tracker.mjs";
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
    'Linear issues come from `tracker_issues`; queue from one with `origin: {kind: "linear", ref}` and the nightqueue `project`',
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
