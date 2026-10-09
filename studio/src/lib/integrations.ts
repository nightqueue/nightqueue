import type { ConnectionRow, IntegrationsView, LastNotice, LastTest, OrgSummary, ProjectDestination } from "./types";

export const DISCORD = "discord";

export const NO_DESTINATION = "";

const TYPE_ORDER = ["discord", "github", "linear", "sentry"];

const TYPE_LABELS: Record<string, string> = { discord: "Discord", github: "GitHub", linear: "Linear", sentry: "Sentry" };

const CREDENTIAL_LABELS: Record<string, string> = { discord: "webhook", github: "token", linear: "API key", sentry: "token" };

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

export type Tone = "ok" | "err" | "off";

export interface Labelled {
  tone: Tone;
  text: string;
}

export interface TypeChip {
  value: string;
  label: string;
}

export interface DestinationOption {
  value: string;
  label: string;
}

export interface OrgGroup {
  org: string;
  label: string;
  allowed: string[];
  projects: ProjectDestination[];
}

export type LinkPillKind = "already" | "none" | "other";

export interface LinkRow {
  project: ProjectDestination;
  locked: boolean;
  checked: boolean;
  pill: LinkPillKind;
  switching: boolean;
}

export type TriState = "all" | "some" | "none";

export interface LinkGroup {
  org: string;
  count: number;
  rows: LinkRow[];
  free: string[];
  state: TriState;
}

export interface LinkPlan {
  groups: LinkGroup[];
  notAllowed: string[];
  newIds: string[];
  alreadyCount: number;
  switching: string[];
}

export interface AddErrorView {
  title: string;
  body: string;
  field: "name" | "url" | null;
}

export interface Refusal {
  org: string;
  connectionId: string;
}

// An array of a payload field, an empty one when the field is not an array.
function listOf<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

// The integrations answer with every list guaranteed to be an array.
export function normalizeView(body: unknown): IntegrationsView {
  const source = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const connections = listOf<ConnectionRow>(source.connections).map((row) => ({ ...row, orgs: listOf<string>(row.orgs), usedBy: listOf<string>(row.usedBy) }));
  return { orgs: listOf<OrgSummary>(source.orgs), connections, projects: listOf<ProjectDestination>(source.projects) };
}

// Tells whether a connection is a Discord webhook.
export function isDiscord(row: Pick<ConnectionRow, "type">): boolean {
  return row.type === DISCORD;
}

// The display name of a connection type.
export function typeLabel(type: string): string {
  return TYPE_LABELS[type] ?? type;
}

// The type line of a connection: the service and the kind of secret it holds.
export function typeLine(type: string): string {
  const credential = CREDENTIAL_LABELS[type];
  return credential ? `${typeLabel(type)} · ${credential}` : typeLabel(type);
}

// The types present in the list, in the fixed display order.
function presentTypes(rows: readonly ConnectionRow[]): string[] {
  const types = new Set(rows.map((row) => row.type));
  const known = TYPE_ORDER.filter((type) => types.has(type));
  return [...known, ...[...types].filter((type) => !TYPE_ORDER.includes(type))];
}

// The filter chips of the connections card: all, Discord, GitHub, Linear, plus any other stored type.
export function typeChips(rows: readonly ConnectionRow[]): TypeChip[] {
  const types = [...new Set([...TYPE_ORDER.slice(0, 3), ...presentTypes(rows)])];
  return [{ value: "all", label: "all" }, ...types.map((type) => ({ value: type, label: typeLabel(type) }))];
}

// The count per type beside the card title, as `2 Discord · 1 GitHub`.
export function typeSummary(rows: readonly ConnectionRow[]): string {
  return presentTypes(rows)
    .map((type) => `${rows.filter((row) => row.type === type).length} ${typeLabel(type)}`)
    .join(" · ");
}

// The connections of one type, or all of them.
export function filterConnections(rows: readonly ConnectionRow[], type: string): ConnectionRow[] {
  return type === "all" ? [...rows] : rows.filter((row) => row.type === type);
}

// The last six characters of a Discord id, ellipsed.
export function shortId(id: string | null | undefined): string {
  if (!id) return "?";
  return id.length > 6 ? `…${id.slice(-6)}` : id;
}

