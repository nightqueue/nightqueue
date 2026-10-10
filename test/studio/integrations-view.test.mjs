import assert from "node:assert/strict";
import { test } from "node:test";
import {
  addConnectionErrorView,
  addErrorView,
  agoLabel,
  ambientLine,
  ambientTool,
  canAddConnection,
  connectionsOfKind,
  destinationOptions,
  destinationSummary,
  groupProjectsByOrg,
  joinLabels,
  lastTestLabel,
  linkCta,
  linkPlan,
  moduleState,
  normalizeView,
  noticeLabel,
  placeLabel,
  refusalOf,
  remainingOrgs,
  toggledOrg,
  toggledProject,
  usedByNames,
  webhookLine,
  whenLabel,
} from "../../studio/src/lib/integrations.ts";

const NOW = Date.parse("2026-10-09T14:00:00.000Z");

// A Discord connection row of the view.
function discordRow(name, orgs, fields = {}) {
  return { id: name, name, type: "discord", present: true, scope: "org", orgs, lastTest: null, usedBy: [], channelId: "1234567890123", serverId: "9876543210987", webhookName: `${name}-hook`, ...fields };
}

// A project row of the view.
function project(id, org, destination = null) {
  return { id, name: id, org, destination, lastNotice: null };
}

// The module cards the runtime answers, in card order: Discord, Linear, GitHub, Sentry.
function sampleModules() {
  const add = (secretField, secretLabel, fields = []) => ({ secretField, secretLabel, nameRequired: secretField === "url", orgRequired: secretField !== "apiKey", fields });
  return [
    { kind: "discord", label: "Discord", description: "posts", place: "org", cardinality: "many", add: add("url", "webhook URL"), ambient: null },
    { kind: "linear", label: "Linear", description: "tickets", place: "home", cardinality: "one", add: add("apiKey", "API key"), ambient: null },
    { kind: "github", label: "GitHub", description: "gh", place: "machine", cardinality: null, add: null, ambient: { statusPath: "/api/integrations/github/status", command: "gh auth login --web" } },
    { kind: "sentry", label: "Sentry", description: "issues", place: "org", cardinality: "one", add: add("token", "auth token", [{ name: "org", format: "a slug", required: true, default: null }]), ambient: null },
  ];
}

// The view of a home with orgs dlw (3 projects), clareza (2) and nightqueue (1), and two Discord connections plus a Sentry one.
function sampleView() {
  return normalizeView({
    orgs: [{ id: "o1", name: "dlw", projects: 3 }, { id: "o2", name: "clareza", projects: 2 }, { id: "o3", name: "nightqueue", projects: 1 }],
    connections: [
      discordRow("dlw-log", ["dlw"], { usedBy: ["a1", "a2"] }),
      discordRow("ops", ["dlw", "clareza"], { usedBy: ["c1"] }),
      { id: "sentry-dlw", name: "sentry-dlw", type: "sentry", present: true, scope: "org", orgs: ["dlw"], lastTest: null, usedBy: ["a1", "a2", "a3"] },
    ],
    projects: [project("a1", "dlw", "dlw-log"), project("a2", "dlw", "dlw-log"), project("a3", "dlw", "ops"), project("c1", "clareza", "ops"), project("c2", "clareza"), project("n1", "nightqueue", "ghost")],
    modules: sampleModules(),
  });
}

// A module card of the sample by kind.
function moduleOf(kind) {
  return sampleModules().find((module) => module.kind === kind);
}

// An ApiError-like failure with a status and a parsed body.
function apiError(status, body) {
  return Object.assign(new Error(typeof body.error === "string" ? body.error : `${status}`), { status, body });
}

