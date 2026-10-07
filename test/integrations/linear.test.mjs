import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { test } from "node:test";
import { defaultContext, run } from "../../src/cli/index.mjs";
import { loadSecrets, saveSecrets } from "../../src/config/store.mjs";
import { ORIGIN_MAX_BYTES, enrichJobOrigin } from "../../src/integrations/enrich.mjs";
import { requestJson } from "../../src/integrations/http.mjs";
import { linear } from "../../src/integrations/linear.mjs";
import { detectOrigin, explicitOrigin } from "../../src/integrations/origin.mjs";
import { openDb } from "../../src/memory/db.mjs";
import { acquireClose, claimJobById, finishJob, getJob } from "../../src/memory/jobs.mjs";
import { CLOSE_STEPS, runClosePipeline } from "../../src/queue/close.mjs";
import { runPostCloseSteps } from "../../src/queue/close-start.mjs";
import { openStore } from "../../src/store/open.mjs";
import { makeHome, makeProject, projectIdOf, seedDoneJob } from "../../test-support/memory.mjs";
import { orgOfProject } from "../../test-support/origin-provider.mjs";

const API_KEY = "lin_api_secret_0123456789";
const API = "https://api.linear.app/graphql";
const ISSUE_URL = "https://linear.app/acme/issue/MK-42/fix-the-login";
const SECRET_MESSAGE = "secret-ish TOKEN lin_api_x";
const MERGE_SHA = "abc1234def5678";
const WORKER = "close:test:1:linear";
const RECORD = { type: "linear", apiKey: API_KEY };
const POST_STEPS = CLOSE_STEPS.filter((step) => step.required === false);
const STATES = [
  { id: "s-todo", name: "Todo", type: "unstarted", position: 0 },
  { id: "s-released", name: "Released", type: "completed", position: 5 },
  { id: "s-done", name: "Done", type: "completed", position: 3 },
  { id: "s-cancel", name: "Canceled", type: "canceled", position: 4 },
];

// The GraphQL operation a request body carries, named by its root field.
function operationOf(body) {
  const query = JSON.parse(body ?? "{}").query ?? "";
  for (const name of ["viewer", "issueUpdate", "commentCreate", "issues(", "teams", "issue("]) {
    if (query.includes(name)) return name.replace("(", "");
  }
  return "unknown";
}

// A fake fetch recording every call and answering by GraphQL operation, 404 for one it does not know.
function fakeFetch(routes = {}) {
  const calls = [];
  const impl = async (url, options) => {
    const operation = operationOf(options.body);
    const { query = "", variables = null } = JSON.parse(options.body ?? "{}");
    calls.push({ url, operation, query, variables, auth: options.headers?.Authorization ?? null });
    const route = routes[operation] ?? { status: 404 };
    if (route.throws) throw new Error(SECRET_MESSAGE);
    return { status: route.status ?? 200, headers: new Map(), json: async () => route.body ?? {} };
  };
  return { impl, calls };
}

// The http a provider receives, bound to a fake fetch.
function httpOf(fetch) {
  return (url, options = {}) => requestJson(fetch.impl, url, options);
}

// A full issue answer with long fields and comments out of order.
function fullIssue({ description = "The login breaks.\n\nSteps: open it.", states = STATES } = {}) {
  return {
    id: "uuid-42",
    identifier: "MK-42",
    title: "Fix the login",
    description,
    url: ISSUE_URL,
    priority: 2,
    priorityLabel: "High",
    createdAt: "2026-10-01T10:00:00.000Z",
    updatedAt: "2026-10-02T10:00:00.000Z",
    state: { name: "In Progress", type: "started" },
    labels: { nodes: [{ name: "bug" }, { name: "auth" }] },
    assignee: { name: "Ana" },
    parent: { identifier: "MK-1", title: "Auth epic" },
    attachments: { nodes: [{ title: "Sentry 4507", url: "https://sentry.io/issues/4507" }] },
    comments: {
      nodes: [
        { body: "second", createdAt: "2026-10-02T09:00:00.000Z", user: { name: "Bo" } },
        { body: "x".repeat(2500), createdAt: "2026-10-01T11:00:00.000Z", user: { name: "Ana" } },
      ],
    },
    team: { key: "MK", states: { nodes: states } },
  };
}

