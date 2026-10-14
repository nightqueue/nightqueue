import type { JobOrigin, TrackerFilters, TrackerItem } from "./types";

export type TrackerView = "open" | "all";

export interface TrackerPrefs {
  team: string;
  project: string;
  view: TrackerView;
}

export interface IssueDraft {
  text: string;
  origin: JobOrigin[];
  originUrl: string | null;
}

export interface FilterOption {
  value: string;
  label: string;
}

export const DEFAULT_TRACKER_PREFS: TrackerPrefs = { team: "", project: "", view: "open" };

const NO_PRIORITY_RANK = 5;

export interface IssueGroup {
  key: string;
  label: string;
  items: TrackerItem[];
}

const OPEN_GROUPS = [
  { key: "review", label: "In Review" },
  { key: "progress", label: "In Progress" },
  { key: "todo", label: "Todo" },
  { key: "backlog", label: "Backlog" },
];

const CLOSED_GROUPS = [
  { key: "done", label: "Done" },
  { key: "canceled", label: "Canceled" },
];

// The key of the status group an issue belongs to; a state of an unknown type falls in Backlog.
function groupKey(item: TrackerItem): string {
  const type = item.state?.type ?? "";
  if (type === "started") return /review/i.test(item.state?.name ?? "") ? "review" : "progress";
  if (type === "unstarted") return "todo";
  if (type === "completed") return "done";
  if (type === "canceled") return "canceled";
  return "backlog";
}

// The sort rank of a priority: urgent (1) to low (4) first, no priority (0 or unknown) last.
function priorityRank(priority: number): number {
  return Number.isInteger(priority) && priority >= 1 && priority <= 4 ? priority : NO_PRIORITY_RANK;
}

// The time of the last update in milliseconds, 0 when it is missing or unreadable.
function updatedTime(item: TrackerItem): number {
  const time = Date.parse(item.updatedAt ?? "");
  return Number.isFinite(time) ? time : 0;
}

// Orders open issues by priority, then the most recently updated first.
function byPriorityThenUpdate(a: TrackerItem, b: TrackerItem): number {
  return priorityRank(a.priority) - priorityRank(b.priority) || updatedTime(b) - updatedTime(a);
}

// The non-empty status groups in the fixed order, Done and Canceled last and only under the all view; each sorted by priority then newest update.
export function groupIssues(items: TrackerItem[], view: TrackerView): IssueGroup[] {
  const list = Array.isArray(items) ? items : [];
  const shown = view === "all" ? [...OPEN_GROUPS, ...CLOSED_GROUPS] : OPEN_GROUPS;
  return shown
    .map((group) => ({ ...group, items: list.filter((item) => groupKey(item) === group.key).sort(byPriorityThenUpdate) }))
    .filter((group) => group.items.length > 0);
}

// The team choices of the filter, "all teams" first.
export function teamOptions(filters: TrackerFilters | null): FilterOption[] {
  const teams = Array.isArray(filters?.teams) ? filters.teams : [];
  return [{ value: "", label: "All teams" }, ...teams.map((team) => ({ value: team.key, label: `${team.key} · ${team.name}` }))];
}

// The project choices of the filter, limited to the chosen team's projects, "all projects" first.
export function projectOptions(filters: TrackerFilters | null, team: string): FilterOption[] {
  const projects = Array.isArray(filters?.projects) ? filters.projects : [];
  const shown = team ? projects.filter((project) => Array.isArray(project.teams) && project.teams.includes(team)) : projects;
  return [{ value: "", label: "All projects" }, ...shown.map((project) => ({ value: project.name, label: project.name }))];
}

// Whether a filter value is still one of the options, the empty "all" value always being one.
export function isOption(options: FilterOption[], value: string): boolean {
  return options.some((option) => option.value === value);
}

// The Add job drawer content for an issue: its title and URL as the brief, and the explicit origin.
export function issueDraft(item: TrackerItem, kind: string): IssueDraft {
  const url = item.url?.trim() || null;
  const text = url ? `${item.title}\n\n${url}\n\n` : `${item.title}\n\n`;
  return { text, origin: [{ kind, ref: item.ref }], originUrl: url };
}

// The service name of a tracker kind, as a sentence shows it.
export function trackerLabel(kind: string | null): string {
  return kind ? kind.charAt(0).toUpperCase() + kind.slice(1) : "an issue tracker";
}

// The command that stores the home's connection of a tracker kind.
export function connectCommand(kind: string): string {
  return `echo "$${kind.toUpperCase()}_API_KEY" | nightqueue connection add ${kind} --type ${kind}`;
}

// A saved text field, or the empty "all" value when it is not text.
function textField(value: unknown): string {
  return typeof value === "string" ? value : "";
}

// The tracker card preferences read from their saved text; anything unreadable gives the defaults.
export function parseTrackerPrefs(raw: string | null): TrackerPrefs {
  if (!raw) return DEFAULT_TRACKER_PREFS;
  try {
    const saved = JSON.parse(raw) as Record<string, unknown> | null;
    if (!saved || typeof saved !== "object") return DEFAULT_TRACKER_PREFS;
    return { team: textField(saved.team), project: textField(saved.project), view: saved.view === "all" ? "all" : "open" };
  } catch {
    return DEFAULT_TRACKER_PREFS;
  }
}

// The saved text of the tracker card preferences.
export function serializeTrackerPrefs(prefs: TrackerPrefs): string {
  return JSON.stringify({ team: prefs.team, project: prefs.project, view: prefs.view });
}
