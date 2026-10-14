import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  NOTHING_REGISTERED,
  breadcrumb,
  buildPatch,
  changedSteps,
  collapsed,
  draftOf,
  entryBadge,
  filterProjects,
  footprintCounters,
  groupByOrg,
  historyProjects,
  integrationsSummary,
  isActive,
  moveNote,
  normalizeKeyInput,
  normalizeProjectsAnswer,
  orgActions,
  pathParts,
  registerErrorText,
  removeMode,
  saveLabel,
  saveOutcome,
  settingControls,
  stepRefusalOf,
  summaryLine,
  toggleValues,
  typedMatches,
} from "../../studio/src/lib/projects.ts";

const PROVIDERS = [
  { kind: "discord", keys: [{ key: "discord.replyToOrigin", type: "boolean", default: true }, { key: "discord.log.connection", type: "connection" }, { key: "discord.log.events", type: "list", values: ["closed", "failed"], default: ["closed", "failed"] }] },
  { kind: "sentry", keys: [{ key: "sentry.onClosed", type: "enum", values: ["resolved", "resolvedInNextRelease"], default: "resolved" }] },
  { kind: "linear", keys: [] },
];

const ORGS = [
  { id: "o1", name: "dlw", key: "DLW", aliases: [], isDefault: false, connections: { discord: ["dlw-log"] }, projects: 2 },
  { id: "o0", name: "default", key: "DE", aliases: [], isDefault: true, connections: {}, projects: 0 },
  { id: "o2", name: "clareza", key: "CL", aliases: [], isDefault: false, connections: {}, projects: 1 },
];

// A project row as the answer carries it, with the fields a test overrides.
function project(overrides = {}) {
  return { id: "p1", name: "api", key: "API", aliases: [], path: "/home/me/code/api", org: "dlw", exists: true, origin: null, integrations: null, footprint: [], runningJob: null, unlinkedByMove: {}, ...overrides };
}

test("folder browser: each entry gets its badge and what a click does; the breadcrumb starts at ~", () => {
  assert.deepEqual(entryBadge({ name: "api", path: "/h/api", git: true }), { kind: "git", label: "git repo", selectable: true, enterable: false });
  assert.deepEqual(entryBadge({ name: "api", path: "/h/api", git: true, registeredAs: { id: "p1", name: "api" } }), { kind: "registered", label: "registered · api", selectable: false, enterable: false });
  assert.deepEqual(entryBadge({ name: "wt", path: "/h/wt", git: true, worktreeOf: { path: "/h/web", project: null } }), { kind: "worktree", label: "linked worktree of web", selectable: true, enterable: false });
  assert.equal(entryBadge({ name: "wt", path: "/h/wt", git: true, worktreeOf: { path: "/h/web", project: "web" } }).selectable, false);
  assert.deepEqual(entryBadge({ name: "docs", path: "/h/docs", git: false }), { kind: "plain", label: "not a git repo", selectable: false, enterable: true });
  assert.deepEqual(breadcrumb("/h/code/api", "/h"), [{ label: "~", path: "/h" }, { label: "code", path: "/h/code" }, { label: "api", path: "/h/code/api" }]);
  assert.deepEqual(breadcrumb("/h", "/h"), [{ label: "~", path: "/h" }]);
});

test("folder browser: every API code maps to its own text, each ending with what to do", () => {
  const codes = ["not-a-git-repo", "already-registered", "name-taken", "name-invalid", "key-taken", "key-invalid", "org-unknown", "outside-home", "refused"];
  const texts = codes.map((code) => registerErrorText(code, { error: "server words" }));
  assert.equal(new Set(texts).size, codes.length);
  for (const text of texts) assert.ok(text.endsWith(NOTHING_REGISTERED), text);
  assert.equal(registerErrorText("brand-new-code", { error: "the server says so" }), `the server says so. ${NOTHING_REGISTERED}`);
  assert.equal(normalizeKeyInput("ab-c12x9"), "ABC12");
});