// The routes of a close: the issue read (with its current state, if any), the state move and the comment, each answerable with a status or errors.
function closeRoutes({ states = STATES, current, update = { success: true }, comment = { success: true }, updateStatus = 200 } = {}) {
  const state = current === undefined ? {} : { state: current };
  return {
    issue: { body: { data: { issue: { id: "uuid-42", identifier: "MK-42", ...state, team: { states: { nodes: states } } } } } },
    issueUpdate: { status: updateStatus, body: { data: { issueUpdate: update } } },
    commentCreate: comment.errors ? { body: { errors: [{ message: SECRET_MESSAGE }] } } : { body: { data: { commentCreate: comment } } },
  };
}

// Calls the provider's onClosed with a fake fetch, answering the result and the calls made.
async function close(routes, slot = { ...RECORD, name: "linear" }) {
  const fetch = fakeFetch(routes);
  const answer = await linear.onClosed({
    ref: "MK-42",
    job: { id: 1, ref: "J-1", title: "fix the login", project: "alpha" },
    result: { prUrl: "https://github.com/acme/api/pull/7", prNumber: 7, mergeSha: MERGE_SHA },
    settings: null,
    slot,
    connections: [],
    http: httpOf(fetch),
  });
  return { answer, calls: fetch.calls };
}

// A home with project `alpha`, no project integrations and the home's linear connection.
function linearHome(t, name, { connected = true } = {}) {
  const env = makeHome(t, name);
  const checkout = makeProject(t, env, "alpha");
  const projectId = projectIdOf(env, "alpha");
  if (connected) {
    const secrets = loadSecrets(env, { warn: () => {} });
    secrets.connections.linear = { ...RECORD };
    saveSecrets(secrets, env);
  }
  return { env, checkout, projectId, orgId: orgOfProject(env, projectId) };
}

// Pre-close steps that merge and settle without gh, so the real post-close steps run after a real settle.
function fakePreSteps() {
  const done = (note, data) => async () => ({ status: "done", note, data });
  return [
    { name: "preflight", run: done("checks green", { title: "fix the login" }) },
    { name: "conflict", run: async () => ({ status: "skipped", note: "mergeable" }) },
    { name: "merge", run: done("merged", { merged: true, mergeSha: MERGE_SHA }) },
    { name: "settle", run: async () => ({ status: "done", note: "ready", data: { noticeLine: "Closed: PR #7 merged as abc1234 on 2026-10-01" } }) },
  ];
}

// Runs the CLI in this process with a stdin, collecting what it printed.
async function runCli(env, argv, input = "") {
  const out = [];
  const err = [];
  const code = await run(argv, { ...defaultContext(), env, stdin: Readable.from([input]), out: (line) => out.push(line), err: (line) => err.push(line) });
  return { code, out, err };
}

// Claims the newest pending job and finishes it `done` with a pull request, answering its id.
function finishQueuedJob(env) {
  const { id } = openDb(env).prepare("SELECT MAX(id) AS id FROM jobs").get();
  if (!claimJobById(id, { worker: WORKER, cap: null }, env)) throw new Error(`job #${id} could not be claimed`);
  if (!finishJob(id, { worker: WORKER, status: "done", prUrl: "https://github.com/acme/api/pull/7" }, env)) throw new Error(`job #${id} could not be finished`);
  return id;
}

// Closes a done job with the fake pre-close steps and the real post-close ones.
async function closeLinearJob(home, id, fetch) {
  acquireClose(id, { worker: WORKER, leaseS: 660 }, home.env);
  const outcome = await runClosePipeline({
    store: openStore(home.env),
    job: getJob(id, home.env),
    worker: WORKER,
    env: home.env,
    deps: { fetch: fetch.impl },
    timeoutS: 60,
    signal: null,
    onStep: () => {},
    checkout: home.checkout,
    steps: [...fakePreSteps(), ...POST_STEPS],
  });
  return { outcome, row: getJob(id, home.env) };
}