// What a Discord row knows of its channel: webhook name and short ids, with the full ids as the title.
export function webhookLine(row: ConnectionRow): { text: string; title: string } {
  const parts = [row.webhookName ? `webhook ${row.webhookName}` : null, `channel ${shortId(row.channelId)}`, `server ${shortId(row.serverId)}`];
  return { text: parts.filter(Boolean).join(" · "), title: `channel ${row.channelId ?? "unknown"} · server ${row.serverId ?? "unknown"}` };
}

// The label of a Discord connection in a select: its name and, when known, its webhook name.
export function connectionLabel(row: ConnectionRow): string {
  return row.webhookName ? `${row.name} · ${row.webhookName}` : row.name;
}

// The milliseconds of an ISO time, or null when it is not one.
function timeOf(at: string | null | undefined): number | null {
  if (!at) return null;
  const ms = Date.parse(at);
  return Number.isFinite(ms) ? ms : null;
}

// How long ago a time was, as `just now`, `10 min ago`, `2 h ago` or `3 days ago`.
export function agoLabel(at: string | null | undefined, nowMs: number): string {
  const ms = timeOf(at);
  if (ms === null || !Number.isFinite(nowMs)) return "at an unknown time";
  const elapsed = Math.max(0, nowMs - ms);
  if (elapsed < MINUTE_MS) return "just now";
  if (elapsed < HOUR_MS) return `${Math.floor(elapsed / MINUTE_MS)} min ago`;
  if (elapsed < DAY_MS) return `${Math.floor(elapsed / HOUR_MS)} h ago`;
  const days = Math.floor(elapsed / DAY_MS);
  return days === 1 ? "1 day ago" : `${days} days ago`;
}

// The UTC wall time of a date as `HH:MM`.
function clockOf(date: Date): string {
  return `${String(date.getUTCHours()).padStart(2, "0")}:${String(date.getUTCMinutes()).padStart(2, "0")}`;
}

// The UTC calendar day number of a time.
function dayOf(ms: number): number {
  return Math.floor(ms / DAY_MS);
}

// When a time was, in UTC: `today 14:36`, `yesterday 18:02`, `Oct 6 11:40`, or `Sep 29 2025` in another year.
export function whenLabel(at: string | null | undefined, nowMs: number): string {
  const ms = timeOf(at);
  if (ms === null || !Number.isFinite(nowMs)) return "at an unknown time";
  const date = new Date(ms);
  const days = dayOf(nowMs) - dayOf(ms);
  if (days === 0) return `today ${clockOf(date)}`;
  if (days === 1) return `yesterday ${clockOf(date)}`;
  const day = `${MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}`;
  return date.getUTCFullYear() === new Date(nowMs).getUTCFullYear() ? `${day} ${clockOf(date)}` : `${day} ${date.getUTCFullYear()}`;
}

// The Last test pill of a connection: ok or failed with when, or never tested.
export function lastTestLabel(lastTest: LastTest | null | undefined, nowMs: number): Labelled {
  if (!lastTest) return { tone: "off", text: "never tested" };
  const when = agoLabel(lastTest.at, nowMs);
  return lastTest.ok ? { tone: "ok", text: `ok · ${when}` } : { tone: "err", text: `failed · ${when}` };
}

// The Last notice of a project: the job and when, red when the post failed; null when none was posted yet.
export function noticeLabel(notice: LastNotice | null | undefined, nowMs: number): Labelled | null {
  if (!notice) return null;
  const when = whenLabel(notice.at, nowMs);
  return notice.ok ? { tone: "ok", text: `${notice.jobRef} closed · ${when}` } : { tone: "err", text: `failed · ${notice.jobRef} · ${when}` };
}

// The Discord connections of the view.
export function discordConnections(view: IntegrationsView): ConnectionRow[] {
  return view.connections.filter(isDiscord);
}

// The names of the Discord connections allowed for one org.
export function allowedConnections(view: IntegrationsView, org: string | null): string[] {
  if (!org) return [];
  return discordConnections(view)
    .filter((row) => row.orgs.includes(org))
    .map((row) => row.name);
}