test("normalizeView turns a hostile payload into empty lists instead of throwing", () => {
  assert.deepEqual(normalizeView(null), { orgs: [], connections: [], projects: [], modules: [] });
  assert.deepEqual(normalizeView({ orgs: "x", connections: [{ name: "a", orgs: "dlw", usedBy: null }], projects: {}, modules: "x" }), { orgs: [], connections: [{ name: "a", orgs: [], usedBy: [] }], projects: [], modules: [] });
  const modules = normalizeView({ modules: [null, { kind: "x" }, { kind: "y", label: "Y", place: "moon" }, { kind: "z", label: "Z", place: "org", add: { secretField: "k", fields: "bad" } }] }).modules;
  assert.deepEqual(modules.map((module) => [module.kind, module.add?.fields, module.ambient, module.description]), [["z", [], null, ""]]);
});

test("with zero connections the view still lists the four modules in card order, each one not connected", () => {
  const view = normalizeView({ orgs: [], connections: [], projects: [], modules: sampleModules() });
  assert.deepEqual(view.modules.map((module) => module.label), ["Discord", "Linear", "GitHub", "Sentry"]);
  assert.deepEqual(view.modules.filter((module) => module.add).map((module) => moduleState(module, view)), ["not connected", "not connected", "not connected"]);
  assert.equal(joinLabels(view.modules), "Discord, Linear, GitHub and Sentry");
  assert.equal(joinLabels([]), "");
});

test("connections group by module kind, and the state counts them per kind", () => {
  const view = sampleView();
  assert.deepEqual(connectionsOfKind(view, "discord").map((row) => row.name), ["dlw-log", "ops"]);
  assert.deepEqual(connectionsOfKind(view, "sentry").map((row) => row.name), ["sentry-dlw"]);
  assert.deepEqual(connectionsOfKind(view, "github"), []);
  assert.equal(moduleState(moduleOf("discord"), view), "2 connected");
  assert.equal(moduleState(moduleOf("sentry"), view), "connected in 1 org");
  assert.equal(moduleState(moduleOf("linear"), view), "not connected");
  const linked = normalizeView({ ...view, connections: [{ id: "linear", name: "linear", type: "linear", scope: "home", orgs: [], usedBy: [] }] });
  assert.equal(moduleState(moduleOf("linear"), linked), "connected");
  assert.deepEqual([canAddConnection(moduleOf("linear"), view), canAddConnection(moduleOf("linear"), linked)], [true, false]);
  assert.deepEqual([canAddConnection(moduleOf("discord"), view), canAddConnection(moduleOf("sentry"), view), canAddConnection(moduleOf("github"), view)], [true, true, false]);
  assert.deepEqual([placeLabel("machine"), placeLabel("home"), placeLabel("org")], ["this machine", "whole home", "per org"]);
});

test("the ambient line reads the account, not authenticated, or the tool missing; the tool comes from the connect command", () => {
  const github = moduleOf("github");
  const tool = ambientTool(github);
  assert.equal(tool, "gh");
  const status = (fields) => ({ kind: "github", installed: true, authenticated: true, login: "octo", host: "github.com", checkedAt: null, ...fields });
  assert.equal(ambientLine(status({}), tool), "connected as octo · github.com");
  assert.equal(ambientLine(status({ host: null }), tool), "connected as octo");
  assert.equal(ambientLine(status({ login: null }), tool), "connected");
  assert.equal(ambientLine(status({ authenticated: false }), tool), "not authenticated");
  assert.equal(ambientLine(status({ authenticated: null, login: null, host: null }), tool), "status unavailable");
  assert.equal(ambientLine(status({ installed: false, authenticated: false }), tool), "gh not installed");
  assert.equal(ambientLine(null, tool), "checking…");
  assert.equal(ambientTool({ ...github, ambient: null }), "GitHub");
});