test("a linear link or an upper-case key named after the word linear is an origin; a bare KEY-n in prose never is", () => {
  const parse = (text, options) => linear.origin.parse(text, options);
  assert.equal(parse(`see ${ISSUE_URL}`), "MK-42");
  assert.equal(parse("https://linear.app/acme/issue/mk-7"), "MK-7");
  assert.equal(parse("https://linear.app/acme/issue/MK-8?foo=1"), "MK-8");
  assert.equal(parse("the bug is linear MK-42 again"), "MK-42");
  assert.equal(parse("Linear: MK-43"), "MK-43");
  assert.equal(parse("Linear: mk-42"), null);
  assert.equal(parse("fix MK-42 and J-86 per D-55"), null);
  assert.equal(parse("mk-42", { explicit: true }), "MK-42");
  assert.equal(parse("not a key", { explicit: true }), null);
  assert.deepEqual(explicitOrigin({ kind: "linear", ref: "mk-42" }), { kind: "linear", ref: "MK-42" });
  assert.deepEqual(detectOrigin(`crash ${ISSUE_URL}`), { kind: "linear", ref: "MK-42" });
  assert.deepEqual(detectOrigin(`see https://acme.sentry.io/issues/4507/ and ${ISSUE_URL}`), { kind: "sentry", ref: "4507" });
  assert.equal(detectOrigin("bare MK-42 in prose"), null);
});

test("the connection test reads the viewer with the bare key, and a refusal or GraphQL error carries no message", async () => {
  const ok = fakeFetch({ viewer: { body: { data: { viewer: { id: "u1", name: "Ana" } } } } });
  const passed = await linear.connection.test(RECORD, { fetchImpl: ok.impl });
  assert.deepEqual(passed, { ok: true, status: 200, viewer: "Ana", detail: "ok" });
  assert.equal(linear.connection.summary(passed), "viewer=Ana");
  assert.deepEqual(ok.calls.map((call) => [call.url, call.operation, call.auth]), [[API, "viewer", API_KEY]]);

  const denied = await linear.connection.test(RECORD, { fetchImpl: fakeFetch({ viewer: { status: 401 } }).impl });
  assert.deepEqual(denied, { ok: false, status: 401, viewer: null, detail: "HTTP 401" });
  const refused = await linear.connection.test(RECORD, { fetchImpl: fakeFetch({ viewer: { body: { errors: [{ message: SECRET_MESSAGE }] } } }).impl });
  assert.deepEqual(refused, { ok: false, status: 200, viewer: null, detail: "the service refused the query" });
});

test("enrichment reads the whole issue into markdown: facts, description, labels, attachments, comments oldest first and cut", async () => {
  const fetch = fakeFetch({ issue: { body: { data: { issue: fullIssue() } } } });
  const markdown = await linear.origin.enrich("MK-42", { connection: RECORD, http: httpOf(fetch) });
  assert.deepEqual(fetch.calls.map((call) => [call.operation, call.variables]), [["issue", { id: "MK-42" }]]);
  const lines = markdown.split("\n");
  assert.equal(lines[0], "# Linear issue MK-42: Fix the login");
  for (const fact of ["- state: In Progress (started)", "- team: MK", "- priority: High", "- assignee: Ana", `- url: ${ISSUE_URL}`, "- parent: MK-1 Auth epic"]) {
    assert.ok(lines.includes(fact), fact);
  }
  assert.ok(markdown.includes("## Description\nThe login breaks.\n\nSteps: open it.\n"));
  assert.ok(markdown.includes("## Labels\n- bug\n- auth\n"));
  assert.ok(markdown.includes("## Attachments\n- Sentry 4507 https://sentry.io/issues/4507\n"));
  const comments = markdown.slice(markdown.indexOf("## Comments"));
  assert.ok(comments.indexOf("Ana:") < comments.indexOf("Bo:"), "comments are not oldest first");
  assert.ok(comments.includes(`  ${"x".repeat(2000)}...\n`));
  assert.ok(!comments.includes("x".repeat(2001)));
});