// The options of a project's destination select: every Discord connection, the not allowed ones marked, a missing stored one, and no destination.
export function destinationOptions(view: IntegrationsView, project: ProjectDestination): DestinationOption[] {
  const allowed = allowedConnections(view, project.org);
  const discord = discordConnections(view);
  const options = discord.map((row) => ({ value: row.name, label: allowed.includes(row.name) ? connectionLabel(row) : `${connectionLabel(row)} (not allowed)` }));
  const dangling = project.destination && !discord.some((row) => row.name === project.destination);
  const missing = dangling ? [{ value: project.destination as string, label: `${project.destination} (missing)` }] : [];
  return [...missing, ...options, { value: NO_DESTINATION, label: "— no destination —" }];
}

// The org names of the view in registry order, then any org only a project names.
function orgOrder(view: IntegrationsView): string[] {
  const names = view.orgs.map((org) => org.name);
  const extra = view.projects.map((project) => project.org ?? "").filter((org) => !names.includes(org));
  return [...names, ...new Set(extra)];
}

// The group row text of one org: its project count and its allowed connections.
function groupLabel(org: string, count: number, allowed: readonly string[]): string {
  const projects = `${count} ${count === 1 ? "project" : "projects"}`;
  const connections = allowed.length ? `allowed connections: ${allowed.join(", ")}` : "no allowed connection";
  return `org ${org || "none"} · ${projects} · ${connections}`;
}

// The projects of the view grouped by org, each group with its label and allowed connections; empty orgs are left out.
export function groupProjectsByOrg(view: IntegrationsView, projects: readonly ProjectDestination[] = view.projects): OrgGroup[] {
  return orgOrder(view)
    .map((org) => {
      const members = projects.filter((project) => (project.org ?? "") === org);
      const allowed = allowedConnections(view, org || null);
      return { org, label: groupLabel(org, members.length, allowed), allowed, projects: members };
    })
    .filter((group) => group.projects.length > 0);
}

// The number of projects without a log destination.
export function withoutDestination(view: IntegrationsView): number {
  return view.projects.filter((project) => !project.destination).length;
}

// The header line of the destinations card, as `7 of 10 projects have a destination`.
export function destinationSummary(view: IntegrationsView): string {
  const total = view.projects.length;
  const linked = total - withoutDestination(view);
  return `${linked} of ${total} ${total === 1 ? "project has" : "projects have"} a destination`;
}

// The names of the projects a connection serves, in view order.
export function usedByNames(view: IntegrationsView, row: ConnectionRow): string[] {
  return view.projects.filter((project) => row.usedBy.includes(project.id)).map((project) => project.name);
}

// The projects of one org whose destination is a connection.
export function projectsUsingInOrg(view: IntegrationsView, connection: string, org: string): ProjectDestination[] {
  return view.projects.filter((project) => project.destination === connection && project.org === org);
}

// The projects whose destination is a connection.
export function projectsUsing(view: IntegrationsView, connection: string): ProjectDestination[] {
  return view.projects.filter((project) => project.destination === connection);
}

// The orgs a connection could still be allowed for.
export function remainingOrgs(view: IntegrationsView, row: ConnectionRow): string[] {
  return view.orgs.map((org) => org.name).filter((name) => !row.orgs.includes(name));
}

// One project row of the link dialog: locked when already on the connection, its pill, and whether checking it switches.
function linkRow(project: ProjectDestination, connection: string, checked: ReadonlySet<string>): LinkRow {
  const locked = project.destination === connection;
  const isChecked = locked || checked.has(project.id);
  const pill: LinkPillKind = locked ? "already" : project.destination ? "other" : "none";
  return { project, locked, checked: isChecked, pill, switching: isChecked && pill === "other" };
}

// The whole-org checkbox state of a group's free rows.
function triState(rows: readonly LinkRow[]): TriState {
  const free = rows.filter((row) => !row.locked);
  if (!free.length || free.every((row) => row.checked)) return "all";
  return free.some((row) => row.checked) ? "some" : "none";
}