test("a generic add failure maps each refusal code to its title and field, without the repeated nothing-saved line", () => {
  const sentry = moduleOf("sentry");
  const linear = moduleOf("linear");
  const invalid = addConnectionErrorView(apiError(422, { code: "invalid-token", error: "Invalid auth token: too long. Nothing was saved." }), sentry);
  assert.deepEqual(invalid, { title: "Invalid auth token", body: "Invalid auth token: too long.", field: "secret" });
  const refused = addConnectionErrorView(apiError(502, { code: "refused", status: 401, reason: "Sentry answered 401." }), sentry);
  assert.deepEqual(refused, { title: "Sentry refused the auth token", body: "Sentry answered 401.", field: "secret" });
  const duplicate = addConnectionErrorView(apiError(409, { code: "duplicate", error: "A home has one linear connection: `linear`; remove it first. Nothing was saved." }), linear);
  assert.deepEqual(duplicate, { title: "Linear is already connected", body: "A home has one linear connection: `linear`; remove it first.", field: null });
  assert.equal(addConnectionErrorView(apiError(409, { code: "duplicate", error: "x" }), moduleOf("discord")).field, "name");
  const occupied = addConnectionErrorView(apiError(409, { code: "occupied", org: "dlw", connection: "sentry-dlw" }), sentry);
  assert.deepEqual([occupied.title, occupied.field], ["This org already has a Sentry connection", "org"]);
  assert.match(occupied.body, /held by “sentry-dlw”/);
  const ambient = addConnectionErrorView(apiError(409, { code: "ambient", error: "github is not a stored connection: run `gh auth login`" }), moduleOf("github"));
  assert.deepEqual([ambient.title, ambient.field], ["GitHub is not added here", null]);
  assert.deepEqual(addConnectionErrorView(new Error("offline"), sentry), { title: "Couldn't save the connection", body: "offline", field: null });
});

test("the webhook line shows the webhook name and short ids, with the full ids as its title", () => {
  const line = webhookLine(sampleView().connections[0]);
  assert.equal(line.text, "webhook dlw-log-hook · channel …890123 · server …210987");
  assert.equal(line.title, "channel 1234567890123 · server 9876543210987");
  assert.equal(webhookLine(discordRow("x", [], { webhookName: null, channelId: null })).text, "channel ? · server …210987");
});

test("destination options mark the not-allowed connections, keep a missing stored one, and end with no destination", () => {
  const view = sampleView();
  const options = (id) => destinationOptions(view, view.projects.find((row) => row.id === id)).map((option) => option.label);
  assert.deepEqual(options("c2"), ["dlw-log · dlw-log-hook (not allowed)", "ops · ops-hook", "— no destination —"]);
  assert.deepEqual(options("n1"), ["ghost (missing)", "dlw-log · dlw-log-hook (not allowed)", "ops · ops-hook (not allowed)", "— no destination —"]);
});

test("projects group by org in registry order with their allowed connections, and the summary counts destinations", () => {
  const view = sampleView();
  assert.deepEqual(groupProjectsByOrg(view).map((group) => group.label), [
    "org dlw · 3 projects · allowed connections: dlw-log, ops",
    "org clareza · 2 projects · allowed connections: ops",
    "org nightqueue · 1 project · no allowed connection",
  ]);
  assert.equal(destinationSummary(view), "5 of 6 projects have a destination");
  assert.deepEqual(usedByNames(view, view.connections[0]), ["a1", "a2"]);
  assert.deepEqual(remainingOrgs(view, view.connections[0]), ["clareza", "nightqueue"]);
});

test("the link plan counts only newly checked projects, locks the linked ones, and flags switches and not-allowed orgs", () => {
  const view = sampleView();
  const dlwLog = view.connections[0];
  const none = linkPlan(view, dlwLog, new Set());
  assert.deepEqual(none.groups.map((group) => [group.org, group.state, group.free]), [["dlw", "none", ["a3"]]]);
  assert.deepEqual([none.newIds, none.alreadyCount, none.switching, none.notAllowed], [[], 2, [], ["clareza", "nightqueue"]]);
  const whole = toggledOrg(new Set(), none.groups[0]);
  const plan = linkPlan(view, dlwLog, whole);
  assert.deepEqual([plan.groups[0].state, plan.newIds, plan.switching], ["all", ["a3"], ["a3"]]);
  assert.deepEqual([...toggledOrg(whole, plan.groups[0])], []);
  assert.deepEqual([...toggledProject(new Set(["a3"]), "a3")], []);
  const ops = linkPlan(view, view.connections[1], new Set(["a1"]));
  assert.deepEqual(ops.groups.map((group) => [group.org, group.state]), [["dlw", "some"], ["clareza", "none"]]);
  assert.deepEqual([linkCta(0), linkCta(1), linkCta(7)], ["Select projects", "Link 1 project", "Link 7 projects"]);
});

