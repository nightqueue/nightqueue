import assert from "node:assert/strict";
import { test } from "node:test";
import {
  connectCommand,
  DEFAULT_TRACKER_PREFS,
  groupIssues,
  isOption,
  issueDraft,
  labelTint,
  parseTrackerPrefs,
  projectOptions,
  serializeTrackerPrefs,
  teamOptions,
  trackerLabel,
} from "../../studio/src/lib/tracker.ts";

// One tracker item as `tracker_issues` answers it, with the given fields over the defaults.
function item(ref, fields = {}) {
  return { ref, title: `title ${ref}`, team: "MK", state: { name: "Todo", type: "unstarted" }, priority: 0, priorityLabel: "No priority", labels: [], url: `https://linear.app/acme/issue/${ref}`, updatedAt: "2026-10-01T00:00:00.000Z", ...fields };
}

const FILTERS = {
  teams: [
    { key: "MK", name: "Marketing" },
    { key: "EN", name: "Engineering" },
  ],
  projects: [
    { name: "Launch", teams: ["MK"] },
    { name: "Core", teams: ["EN"] },
    { name: "Shared", teams: ["MK", "EN"] },
  ],
};

const MIXED = [
  item("MK-1", { state: { name: "Backlog", type: "backlog" } }),
  item("MK-2", { state: { name: "Triage", type: "triage" } }),
  item("MK-3", { state: { name: "Todo", type: "unstarted" } }),
  item("MK-4", { state: { name: "In Progress", type: "started" } }),
  item("MK-5", { state: { name: "In Code REVIEW", type: "started" } }),
  item("MK-6", { state: { name: "Canceled", type: "canceled" } }),
  item("MK-7", { state: { name: "Done", type: "completed" } }),
];

test("groupIssues maps the states to groups: a started state named review is In Review, triage is Backlog", () => {
  const groups = groupIssues(MIXED, "all");
  const refs = Object.fromEntries(groups.map((group) => [group.label, group.items.map((issue) => issue.ref)]));
  assert.deepEqual(refs, { "In Review": ["MK-5"], "In Progress": ["MK-4"], Todo: ["MK-3"], Backlog: ["MK-1", "MK-2"], Done: ["MK-7"], Canceled: ["MK-6"] });
});

test("groupIssues keeps the fixed group order and hides the empty groups", () => {
  assert.deepEqual(groupIssues(MIXED, "open").map((group) => group.label), ["In Review", "In Progress", "Todo", "Backlog"]);
  assert.deepEqual(groupIssues(MIXED.slice(2, 4), "open").map((group) => group.label), ["In Progress", "Todo"]);
});

test("groupIssues shows Done then Canceled last under all and never under open", () => {
  assert.deepEqual(groupIssues(MIXED, "all").map((group) => group.label).slice(-2), ["Done", "Canceled"]);
  assert.equal(groupIssues(MIXED, "open").some((group) => group.label === "Done" || group.label === "Canceled"), false);
});

test("groupIssues orders a group by priority urgent to low then no priority, newest update first on a tie", () => {
  const items = [
    item("MK-1", { priority: 0, updatedAt: "2026-10-05T00:00:00.000Z" }),
    item("MK-2", { priority: 3 }),
    item("MK-3", { priority: 1, updatedAt: "2026-10-01T00:00:00.000Z" }),
    item("MK-4", { priority: 1, updatedAt: "2026-10-03T00:00:00.000Z" }),
    item("MK-5", { priority: 4 }),
    item("MK-6", { priority: 2 }),
  ];
  assert.deepEqual(groupIssues(items, "open")[0].items.map((issue) => issue.ref), ["MK-4", "MK-3", "MK-6", "MK-2", "MK-5", "MK-1"]);
});

test("labelTint tints a hex color and leaves a missing or malformed one neutral", () => {
  const bug = labelTint("#eb5757");
  assert.ok(bug.borderColor.includes("#eb5757") && bug.backgroundColor.includes("#eb5757") && bug.color.includes("#eb5757"));
  for (const color of [null, undefined, "", "red", "#fff", "#eb5757; x", 12]) assert.equal(labelTint(color), undefined, String(color));
});

test("groupIssues keeps each item's labelDetails with its color", () => {
  const labelDetails = [{ name: "Bug", color: "#eb5757" }, { name: "plain", color: null }];
  const groups = groupIssues([item("MK-9", { labels: ["Bug", "plain"], labelDetails })], "open");
  assert.deepEqual(groups[0].items[0].labelDetails, labelDetails);
});

test("groupIssues of a non-list answers no groups", () => {
  assert.deepEqual(groupIssues(null, "all"), []);
});

test("teamOptions and projectOptions list every choice with the all option first, projects narrowed by team", () => {
  assert.deepEqual(teamOptions(FILTERS).map((option) => option.value), ["", "MK", "EN"]);
  assert.deepEqual(projectOptions(FILTERS, "").map((option) => option.value), ["", "Launch", "Core", "Shared"]);
  assert.deepEqual(projectOptions(FILTERS, "MK").map((option) => option.value), ["", "Launch", "Shared"]);
  assert.deepEqual(teamOptions(null), [{ value: "", label: "All teams" }]);
  assert.equal(isOption(projectOptions(FILTERS, "EN"), "Launch"), false);
  assert.equal(isOption(projectOptions(FILTERS, "EN"), ""), true);
});

test("issueDraft prefills the title and URL and carries the explicit origin", () => {
  const draft = issueDraft(item("MK-42", { title: "Fix the signup" }), "linear");
  assert.equal(draft.text, "Fix the signup\n\nhttps://linear.app/acme/issue/MK-42\n\n");
  assert.deepEqual(draft.origin, [{ kind: "linear", ref: "MK-42" }]);
  assert.equal(draft.originUrl, "https://linear.app/acme/issue/MK-42");
  assert.deepEqual(issueDraft(item("MK-43", { url: null }), "linear"), { text: "title MK-43\n\n", origin: [{ kind: "linear", ref: "MK-43" }], originUrl: null });
});

test("tracker prefs round-trip and fall back to the defaults on unreadable text", () => {
  const prefs = { team: "MK", project: "Launch", view: "all" };
  assert.deepEqual(parseTrackerPrefs(serializeTrackerPrefs(prefs)), prefs);
  assert.deepEqual(parseTrackerPrefs(null), DEFAULT_TRACKER_PREFS);
  assert.deepEqual(parseTrackerPrefs("{not json"), DEFAULT_TRACKER_PREFS);
  assert.deepEqual(parseTrackerPrefs("null"), DEFAULT_TRACKER_PREFS);
  assert.deepEqual(parseTrackerPrefs('{"team":4,"view":"closed"}'), DEFAULT_TRACKER_PREFS);
});

test("trackerLabel and connectCommand name the provider from its kind", () => {
  assert.equal(trackerLabel("linear"), "Linear");
  assert.equal(trackerLabel(null), "an issue tracker");
  assert.equal(connectCommand("linear"), 'echo "$LINEAR_API_KEY" | nightqueue connection add linear --type linear');
});