test("enrichment answers a missing issue or a failure as a detail with no message or key", async () => {
  const missing = await linear.origin.enrich("MK-9", { connection: RECORD, http: httpOf(fakeFetch({ issue: { body: { data: { issue: null } } } })) });
  assert.deepEqual(missing, { detail: "issue MK-9 not found" });
  const refused = await linear.origin.enrich("MK-9", { connection: RECORD, http: httpOf(fakeFetch({ issue: { body: { errors: [{ message: SECRET_MESSAGE }] } } })) });
  assert.deepEqual(refused, { detail: "issue MK-9 not read (the service refused the query)" });
  const thrown = await linear.origin.enrich("MK-9", { connection: RECORD, http: httpOf(fakeFetch({ issue: { throws: true } })) });
  assert.deepEqual(thrown, { detail: "issue MK-9 not read (network failure)" });
});

test("the runner's enrichment writes the capped linear file for a project with no integrations, and logs no secret", async (t) => {
  const home = linearHome(t, "linear-enrich");
  const dir = mkdtempSync(join(tmpdir(), "nq-linear-origin-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const fetch = fakeFetch({ issue: { body: { data: { issue: fullIssue({ description: "é".repeat(20000) }) } } } });
  const lines = [];
  const enrich = () => enrichJobOrigin({ origin: { kind: "linear", ref: "MK-42" }, orgId: home.orgId, integrations: null, dir, env: home.env, fetchImpl: fetch.impl, log: (line) => lines.push(line) });
  await enrich();
  assert.deepEqual(lines, ["origin: linear MK-42 (connection: linear)"]);
  const file = join(dir, "linear.md");
  const written = readFileSync(file, "utf8");
  assert.ok(Buffer.byteLength(written, "utf8") <= ORIGIN_MAX_BYTES);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.ok(!written.includes(API_KEY));
  await enrich();
  assert.equal(fetch.calls.length, 1, "the file was fetched twice");
});

test("enrichment with no linear connection in the home logs one skipped line and writes nothing", async (t) => {
  const home = linearHome(t, "linear-enrich-none", { connected: false });
  const dir = mkdtempSync(join(tmpdir(), "nq-linear-none-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const lines = [];
  await enrichJobOrigin({ origin: { kind: "linear", ref: "MK-42" }, orgId: home.orgId, integrations: null, dir, env: home.env, fetchImpl: fakeFetch().impl, log: (line) => lines.push(line) });
  assert.deepEqual(lines, ["origin: linear MK-42 (connection: none)", "origin enrichment skipped: no linear connection in the home"]);
});

test("onClosed moves the issue to the lowest-position completed state, then comments naming the merge", async () => {
  const { answer, calls } = await close(closeRoutes());
  assert.deepEqual(answer, { status: "done", note: "issue MK-42 moved to Done" });
  assert.deepEqual(calls.map((call) => [call.operation, call.variables]), [
    ["issue", { id: "MK-42" }],
    ["issueUpdate", { id: "uuid-42", stateId: "s-done" }],
    ["commentCreate", { issueId: "uuid-42", body: "Merged https://github.com/acme/api/pull/7 (J-1, nightqueue)" }],
  ]);
  assert.ok(calls.every((call) => call.auth === API_KEY));
});

test("onClosed comments only when the team has no completed state, and a failed move stops before the comment", async () => {
  const noState = await close(closeRoutes({ states: STATES.filter((state) => state.type !== "completed") }));
  assert.deepEqual(noState.answer, { status: "warning", note: "issue MK-42 has no completed state; comment posted", notified: true });
  assert.deepEqual(noState.calls.map((call) => call.operation), ["issue", "commentCreate"]);

  const unmoved = await close(closeRoutes({ update: { success: false } }));
  assert.deepEqual(unmoved.answer, { status: "warning", note: "issue MK-42 not moved to Done (the service did not confirm)" });
  assert.deepEqual(unmoved.calls.map((call) => call.operation), ["issue", "issueUpdate"]);

  const forbidden = await close(closeRoutes({ updateStatus: 403 }));
  assert.deepEqual(forbidden.answer, { status: "warning", note: "issue MK-42 not moved to Done (HTTP 403)" });
});

test("onClosed reports a failed comment, a failed read and a missing connection, never with a message or the key", async () => {
  const commentFailed = await close(closeRoutes({ comment: { errors: true } }));
  assert.deepEqual(commentFailed.answer, { status: "warning", note: "issue MK-42 moved to Done; comment not posted (the service refused the query)", notified: true });

  const both = await close(closeRoutes({ states: [], comment: { success: false } }));
  assert.deepEqual(both.answer, { status: "warning", note: "issue MK-42 has no completed state; comment not posted (the service did not confirm)" });

  const unread = await close({ issue: { status: 401 } });
  assert.deepEqual(unread.answer, { status: "warning", note: "issue MK-42 not read (HTTP 401)" });
  const missing = await close({ issue: { body: { data: { issue: null } } } });
  assert.deepEqual(missing.answer, { status: "warning", note: "issue MK-42 not read (not found)" });

  const unbound = await close(closeRoutes(), null);
  assert.deepEqual(unbound.answer, { status: "skipped", note: "no linear connection in the home", notice: true });
  assert.equal(unbound.calls.length, 0);

  const all = JSON.stringify([commentFailed.answer, both.answer, unread.answer, missing.answer]);
  assert.ok(!all.includes(API_KEY) && !all.includes("lin_api_") && !all.includes(SECRET_MESSAGE));
});

test("closing a job queued from a linear link in a project with no integrations moves the issue and comments once", async (t) => {
  const home = linearHome(t, "linear-close");
  const fetch = fakeFetch(closeRoutes());
  const id = seedDoneJob(home.env, { prompt: `the login breaks, see ${ISSUE_URL}` });
  const { outcome, row } = await closeLinearJob(home, id, fetch);
  assert.equal(outcome.status, "closed");
  assert.deepEqual(outcome.postClose.steps[0], { name: "origin", status: "done", note: "issue MK-42 moved to Done" });
  assert.deepEqual(fetch.calls.map((call) => call.operation), ["issue", "issueUpdate", "commentCreate"]);
  assert.equal(JSON.parse(row.close).data.originNotified, true);
  assert.ok(!JSON.stringify(row).includes(API_KEY));
});

test("smoke: connection add, queue add --origin and close move the issue and comment once; a repeat close posts nothing", async (t) => {
  const home = linearHome(t, "linear-smoke", { connected: false });
  const added = await runCli(home.env, ["connection", "add", "linear", "--type", "linear"], `${API_KEY}\n`);
  assert.equal(added.code, 0, added.err.join("\n"));
  assert.deepEqual(added.out, ["stored connection `linear` (linear) for the whole home"]);

  const queued = await runCli(home.env, ["queue", "add", "fix", "the", "login", "--origin", "linear:mk-42", "--project", "alpha"]);
  assert.equal(queued.code, 0, queued.err.join("\n"));
  assert.ok(queued.out.includes("origin: linear MK-42 (connection: linear)"), queued.out.join("\n"));
  const id = finishQueuedJob(home.env);

  const fetch = fakeFetch(closeRoutes());
  const { outcome } = await closeLinearJob(home, id, fetch);
  assert.deepEqual(outcome.postClose.steps[0], { name: "origin", status: "done", note: "issue MK-42 moved to Done" });
  assert.deepEqual(fetch.calls.map((call) => call.operation), ["issue", "issueUpdate", "commentCreate"]);

  const again = fakeFetch(closeRoutes());
  const rerun = await runPostCloseSteps({ store: openStore(home.env), id, names: ["origin"], env: home.env, deps: { fetch: again.impl } });
  assert.deepEqual(rerun.steps, [{ name: "origin", status: "done", note: "already notified" }]);
  assert.equal(again.calls.length, 0, "a repeat close posted again");
  assert.ok(![...added.out, ...queued.out].join("\n").includes(API_KEY));
});

test("a close whose move failed is retried whole by --steps origin, and the comment is posted once", async (t) => {
  const home = linearHome(t, "linear-retry");
  const id = seedDoneJob(home.env, { prompt: `the login breaks, see ${ISSUE_URL}` });
  const failed = fakeFetch(closeRoutes({ updateStatus: 503 }));
  const { row } = await closeLinearJob(home, id, failed);
  assert.equal(JSON.parse(row.close).steps.origin.status, "warning");
  assert.deepEqual(failed.calls.map((call) => call.operation), ["issue", "issueUpdate"]);

  const retry = fakeFetch(closeRoutes());
  const answer = await runPostCloseSteps({ store: openStore(home.env), id, names: ["origin"], env: home.env, deps: { fetch: retry.impl } });
  assert.deepEqual(answer.steps, [{ name: "origin", status: "done", note: "issue MK-42 moved to Done" }]);
  assert.deepEqual(retry.calls.map((call) => call.operation), ["issue", "issueUpdate", "commentCreate"]);
});

test("the close reads the issue's current state in the same issue query, and every request is one of the six operations", async () => {
  const { calls } = await close(closeRoutes({ current: { name: "In Progress", type: "started" } }));
  assert.ok(calls[0].query.includes("state { name type }"), calls[0].query);
  const roots = ["viewer", "teams", "issue", "issues", "issueUpdate", "commentCreate"];
  assert.ok(calls.every((call) => roots.includes(call.operation)), calls.map((call) => call.operation).join(","));
});

test("an issue already completed (Released) or canceled keeps its state and only gets the comment", async () => {
  const released = await close(closeRoutes({ current: { name: "Released", type: "completed" } }));
  assert.deepEqual(released.answer, { status: "done", note: "issue MK-42 already Released; comment posted" });
  assert.deepEqual(released.calls.map((call) => call.operation), ["issue", "commentCreate"]);

  const canceled = await close(closeRoutes({ current: { name: "Canceled", type: "canceled" } }));
  assert.deepEqual(canceled.answer, { status: "done", note: "issue MK-42 already Canceled; comment posted" });
  assert.deepEqual(canceled.calls.map((call) => call.operation), ["issue", "commentCreate"]);

  const unnamed = await close(closeRoutes({ current: { name: null, type: "canceled" } }));
  assert.deepEqual(unnamed.answer, { status: "done", note: "issue MK-42 already canceled; comment posted" });
});

test("a started issue or one with no state read moves to the lowest-position completed state, never a later one", async () => {
  const started = await close(closeRoutes({ current: { name: "In Progress", type: "started" } }));
  assert.deepEqual(started.answer, { status: "done", note: "issue MK-42 moved to Done" });
  assert.deepEqual(started.calls.map((call) => call.operation), ["issue", "issueUpdate", "commentCreate"]);
  assert.deepEqual(started.calls[1].variables, { id: "uuid-42", stateId: "s-done" });

  const stateless = await close(closeRoutes({ current: null }));
  assert.deepEqual(stateless.answer, { status: "done", note: "issue MK-42 moved to Done" });
  assert.deepEqual(stateless.calls.map((call) => call.operation), ["issue", "issueUpdate", "commentCreate"]);
});

test("an already completed issue whose comment failed is not notified, and a second close again only comments", async () => {
  const routes = closeRoutes({ current: { name: "Done", type: "completed" }, comment: { errors: true } });
  const first = await close(routes);
  assert.deepEqual(first.answer, { status: "warning", note: "issue MK-42 already Done; comment not posted (the service refused the query)" });
  assert.equal("notified" in first.answer, false);
  const second = await close(routes);
  assert.deepEqual(second.calls.map((call) => call.operation), ["issue", "commentCreate"]);
  assert.ok(!JSON.stringify([first.answer, second.answer]).includes(SECRET_MESSAGE));
});

test("closing a job whose issue is already completed makes no state move, and --steps origin posts nothing more", async (t) => {
  const home = linearHome(t, "linear-already-closed");
  const id = seedDoneJob(home.env, { prompt: `the login breaks, see ${ISSUE_URL}` });
  const fetch = fakeFetch(closeRoutes({ current: { name: "Released", type: "completed" } }));
  const { outcome, row } = await closeLinearJob(home, id, fetch);
  assert.deepEqual(outcome.postClose.steps[0], { name: "origin", status: "done", note: "issue MK-42 already Released; comment posted" });
  assert.equal(JSON.parse(row.close).data.originNotified, true);

  const again = fakeFetch(closeRoutes({ current: { name: "Released", type: "completed" } }));
  const rerun = await runPostCloseSteps({ store: openStore(home.env), id, names: ["origin"], env: home.env, deps: { fetch: again.impl } });
  assert.deepEqual(rerun.steps, [{ name: "origin", status: "done", note: "already notified" }]);
  const all = [...fetch.calls, ...again.calls].map((call) => call.operation);
  assert.equal(all.filter((operation) => operation === "issueUpdate").length, 0);
  assert.equal(all.filter((operation) => operation === "commentCreate").length, 1);
});

test("tracker issues builds the filter from the given fields only and maps the nodes", async () => {
  const node = { identifier: "MK-42", title: "Fix the login", url: ISSUE_URL, priority: 2, priorityLabel: "High", updatedAt: "2026-10-02", state: { name: "Todo", type: "unstarted" }, team: { key: "MK" }, labels: { nodes: [{ name: "bug" }] } };
  const fetch = fakeFetch({ issues: { body: { data: { issues: { nodes: [node], pageInfo: { hasNextPage: true } } } } } });
  const http = httpOf(fetch);
  const answer = await linear.tracker.issues({ team: "MK", project: "Auth", state: "open", limit: 10 }, { connection: RECORD, http });
  assert.deepEqual(answer, {
    items: [{ ref: "MK-42", title: "Fix the login", team: "MK", state: { name: "Todo", type: "unstarted" }, priority: 2, priorityLabel: "High", labels: ["bug"], url: ISSUE_URL, updatedAt: "2026-10-02" }],
    truncated: true,
  });
  await linear.tracker.issues({ state: "closed" }, { connection: RECORD, http });
  await linear.tracker.issues({ state: "all", limit: 50 }, { connection: RECORD, http });
  assert.deepEqual(fetch.calls.map((call) => call.variables), [
    { filter: { team: { key: { eq: "MK" } }, project: { name: { eq: "Auth" } }, state: { type: { nin: ["completed", "canceled"] } } }, first: 10 },
    { filter: { state: { type: { in: ["completed", "canceled"] } } }, first: 25 },
    { filter: {}, first: 50 },
  ]);
  const empty = await linear.tracker.issues({}, { connection: RECORD, http: httpOf(fakeFetch({ issues: { body: { data: { issues: { nodes: [], pageInfo: { hasNextPage: false } } } } } })) });
  assert.deepEqual(empty, { items: [], truncated: false });
  const failed = await linear.tracker.issues({}, { connection: RECORD, http: httpOf(fakeFetch({ issues: { body: { errors: [{ message: SECRET_MESSAGE }] } } })) });
  assert.deepEqual(failed, { detail: "issues not read (the service refused the query)" });
});

test("tracker filters lists the teams and merges their projects by name", async () => {
  const teams = { nodes: [
    { key: "MK", name: "Marketing", projects: { nodes: [{ name: "Auth" }, { name: "Site" }] } },
    { key: "EN", name: "Engineering", projects: { nodes: [{ name: "Auth" }] } },
  ] };
  const answer = await linear.tracker.filters({ connection: RECORD, http: httpOf(fakeFetch({ teams: { body: { data: { teams } } } })) });
  assert.deepEqual(answer, {
    teams: [{ key: "MK", name: "Marketing" }, { key: "EN", name: "Engineering" }],
    projects: [{ name: "Auth", teams: ["MK", "EN"] }, { name: "Site", teams: ["MK"] }],
  });
  const failed = await linear.tracker.filters({ connection: RECORD, http: httpOf(fakeFetch({ teams: { status: 500 } })) });
  assert.deepEqual(failed, { detail: "teams not read (HTTP 500)" });
});
