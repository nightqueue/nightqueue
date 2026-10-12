import type { DirEntry, FootprintEntry, Integrations, OrgRow, ProjectsAnswer, ProviderSettingKey, ProviderSettings, SettingsProject, StepRefusal } from "./types";

export const PROJECT_STEPS = ["name", "key", "org", "path", "integrations"] as const;

export type ProjectStep = (typeof PROJECT_STEPS)[number];

export type ProjectFilter = "all" | "path-missing" | "no-path";

export const COLLAPSE_AFTER = 5;

export const KEY_MAX = 5;

export const NOTHING_REGISTERED = "Nothing was registered. Fix it and try again.";

const STEP_LABELS: Record<ProjectStep, string> = { name: "Name", key: "Key", org: "Org", path: "Checkout", integrations: "Integrations" };

const REGISTER_ERRORS: Record<string, string> = {
  "not-a-git-repo": "This folder is not a git repository (it has no .git).",
  "already-registered": "This folder is already registered as a project.",
  "name-taken": "Another project already has this name; pick another.",
  "name-invalid": "This name is not valid: use lowercase letters, digits, '.', '_' or '-', starting with a letter or digit.",
  "key-taken": "Another project or org already holds this key, now or as an old key.",
  "key-invalid": "This key is not valid: 2 to 5 uppercase letters or digits, starting with a letter.",
  "org-unknown": "This org does not exist any more; pick another.",
  "outside-home": "Only folders inside your home directory can be browsed.",
  "not-found": "This folder does not exist.",
  refused: "The runtime refused the registration.",
};

const MEMORY_TABLES_EXCLUDED = new Set(["jobs", "decisions", "lessons"]);

export interface Draft {
  name: string;
  key: string;
  org: string;
  path: string;
  integrations: Record<string, string>;
}

export interface ProjectPatch {
  name?: string;
  key?: string;
  org?: string;
  path?: string;
  integrations?: { set: Record<string, string>; unset: string[] };
}

export interface OrgGroupRows {
  org: OrgRow;
  projects: SettingsProject[];
}

export interface EntryBadge {
  kind: "git" | "registered" | "worktree" | "plain";
  label: string;
  selectable: boolean;
  enterable: boolean;
}

export interface Crumb {
  label: string;
  path: string;
}

export interface SaveOutcome {
  applied: ProjectStep[];
  refused: { step: ProjectStep; reason: string } | null;
  unapplied: ProjectStep[];
}

export type RemoveMode = { kind: "running"; text: string } | { kind: "typed"; rows: number } | { kind: "plain" };

export type ControlKind = "switch" | "select" | "connection" | "checkboxes" | "text";

export interface SettingControl {
  key: string;
  label: string;
  control: ControlKind;
  options: string[];
  defaultText: string;
}

export interface ProviderControls {
  kind: string;
  disabled: boolean;
  controls: SettingControl[];
}

export interface FootprintCounters {
  jobs: number;
  decisions: number;
  lessons: number;
  memoryRows: number;
  total: number;
}

export interface OrgActions {
  setDefault: { disabled: boolean };
  remove: { disabled: boolean; reason: string | null };
}

// Tells whether a value is a plain object.
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

// A string field of an answer, or the fallback when it is not one.
function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

// A list of strings of an answer, other entries dropped.
function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

// The footprint of an answer row, entries without a table or a count dropped.
function footprintOf(value: unknown): FootprintEntry[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry) => isPlainObject(entry) && typeof entry.table === "string" && Number.isFinite(entry.total)).map((entry) => ({ table: entry.table as string, total: Number(entry.total) }));
}

// The move preview of an answer row: setting keys per org id.
function unlinkedOf(value: unknown): Record<string, string[]> {
  if (!isPlainObject(value)) return {};
  return Object.fromEntries(Object.entries(value).map(([orgId, keys]) => [orgId, strings(keys)]));
}