test("drawer: the steps of a draft come in the server's order, only dirty fields are sent, and the count drives the save button", () => {
  const row = project({ integrations: { discord: { log: { connection: "dlw-log", events: ["closed"] } } } });
  const initial = draftOf(row, PROVIDERS);
  assert.deepEqual(initial.integrations, { "discord.replyToOrigin": "", "discord.log.connection": "dlw-log", "discord.log.events": "closed", "sentry.onClosed": "" });
  assert.deepEqual(changedSteps(initial, initial), []);
  assert.equal(saveLabel([]), "Save 0 changes");
  const draft = { ...initial, path: "/home/me/code/api2", name: "api2", org: "clareza", integrations: { ...initial.integrations, "discord.log.connection": "", "sentry.onClosed": "resolvedInNextRelease", "discord.replyToOrigin": "false" } };
  assert.deepEqual(changedSteps(initial, draft), ["name", "org", "path", "integrations"]);
  assert.equal(saveLabel(changedSteps(initial, draft)), "Save 4 changes");
  const patch = buildPatch(initial, draft);
  assert.deepEqual(Object.keys(patch), ["name", "org", "path", "integrations"]);
  assert.deepEqual(patch.integrations, { set: { "discord.replyToOrigin": "false", "sentry.onClosed": "resolvedInNextRelease" }, unset: ["discord.log.connection"] });
});

test("drawer: a refused org step keeps name and key applied and marks path and integrations unapplied", () => {
  const steps = ["name", "key", "org", "path", "integrations"];
  const refusal = stepRefusalOf({ code: "org-unknown", step: "org", reason: "unknown org `x`", applied: ["name", "key"], error: "unknown org `x`" });
  assert.deepEqual(saveOutcome(steps, refusal), { applied: ["name", "key"], refused: { step: "org", reason: "unknown org `x`" }, unapplied: ["path", "integrations"] });
  assert.deepEqual(saveOutcome(steps, null), { applied: steps, refused: null, unapplied: [] });
  assert.equal(stepRefusalOf({ error: "not a step" }), null);
});

test("drawer: the move note reads the server's preview, and controls follow each setting's declared type", () => {
  const row = project({ unlinkedByMove: { o2: ["discord.log.connection"] } });
  assert.match(moveNote(row, ORGS, "clareza"), /unsets discord\.log\.connection/);
  assert.equal(moveNote(row, ORGS, "dlw"), null);
  assert.equal(moveNote(row, ORGS, "default"), null);
  const controls = settingControls(PROVIDERS, ORGS[0]);
  assert.deepEqual(controls.map((provider) => [provider.kind, provider.disabled, provider.controls.map((control) => control.control)]), [["discord", false, ["switch", "connection", "checkboxes"]], ["sentry", false, ["select"]], ["linear", true, []]]);
  assert.deepEqual(controls[0].controls[1].options, ["dlw-log"]);
  const fresh = settingControls([{ kind: "pager", keys: [{ key: "pager.level", type: "enum", values: ["low", "high"] }] }], ORGS[0]);
  assert.deepEqual(fresh[0].controls[0], { key: "pager.level", label: "level", control: "select", options: ["low", "high"], defaultText: "" });
});

test("drawer: a provider is not configured until enabled, only enabled where the org has the connection, and Enable stores the defaults", () => {
  const withCardinality = [{ ...PROVIDERS[0], label: "Discord", cardinality: "many" }, { ...PROVIDERS[1], label: "Sentry", cardinality: "one" }, PROVIDERS[2]];
  const orgSlot = { ...ORGS[0], connections: { discord: ["dlw-log"], sentry: "sentry-dlw" } };
  const [discord, sentry] = settingControls(withCardinality, orgSlot);
  assert.deepEqual([discord.available, sentry.available], [true, true]);
  assert.deepEqual(settingControls(withCardinality, ORGS[2]).map((provider) => provider.available), [false, false, true]);
  const initial = draftOf(project(), withCardinality);
  assert.equal(isActive(sentry, initial.integrations), false);
  assert.deepEqual(integrationsSummary(project(), withCardinality).map((line) => line.text), ["discord · not configured", "sentry · not configured"]);
  assert.deepEqual(changedSteps(initial, { ...initial }), []);
  const enabled = { ...initial, integrations: { ...initial.integrations, ...toggleValues(sentry, true) } };
  assert.equal(isActive(sentry, enabled.integrations), true);
  assert.deepEqual(buildPatch(initial, enabled).integrations, { set: { "sentry.onClosed": "resolved" }, unset: [] });
  const discordOn = { ...initial, integrations: { ...initial.integrations, ...toggleValues(discord, true) } };
  assert.deepEqual(buildPatch(initial, discordOn).integrations, { set: { "discord.replyToOrigin": "true", "discord.log.events": "closed,failed" }, unset: [] });
  const stored = draftOf(project({ integrations: { sentry: { onClosed: "resolved" } } }), withCardinality);
  const disabled = { ...stored, integrations: { ...stored.integrations, ...toggleValues(sentry, false) } };
  assert.deepEqual(buildPatch(stored, disabled).integrations, { set: {}, unset: ["sentry.onClosed"] });
});

