import assert from "node:assert/strict";
import { test } from "node:test";
import {
  connectCommand,
  DEFAULT_TRACKER_PREFS,
  groupIssues,
  isOption,
  issueDraft,
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

test("groupIssues puts open issues first by priority 1-4 then no priority, newest update first within a priority", () => {
  const items = [
    item("MK-1", { priority: 0, updatedAt: "2026-10-05T00:00:00.000Z" }),
    item("MK-2", { priority: 3 }),
    item("MK-3", { priority: 1, updatedAt: "2026-10-01T00:00:00.000Z" }),
    item("MK-4", { priority: 1, updatedAt: "2026-10-03T00:00:00.000Z" }),
    item("MK-5", { state: { name: "Done", type: "completed" }, updatedAt: "2026-10-02T00:00:00.000Z" }),
    item("MK-6", { state: { name: "Canceled", type: "canceled" }, updatedAt: "2026-10-04T00:00:00.000Z" }),
    item("MK-7", { state: { name: "In Progress", type: "started" }, priority: 2 }),
  ];
  const { open, closed } = groupIssues(items);
  assert.deepEqual(open.map((issue) => issue.ref), ["MK-4", "MK-3", "MK-7", "MK-2", "MK-1"]);
  assert.deepEqual(closed.map((issue) => issue.ref), ["MK-6", "MK-5"]);
});

test("groupIssues of a non-list answers two empty groups", () => {
  assert.deepEqual(groupIssues(null), { open: [], closed: [] });
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
  assert.deepEqual(draft.origin, { kind: "linear", ref: "MK-42" });
  assert.equal(draft.originUrl, "https://linear.app/acme/issue/MK-42");
  assert.deepEqual(issueDraft(item("MK-43", { url: null }), "linear"), { text: "title MK-43\n\n", origin: { kind: "linear", ref: "MK-43" }, originUrl: null });
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