// One project row of the answer, every field coerced to its declared shape.
export function normalizeProject(raw: unknown): SettingsProject | null {
  if (!isPlainObject(raw) || typeof raw.id !== "string" || typeof raw.name !== "string") return null;
  const running = isPlainObject(raw.runningJob) && typeof raw.runningJob.ref === "string" ? { ref: raw.runningJob.ref } : null;
  return {
    id: raw.id,
    name: raw.name,
    key: typeof raw.key === "string" ? raw.key : null,
    aliases: strings(raw.aliases),
    path: typeof raw.path === "string" && raw.path ? raw.path : null,
    org: typeof raw.org === "string" ? raw.org : null,
    exists: raw.exists === true,
    origin: typeof raw.origin === "string" ? raw.origin : null,
    integrations: isPlainObject(raw.integrations) ? raw.integrations : null,
    footprint: footprintOf(raw.footprint),
    runningJob: running,
    unlinkedByMove: unlinkedOf(raw.unlinkedByMove),
  };
}

// One provider of the answer with its declared settings.
function normalizeProvider(raw: unknown): ProviderSettings | null {
  if (!isPlainObject(raw) || typeof raw.kind !== "string") return null;
  const keys = Array.isArray(raw.keys) ? raw.keys.filter((entry) => isPlainObject(entry) && typeof entry.key === "string" && typeof entry.type === "string") : [];
  return { kind: raw.kind, keys: keys as unknown as ProviderSettingKey[] };
}

// The Settings › Projects answer with hostile fields dropped.
export function normalizeProjectsAnswer(body: unknown): ProjectsAnswer {
  const raw = isPlainObject(body) ? body : {};
  const projects = Array.isArray(raw.projects) ? raw.projects.map(normalizeProject).filter((row): row is SettingsProject => row !== null) : [];
  const providers = Array.isArray(raw.providers) ? raw.providers.map(normalizeProvider).filter((row): row is ProviderSettings => row !== null) : [];
  return { projects, providers };
}

// The orgs of the answer, rows without an id or a name dropped.
export function normalizeOrgs(body: unknown): OrgRow[] {
  const list = isPlainObject(body) && Array.isArray(body.orgs) ? body.orgs : [];
  return list
    .filter((org): org is Record<string, unknown> => isPlainObject(org) && typeof org.id === "string" && typeof org.name === "string")
    .map((org) => ({
      id: org.id as string,
      name: org.name as string,
      key: text(org.key),
      aliases: strings(org.aliases),
      isDefault: org.isDefault === true,
      connections: isPlainObject(org.connections) ? (org.connections as OrgRow["connections"]) : {},
      projects: Number.isFinite(org.projects) ? Number(org.projects) : 0,
    }));
}

// Tells whether a project's checkout is registered but gone from the disk.
export function isPathMissing(project: SettingsProject): boolean {
  return project.path !== null && !project.exists;
}

// Tells whether a project is known only from history: no checkout and rows it still owns.
export function isHistory(project: SettingsProject): boolean {
  return project.path === null && project.footprint.length > 0;
}

// The projects a filter chip keeps.
export function filterProjects(rows: SettingsProject[], filter: ProjectFilter): SettingsProject[] {
  if (filter === "path-missing") return rows.filter(isPathMissing);
  if (filter === "no-path") return rows.filter((project) => project.path === null);
  return rows;
}

// The count of each filter chip.
export function filterCounts(rows: SettingsProject[]): Record<ProjectFilter, number> {
  return { all: rows.length, "path-missing": rows.filter(isPathMissing).length, "no-path": rows.filter((project) => project.path === null).length };
}

// A count with its noun, `1 project` or `3 projects`.
export function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

// The summary line under the title: projects, orgs, and what needs attention.
export function summaryLine(rows: SettingsProject[], orgs: OrgRow[]): string {
  const parts = [`${plural(rows.length, "project")} in ${plural(orgs.length, "org")}`];
  const missing = rows.filter(isPathMissing).length;
  const history = rows.filter(isHistory).length;
  if (missing) parts.push(`${missing} path missing`);
  if (history) parts.push(`${history} known from history`);
  return parts.join(" · ");
}