test("time labels are UTC and fixed against a given now; an unreadable time never throws", () => {
  assert.equal(agoLabel("2026-10-09T13:59:30.000Z", NOW), "just now");
  assert.equal(agoLabel("2026-10-09T13:20:00.000Z", NOW), "40 min ago");
  assert.equal(agoLabel("2026-10-09T12:00:00.000Z", NOW), "2 h ago");
  assert.equal(agoLabel("2026-10-06T12:00:00.000Z", NOW), "3 days ago");
  assert.equal(whenLabel("2026-10-09T09:05:00.000Z", NOW), "today 09:05");
  assert.equal(whenLabel("2026-10-08T18:02:00.000Z", NOW), "yesterday 18:02");
  assert.equal(whenLabel("2026-10-06T11:40:00.000Z", NOW), "Oct 6 11:40");
  assert.equal(whenLabel("2025-09-29T11:40:00.000Z", NOW), "Sep 29 2025");
  assert.equal(whenLabel("not a date", NOW), "at an unknown time");
  assert.equal(agoLabel(null, NOW), "at an unknown time");
});

test("the last test pill and the last notice read ok, failed or never", () => {
  assert.deepEqual(lastTestLabel(null, NOW), { tone: "off", text: "never tested" });
  assert.deepEqual(lastTestLabel({ ok: true, at: "2026-10-09T13:59:59.000Z", status: 200 }, NOW), { tone: "ok", text: "ok · just now" });
  assert.deepEqual(lastTestLabel({ ok: false, at: "2026-10-09T12:00:00.000Z", status: 404, reason: "x" }, NOW), { tone: "err", text: "failed · 2 h ago" });
  assert.equal(noticeLabel(null, NOW), null);
  assert.deepEqual(noticeLabel({ jobRef: "J-152", at: "2026-10-08T18:02:00.000Z", ok: true, note: null }, NOW), { tone: "ok", text: "J-152 closed · yesterday 18:02" });
  assert.deepEqual(noticeLabel({ jobRef: "J-153", at: "2026-10-09T09:00:00.000Z", ok: false, note: "discord: refused" }, NOW), { tone: "err", text: "failed · J-153 · today 09:00" });
});

test("an add failure marks the field its code names, and a 403 org refusal is read from the error body only", () => {
  assert.deepEqual([addErrorView(apiError(422, { code: "invalid-url" }), "dlw-log").title, addErrorView(apiError(422, { code: "invalid-url" }), "dlw-log").field], ["Invalid URL", "url"]);
  const refused = addErrorView(apiError(502, { code: "refused", status: 404, reason: "Discord answered 404: the webhook was deleted on the server." }), "dlw-log");
  assert.equal(refused.field, "url");
  assert.match(refused.body, /^Discord answered 404: the webhook was deleted on the server\. Create a new one/);
  const duplicate = addErrorView(apiError(409, { code: "duplicate", orgs: ["dlw"] }), "dlw-log");
  assert.deepEqual([duplicate.field, duplicate.body], ["name", "There is a “dlw-log” connection in org dlw. Pick another name or remove the old one first."]);
  assert.deepEqual(addErrorView(new Error("offline"), "x"), { title: "Couldn't save the connection", body: "offline", field: null });
  assert.deepEqual(refusalOf(apiError(403, { code: "not-allowed-for-org", org: "clareza", connectionId: "dlw-log" })), { org: "clareza", connectionId: "dlw-log" });
  assert.equal(refusalOf(apiError(403, { code: "other" })), null);
  assert.equal(refusalOf(apiError(400, { code: "not-allowed-for-org", org: "clareza", connectionId: "dlw-log" })), null);
  assert.equal(refusalOf("boom"), null);
});