test("remove: a running job disables it, rows need the exact typed name, and the counters sum to the footprint", () => {
  const footprint = [{ table: "jobs", total: 3 }, { table: "decisions", total: 2 }, { table: "lessons", total: 1 }, { table: "memory", total: 4 }, { table: "job_attempts", total: 3 }, { table: "project_key_aliases", total: 1 }];
  const counters = footprintCounters(footprint);
  assert.deepEqual(counters, { jobs: 3, decisions: 2, lessons: 1, memoryRows: 8, total: 14 });
  assert.equal(counters.total, footprint.reduce((sum, entry) => sum + entry.total, 0));
  assert.deepEqual(removeMode(project({ runningJob: { ref: "J-12" }, footprint })), { kind: "running", text: "J-12 is running on this project — cancel it first." });
  assert.deepEqual(removeMode(project({ footprint })), { kind: "typed", rows: 14 });
  assert.deepEqual(removeMode(project()), { kind: "plain" });
  assert.equal(typedMatches("api", "api"), true);
  assert.equal(typedMatches("API", "api"), false);
  assert.equal(typedMatches("api ", "api"), false);
});

test("list: filters, org order, collapse, history, summary and the org menu's disable reasons", () => {
  const rows = [project(), project({ id: "p2", name: "web", exists: false }), project({ id: "p3", name: "old", path: null, org: "clareza", footprint: [{ table: "jobs", total: 1 }] }), project({ id: "p4", name: "bare", path: null })];
  assert.deepEqual(filterProjects(rows, "path-missing").map((row) => row.name), ["web"]);
  assert.deepEqual(filterProjects(rows, "no-path").map((row) => row.name), ["old", "bare"]);
  assert.deepEqual(historyProjects(rows).map((row) => row.name), ["old"]);
  assert.deepEqual(groupByOrg(rows, ORGS).map((group) => [group.org.name, group.projects.map((row) => row.name)]), [["default", []], ["dlw", ["api", "web", "bare"]], ["clareza", []]]);
  assert.equal(summaryLine(rows, ORGS), "4 projects in 3 orgs · 1 path missing · 1 known from history");
  assert.deepEqual(collapsed([1, 2, 3, 4, 5, 6, 7], false), { shown: [1, 2, 3, 4, 5], hidden: 2 });
  assert.deepEqual(collapsed([1, 2, 3, 4, 5, 6, 7], true).hidden, 0);
  assert.deepEqual(pathParts("/home/me/code/api"), { head: "/home/me/code/", folder: "api" });
  assert.deepEqual(orgActions(ORGS[1]), { setDefault: { disabled: true }, remove: { disabled: true, reason: "it is the default org" } });
  assert.deepEqual(orgActions(ORGS[0]).remove, { disabled: true, reason: "it owns 2 projects" });
  assert.deepEqual(orgActions({ ...ORGS[2], projects: 0 }).remove, { disabled: false, reason: null });
});

test("a hostile answer is coerced: rows without an id are dropped, a string boolean is not `exists`", () => {
  const answer = normalizeProjectsAnswer({ projects: [{ id: "p1", name: "api", exists: "true", footprint: [{ table: "jobs", total: 2 }, { total: 1 }] }, { name: "no-id" }], providers: "nope" });
  assert.equal(answer.projects.length, 1);
  assert.deepEqual([answer.projects[0].exists, answer.projects[0].footprint, answer.providers], [false, [{ table: "jobs", total: 2 }], []]);
});

test("the settings nav links the Projects & orgs section and the page mounts it", () => {
  const sections = readFileSync(new URL("../../studio/src/components/settings/SettingsSections.tsx", import.meta.url), "utf8");
  const page = readFileSync(new URL("../../studio/src/routes/SettingsPage.tsx", import.meta.url), "utf8");
  assert.match(sections, /hash: "#projects", label: "Projects & orgs"/);
  assert.doesNotMatch(sections, /LATER_SECTIONS = \[[^\]]*Projects/);
  assert.match(page, /<section id="projects"[^>]*>\s*<ProjectsSection \/>/);
});