// The org cards in order, the default org first, each with its projects that are not history only.
export function groupByOrg(rows: SettingsProject[], orgs: OrgRow[]): OrgGroupRows[] {
  const ordered = [...orgs.filter((org) => org.isDefault), ...orgs.filter((org) => !org.isDefault)];
  return ordered.map((org) => ({ org, projects: rows.filter((project) => project.org === org.name && !isHistory(project)) }));
}

// The rows a card shows and how many it hides while collapsed.
export function collapsed<T>(rows: T[], open: boolean): { shown: T[]; hidden: number } {
  if (open || rows.length <= COLLAPSE_AFTER) return { shown: rows, hidden: 0 };
  return { shown: rows.slice(0, COLLAPSE_AFTER), hidden: rows.length - COLLAPSE_AFTER };
}

// The projects known only from history.
export function historyProjects(rows: SettingsProject[]): SettingsProject[] {
  return rows.filter(isHistory);
}

// A path split for a left-truncated display: the dim parent and the bright folder name.
export function pathParts(path: string): { head: string; folder: string } {
  const trimmed = path.length > 1 ? path.replace(/\/+$/, "") : path;
  const at = trimmed.lastIndexOf("/");
  if (at < 0) return { head: "", folder: trimmed };
  return { head: trimmed.slice(0, at + 1), folder: trimmed.slice(at + 1) };
}

// The last segment of a path.
export function baseName(path: string): string {
  return pathParts(path).folder;
}

// What the actions menu of an org allows, with the reason a remove is disabled.
export function orgActions(org: OrgRow): OrgActions {
  const reason = org.isDefault ? "it is the default org" : org.projects > 0 ? `it owns ${plural(org.projects, "project")}` : null;
  return { setDefault: { disabled: org.isDefault }, remove: { disabled: reason !== null, reason } };
}

// The connections an org binds, as one line per kind: `discord dlw-log, ops-log · sentry —`.
export function connectionsLine(org: OrgRow): string {
  const parts = Object.entries(org.connections).map(([kind, bound]) => {
    const names = Array.isArray(bound) ? bound : bound ? [bound] : [];
    return `${kind} ${names.length ? names.join(", ") : "—"}`;
  });
  return parts.length ? parts.join(" · ") : "no connections";
}

// The badge of a folder entry and what a click on it does.
export function entryBadge(entry: DirEntry): EntryBadge {
  if (entry.registeredAs) return { kind: "registered", label: `registered · ${entry.registeredAs.name}`, selectable: false, enterable: false };
  if (entry.worktreeOf) {
    const of = entry.worktreeOf.project ?? baseName(entry.worktreeOf.path);
    return { kind: "worktree", label: `linked worktree of ${of}`, selectable: entry.worktreeOf.project === null, enterable: false };
  }
  if (entry.git) return { kind: "git", label: "git repo", selectable: true, enterable: false };
  return { kind: "plain", label: "not a git repo", selectable: false, enterable: true };
}

// The breadcrumb of a folder inside the home: `~` then one crumb per segment.
export function breadcrumb(path: string, home: string): Crumb[] {
  if (path !== home && !path.startsWith(`${home}/`)) return [{ label: path, path }];
  const crumbs: Crumb[] = [{ label: "~", path: home }];
  let current = home;
  for (const segment of path.slice(home.length).split("/").filter(Boolean)) {
    current = `${current}/${segment}`;
    crumbs.push({ label: segment, path: current });
  }
  return crumbs;
}

// The inline error of a refused registration for its API code, always ending with what to do.
export function registerErrorText(code: string | null | undefined, body: { error?: unknown } | null): string {
  const known = code ? REGISTER_ERRORS[code] : undefined;
  const fallback = typeof body?.error === "string" && body.error ? body.error.replace(/\.?\s*$/, ".") : "The registration failed.";
  return `${known ?? fallback} ${NOTHING_REGISTERED}`;
}

// A key as typed: upper case, at most five characters.
export function normalizeKeyInput(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, KEY_MAX);
}

// The value stored at a setting key (`kind.a.b`) of a project's integrations, or undefined.
function storedAt(integrations: Integrations | null, key: string): unknown {
  return key.split(".").reduce<unknown>((node, part) => (isPlainObject(node) && Object.hasOwn(node, part) ? node[part] : undefined), integrations);
}