// The link dialog's selection math: groups of the allowed orgs, the newly checked ids, the already linked count and the switches.
export function linkPlan(view: IntegrationsView, connection: ConnectionRow, checked: ReadonlySet<string>): LinkPlan {
  const groups = connection.orgs.map((org) => {
    const rows = view.projects.filter((project) => project.org === org).map((project) => linkRow(project, connection.name, checked));
    return { org, count: rows.length, rows, free: rows.filter((row) => !row.locked).map((row) => row.project.id), state: triState(rows) };
  });
  const rows = groups.flatMap((group) => group.rows);
  const fresh = rows.filter((row) => row.checked && !row.locked);
  return {
    groups,
    notAllowed: remainingOrgs(view, connection).filter((org) => view.projects.some((project) => project.org === org)),
    newIds: fresh.map((row) => row.project.id),
    alreadyCount: rows.filter((row) => row.locked).length,
    switching: fresh.filter((row) => row.switching).map((row) => row.project.name),
  };
}

// The selection after the whole-org toggle: every free row checked, or all of them cleared when they already were.
export function toggledOrg(checked: ReadonlySet<string>, group: LinkGroup): Set<string> {
  const next = new Set(checked);
  for (const id of group.free) {
    if (group.state === "all") next.delete(id);
    else next.add(id);
  }
  return next;
}

// The selection after one row was toggled.
export function toggledProject(checked: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(checked);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

// The link dialog's main button text, counting only the newly checked projects.
export function linkCta(count: number): string {
  if (count <= 0) return "Select projects";
  return `Link ${count} ${count === 1 ? "project" : "projects"}`;
}

// The error body and status of a failed API call, when it carries them.
function errorParts(err: unknown): { status: number | null; body: Record<string, unknown> } {
  const source = (err && typeof err === "object" ? err : {}) as { status?: unknown; body?: unknown };
  const status = typeof source.status === "number" ? source.status : null;
  const body = source.body && typeof source.body === "object" ? (source.body as Record<string, unknown>) : {};
  return { status, body };
}

// The refusal code a failed API call carries, or null.
export function errorCode(err: unknown): string | null {
  const { body } = errorParts(err);
  return typeof body.code === "string" ? body.code : null;
}

// The message of a failed call.
function messageOf(err: unknown): string {
  return err instanceof Error && err.message ? err.message : String(err);
}

// The text of a Discord refusal: its fixed reason, with the next step when it names a status.
function refusedBody(body: Record<string, unknown>): string {
  const reason = typeof body.reason === "string" && body.reason ? body.reason : "Discord did not accept the webhook.";
  return typeof body.status === "number" ? `${reason} Create a new one in the channel and paste the new URL.` : reason;
}

// The text of a duplicate name refusal, naming the orgs that use the old connection.
function duplicateBody(name: string, body: Record<string, unknown>): string {
  const orgs = listOf<string>(body.orgs).filter((org) => typeof org === "string");
  const where = orgs.length ? `in org ${orgs.join(", ")}` : "in this home";
  return `There is a “${name}” connection ${where}. Pick another name or remove the old one first.`;
}

// What the add dialog shows for a failed add: a title, a body and the field to mark red.
export function addErrorView(err: unknown, name: string): AddErrorView {
  const { body } = errorParts(err);
  const code = errorCode(err);
  if (code === "invalid-url") {
    return { title: "Invalid URL", body: "Paste the full webhook URL. It starts with https://discord.com/api/webhooks/ and ends with the id and token.", field: "url" };
  }
  if (code === "refused") return { title: "Discord refused the URL", body: refusedBody(body), field: "url" };
  if (code === "duplicate") return { title: "A connection with this name already exists", body: duplicateBody(name, body), field: "name" };
  return { title: "Couldn't save the connection", body: messageOf(err), field: null };
}

// The org refusal of a destination change, or null when the failure is another one.
export function refusalOf(err: unknown): Refusal | null {
  const { status, body } = errorParts(err);
  if (status !== 403 || errorCode(err) !== "not-allowed-for-org") return null;
  if (typeof body.org !== "string" || typeof body.connectionId !== "string") return null;
  return { org: body.org, connectionId: body.connectionId };
}