// The text form the runtime reads for a value: true/false, a comma-joined list, or the text itself.
export function textOf(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (Array.isArray(value)) return value.join(",");
  return String(value);
}

// Every setting key the providers declare.
function declaredKeys(providers: ProviderSettings[]): ProviderSettingKey[] {
  return providers.flatMap((provider) => provider.keys);
}

// The editable draft of a project: identity, checkout, and each declared setting as text ("" when unset).
export function draftOf(project: SettingsProject, providers: ProviderSettings[]): Draft {
  const integrations = Object.fromEntries(declaredKeys(providers).map((entry) => [entry.key, textOf(storedAt(project.integrations, entry.key))]));
  return { name: project.name, key: project.key ?? "", org: project.org ?? "", path: project.path ?? "", integrations };
}

// The settings that differ between two drafts, as the runtime's set and unset.
export function integrationsDiff(initial: Draft, draft: Draft): { set: Record<string, string>; unset: string[] } {
  const set: Record<string, string> = {};
  const unset: string[] = [];
  for (const [key, value] of Object.entries(draft.integrations)) {
    if (value === (initial.integrations[key] ?? "")) continue;
    if (value === "") unset.push(key);
    else set[key] = value;
  }
  return { set, unset };
}

// The steps a draft changes, in the order the server applies them.
export function changedSteps(initial: Draft, draft: Draft): ProjectStep[] {
  const diff = integrationsDiff(initial, draft);
  const changed: Record<ProjectStep, boolean> = {
    name: draft.name.trim() !== initial.name,
    key: draft.key.trim() !== initial.key,
    org: draft.org !== initial.org,
    path: draft.path.trim() !== initial.path,
    integrations: Object.keys(diff.set).length + diff.unset.length > 0,
  };
  return PROJECT_STEPS.filter((step) => changed[step]);
}

// The PATCH body of a draft: only the changed fields, in the server's order.
export function buildPatch(initial: Draft, draft: Draft): ProjectPatch {
  const patch: ProjectPatch = {};
  for (const step of changedSteps(initial, draft)) {
    if (step === "integrations") patch.integrations = integrationsDiff(initial, draft);
    else patch[step] = draft[step].trim();
  }
  return patch;
}

// The label of the save button: `Save 3 changes`, `Save 1 change`.
export function saveLabel(steps: ProjectStep[]): string {
  return `Save ${plural(steps.length, "change")}`;
}

// The human name of a step.
export function stepLabel(step: string): string {
  return STEP_LABELS[step as ProjectStep] ?? step;
}

// What a save did: the steps applied, the one refused with its reason, and the ones never applied after it.
export function saveOutcome(steps: ProjectStep[], refusal: StepRefusal | null): SaveOutcome {
  if (!refusal) return { applied: [...steps], refused: null, unapplied: [] };
  const at = steps.indexOf(refusal.step as ProjectStep);
  const applied = steps.filter((step) => refusal.applied.includes(step));
  if (at < 0) return { applied, refused: null, unapplied: steps.filter((step) => !applied.includes(step)) };
  return { applied, refused: { step: steps[at], reason: refusal.reason }, unapplied: steps.slice(at + 1) };
}

// The refusal of a step an API error body carries, or null when it is not one.
export function stepRefusalOf(body: Record<string, unknown> | null): StepRefusal | null {
  if (!body || typeof body.step !== "string") return null;
  return { code: typeof body.code === "string" ? body.code : null, step: body.step, reason: text(body.reason, text(body.error)), applied: strings(body.applied) };
}

// The note a move to another org shows before saving: the settings it would unset, or null.
export function moveNote(project: SettingsProject, orgs: OrgRow[], orgName: string): string | null {
  const target = orgs.find((org) => org.name === orgName);
  if (!target || orgName === project.org) return null;
  const lost = project.unlinkedByMove[target.id] ?? [];
  if (!lost.length) return null;
  return `Moving to ${orgName} unsets ${lost.join(", ")}: ${orgName} does not allow ${lost.length === 1 ? "that connection" : "those connections"}.`;
}

// The connections of a kind an org allows, from its bindings.
export function orgConnectionsOf(org: OrgRow | undefined, kind: string): string[] {
  const bound = org?.connections?.[kind];
  if (Array.isArray(bound)) return bound.filter((name) => typeof name === "string" && name);
  return typeof bound === "string" && bound ? [bound] : [];
}

// The control a setting type renders as; a type this build does not know falls back to text.
function controlOf(type: string): ControlKind {
  if (type === "boolean") return "switch";
  if (type === "enum") return "select";
  if (type === "connection") return "connection";
  if (type === "list") return "checkboxes";
  return "text";
}

// The controls of every provider for one project's org: one per declared setting, none for a provider with nothing to set.
export function settingControls(providers: ProviderSettings[], org: OrgRow | undefined): ProviderControls[] {
  return providers.map((provider) => ({
    kind: provider.kind,
    disabled: provider.keys.length === 0,
    controls: provider.keys.map((entry) => {
      const control = controlOf(entry.type);
      const options = control === "connection" ? orgConnectionsOf(org, provider.kind) : strings(entry.values);
      return { key: entry.key, label: entry.key.slice(provider.kind.length + 1), control, options, defaultText: textOf(entry.default) };
    }),
  }));
}

// The list a checkbox setting shows: the draft's entries, else the default's.
export function listValue(draftText: string, defaultText: string): string[] {
  return (draftText || defaultText).split(",").filter(Boolean);
}

// The text of a list setting after one checkbox flips; empty means unset.
export function toggledList(current: string[], value: string, options: string[]): string {
  const next = current.includes(value) ? current.filter((entry) => entry !== value) : [...current, value];
  return options.filter((option) => next.includes(option)).join(",");
}

// The two summary lines of a project's integrations: one per provider with settings, unset ones dim.
export function integrationsSummary(project: SettingsProject, providers: ProviderSettings[]): { text: string; dim: boolean }[] {
  return providers
    .filter((provider) => provider.keys.length > 0)
    .map((provider) => {
      const set = provider.keys.map((entry) => ({ label: entry.key.slice(provider.kind.length + 1), value: textOf(storedAt(project.integrations, entry.key)) })).filter((entry) => entry.value !== "");
      if (!set.length) return { text: `${provider.kind} · defaults`, dim: true };
      return { text: `${provider.kind} · ${set.map((entry) => `${entry.label} ${entry.value}`).join(" · ")}`, dim: false };
    })
    .slice(0, 2);
}

// The footprint as the counters the remove dialog shows; the total is the sum of every table.
export function footprintCounters(footprint: FootprintEntry[]): FootprintCounters {
  const of = (table: string) => footprint.filter((entry) => entry.table === table).reduce((sum, entry) => sum + entry.total, 0);
  const memoryRows = footprint.filter((entry) => !MEMORY_TABLES_EXCLUDED.has(entry.table)).reduce((sum, entry) => sum + entry.total, 0);
  const total = footprint.reduce((sum, entry) => sum + entry.total, 0);
  return { jobs: of("jobs"), decisions: of("decisions"), lessons: of("lessons"), memoryRows, total };
}

// How a project is removed: refused while a job runs on it, with the typed name when it owns rows, plainly otherwise.
export function removeMode(project: SettingsProject): RemoveMode {
  if (project.runningJob) return { kind: "running", text: `${project.runningJob.ref} is running on this project — cancel it first.` };
  const rows = footprintCounters(project.footprint).total;
  return rows > 0 ? { kind: "typed", rows } : { kind: "plain" };
}

// Tells whether the typed confirmation is exactly the project name.
export function typedMatches(input: string, name: string): boolean {
  return input === name;
}

// The explainer of the Set-as-default dialog, naming the current default.
export function setDefaultExplainer(target: string, current: string | null): string {
  const now = current ? `Today the default is ${current}.` : "No org is the default yet.";
  return `${now} The default org is where init, project add and project_register put a project when no org is named; from now on that is ${target}. Projects already registered stay where they are.`;
}
