import { compactCount, formatDurationMs, usdLabel } from "./format.ts";
import type { AttemptRow, JobStatus, NarrationEvent } from "./types";

export const MEMORY_TOOLS: ReadonlySet<string> = new Set(["lesson_recall", "memory_recall", "decision_recall", "index_recall", "context_for_phase"]);

export const PHASE_NAMES: ReadonlyMap<number, string> = new Map([
  [0, "brief"],
  [1, "triager"],
  [2, "explore"],
  [3, "architect"],
  [4, "coder"],
  [5, "qa-guardian"],
  [6, "verifier"],
  [7, "runtime"],
  [8, "commit · PR"],
]);

const MARKDOWN_MIN_LINES = 3;

const MARKDOWN_LEAD = /^[#|-]/;

const ATTEMPT_NUMBER = /^attempt (\d+)/;

const NOTICE_INDENT = /^ {4}/;

const GATE_KINDS = new Set(["gate", "notice"]);

const LANE_END_KINDS = new Set(["laneClose", "laneOrphan"]);

const TOOL_KINDS = new Set(["tool", "toolError"]);

const BYTE_UNITS = ["KB", "MB", "GB"];

const NOT_KEPT = " (answer not kept)";

export type BodyKind = "answer" | "handBack" | "report" | "toolError" | "gate";

export interface LogRow {
  type: "line";
  key: string;
  event: NarrationEvent;
  lane: boolean;
  body: BodyKind | null;
  final: boolean;
  dim?: boolean;
}

export interface LaneGroup {
  type: "lane";
  key: string;
  laneId: string;
  head: LogRow;
  rows: LogRow[];
  ended: boolean;
  latest: LogRow | null;
  tools: number;
}

export interface StreamContext {
  ended: boolean;
  attempts: readonly AttemptRow[];
  status: JobStatus;
  notice: string | null;
  operatorNote: string | null;
  phaseNames: ReadonlyMap<number, string>;
}

export interface LogStream {
  rows: LogRow[];
  attemptCount: number;
  lastEventKey: string | null;
  finalKey: string | null;
}

interface Segment {
  number: number | null;
  opener: number | null;
  indices: number[];
}

interface FoldState {
  rows: LogRow[];
  lanes: Set<string>;
  lastEventKey: string | null;
  lastAnswer: LogRow | null;
}

// The attempt number an `attempt` event names, null when its text carries none.
function attemptNumberOf(event: NarrationEvent): number | null {
  const match = ATTEMPT_NUMBER.exec(event.text ?? "");
  return match ? Number(match[1]) : null;
}

// The events split at each `attempt` event; a leading run with no attempt event belongs to the attempt before the first one seen.
function segmentsOf(events: readonly NarrationEvent[], attemptsLogged: number): Segment[] {
  const segments: Segment[] = [];
  events.forEach((event, index) => {
    if (event.kind === "attempt") segments.push({ number: attemptNumberOf(event), opener: index, indices: [] });
    else if (segments.length === 0) segments.push({ number: null, opener: null, indices: [index] });
    else segments[segments.length - 1].indices.push(index);
  });
  const lead = segments[0];
  if (lead && lead.opener === null) {
    const next = segments[1]?.number ?? null;
    lead.number = next !== null ? next - 1 : attemptsLogged || null;
  }
  return segments;
}

// A line the studio composes itself, shaped like a narration event of the wire.
function composedEvent(kind: string, glyph: string, text: string, fields: Partial<NarrationEvent> = {}): NarrationEvent {
  return { kind, glyph, clock: "", text, dim: "", indent: false, lane: null, tool: null, agent: null, phase: null, model: null, durationMs: null, elapsedMs: null, file: null, laneId: null, body: null, body_truncated: false, body_offset: null, at: null, artifact: null, title: null, bytes: null, ...fields };
}

// An ISO instant at second precision, `2026-09-07T21:00:00Z`; null when it is not a date.
function secondsIso(value: string | null | undefined): string | null {
  const ms = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(ms) ? new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z") : null;
}

// The first phase past the brief an attempt reaches, null when it reaches none.
function firstWorkPhase(events: readonly NarrationEvent[], segment: Segment): number | null {
  for (const index of segment.indices) {
    const phase = events[index].phase;
    if (events[index].kind === "phase" && typeof phase === "number" && phase >= 1) return phase;
  }
  return null;
}

// The `at` of the first phase event of an attempt, the start it falls back on when the history has none.
function firstPhaseAt(events: readonly NarrationEvent[], segment: Segment): string | null {
  const index = segment.indices.find((candidate) => events[candidate].kind === "phase");
  return index === undefined ? null : events[index].at;
}

// The `═ attempt N @ <start>` line of an attempt, with where a resumed attempt picked the pipeline up.
function attemptOpenRow(events: readonly NarrationEvent[], segment: Segment, ctx: StreamContext): LogRow {
  const event = events[segment.opener as number];
  const number = segment.number;
  const row = number !== null ? ctx.attempts[number - 1] : undefined;
  const started = secondsIso(row?.started_at) ?? secondsIso(firstPhaseAt(events, segment));
  const resumedAt = firstWorkPhase(events, segment);
  const resumed = number !== null && number > 1 && resumedAt !== null && resumedAt > 1 ? ` · resumed at phase ${resumedAt}` : "";
  const text = `${event.text}${started ? ` @ ${started}` : ""}${resumed}`;
  return { type: "line", key: `e${segment.opener}`, event: { ...event, text }, lane: false, body: null, final: false };
}

// Tells whether a phase event is worth a line: not the brief right after its attempt line, not a phase left empty by the next one.
function phaseShown(events: readonly NarrationEvent[], index: number): boolean {
  const event = events[index];
  if (event.phase === 0 && events[index - 1]?.kind === "attempt") return false;
  return events[index + 1]?.kind !== "phase";
}

// The dim `─ phase N <name> · model` line of a phase event.
function phaseRow(event: NarrationEvent, key: string, ctx: StreamContext): LogRow {
  const number = event.phase ?? 0;
  const name = ctx.phaseNames.get(number) ?? PHASE_NAMES.get(number) ?? event.agent ?? "phase";
  const text = `phase ${number} ${name}${event.model ? ` · ${event.model}` : ""}`;
  return { type: "line", key, event: { ...event, glyph: "─", text }, lane: false, body: null, final: false };
}

// The body a narrated event carries under its line, null when it has none worth opening.
function bodyKindOf(event: NarrationEvent): BodyKind | null {
  if (event.kind === "report") return "report";
  const body = event.body;
  if (typeof body !== "string" || body === "") return null;
  if (event.kind === "text" && body.trim() !== (event.text ?? "").trim()) return "answer";
  if (event.kind === "laneClose") return "handBack";
  if (event.kind === "toolError") return "toolError";
  return null;
}

// The line of one narrated event: a report reads as its artifact and title, any other event as narrated.
function eventRow(event: NarrationEvent, key: string): LogRow {
  const shown = event.kind === "report" ? { ...event, glyph: "▣", text: `${event.artifact ?? "report"}${event.title ? ` — ${event.title}` : ""}` } : event;
  return { type: "line", key, event: shown, lane: event.indent === true, body: bodyKindOf(event), final: false };
}

// Places one narrated event of an attempt, skipping what the close lines replace and repeated lane opens.
function placeEvent(state: FoldState, events: readonly NarrationEvent[], index: number, ctx: StreamContext) {
  const event = events[index];
  const key = `e${index}`;
  if (event.kind === "resultEnd") return;
  if (event.kind === "phase") {
    if (phaseShown(events, index)) state.rows.push(phaseRow(event, key, ctx));
    return;
  }
  if (event.kind === "laneOpen" && event.laneId) {
    if (state.lanes.has(event.laneId)) return;
    state.lanes.add(event.laneId);
  }
  const row = eventRow(event, key);
  state.rows.push(row);
  if (event.kind === "text" && !event.indent && event.body) state.lastAnswer = row;
  if (event.kind !== "report") state.lastEventKey = key;
}

// The question of a gate as the narration carried it: the last notice of the attempt, its head and indent removed.
function noticeQuestion(events: readonly NarrationEvent[], segment: Segment): string {
  const index = [...segment.indices].reverse().find((candidate) => events[candidate].kind === "notice");
  if (index === undefined) return "";
  const lines = (events[index].text ?? "").split("\n").slice(1);
  return lines.map((line) => line.replace(NOTICE_INDENT, "")).join("\n").trim();
}

// The first non-blank line of a text, its heading marker removed.
export function firstLineOf(text: string | null | undefined): string {
  const line = String(text ?? "").split("\n").find((candidate) => candidate.trim() !== "") ?? "";
  return line.replace(/^\s*#{1,6}\s+/, "").trim();
}

// The `⏸ gate — <question>` line of an attempt that stopped at a gate, the whole question as its body.
function gateRow(number: number, question: string): LogRow {
  const head = firstLineOf(question);
  const event = composedEvent("gateQuestion", "⏸", head ? `gate — ${head}` : "gate", { body: question || null });
  return { type: "line", key: `a${number}-gate`, event, lane: false, body: question ? "gate" : null, final: false };
}

// Tokens of an attempt row: in, out and both caches summed; null when it counted none.
function attemptTokens(row: AttemptRow): number | null {
  const parts = [row.tokens_in, row.tokens_out, row.cache_read, row.cache_creation].filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  return parts.length ? parts.reduce((sum, value) => sum + value, 0) : null;
}

// The text of an attempt's close line, from its history row, or the bare end when the home kept none.
function attemptEndText(number: number, row: AttemptRow | undefined, lastStatus: string | null): string {
  if (!row?.outcome) return lastStatus ? `attempt ${number} ended at ${lastStatus}` : `attempt ${number} ended`;
  const how = row.outcome === "done" ? "done" : `ended at ${row.outcome}`;
  const duration = typeof row.duration_s === "number" ? formatDurationMs(row.duration_s * 1000) : "-";
  return `attempt ${number} ${how} · ${duration} · ${compactCount(attemptTokens(row))} tok · ${usdLabel(row.cost_usd)}`;
}

// The `✎` line of an answered gate: the note on the latest one, `(answer not kept)` dimmed on earlier ones.
function operatorRow(number: number, note: string | null): LogRow {
  const key = `a${number}-answer`;
  if (note === null) return { type: "line", key, event: composedEvent("operator", "✎", `operator answered${NOT_KEPT}`, { clock: "—", dim: NOT_KEPT }), lane: false, body: null, final: false, dim: true };
  const text = note.trim();
  const multiLine = text.includes("\n");
  const said = text ? `operator answered — ${multiLine ? firstLineOf(text) : text}` : "operator answered";
  const event = composedEvent("operator", "✎", said, { clock: "—", body: multiLine ? text : null });
  return { type: "line", key, event, lane: false, body: multiLine ? "answer" : null, final: false };
}

interface Closing {
  segment: Segment;
  number: number;
  last: boolean;
}

// Tells whether a closed attempt stopped at a gate the operator then answered.
function gateAnswered({ number, last }: Closing, ctx: StreamContext): boolean {
  if (ctx.attempts[number - 1]?.outcome !== "gate") return false;
  return !last || ctx.status === "pending";
}

// The close lines of an attempt: its gate question, its end summary and the operator's answer when it had one.
function closeRows(events: readonly NarrationEvent[], closing: Closing, ctx: StreamContext, latestAnswered: number | null): LogRow[] {
  const { segment, number, last } = closing;
  const row = ctx.attempts[number - 1];
  const rows: LogRow[] = [];
  const gated = row?.outcome === "gate";
  if (gated) rows.push(gateRow(number, (last && ctx.status === "gate" ? (ctx.notice ?? "").trim() : "") || noticeQuestion(events, segment)));
  const end = composedEvent("attemptEnd", "═", attemptEndText(number, row, last ? ctx.status : null));
  rows.push({ type: "line", key: `a${number}-end`, event: end, lane: false, body: null, final: false });
  if (gated && gateAnswered(closing, ctx)) rows.push(operatorRow(number, number === latestAnswered ? (ctx.operatorNote ?? "") : null));
  return rows;
}

// The attempts the fold closes: every one a later attempt follows, and the last once the stream ended with its history row finished.
function closingsOf(segments: readonly Segment[], ctx: StreamContext): Map<Segment, Closing> {
  const closings = new Map<Segment, Closing>();
  segments.forEach((segment, index) => {
    const last = index === segments.length - 1;
    if (segment.number === null) return;
    if (last && !(ctx.ended && ctx.attempts[segment.number - 1]?.finished_at)) return;
    closings.set(segment, { segment, number: segment.number, last });
  });
  return closings;
}

// The highest attempt whose gate the operator answered, the only one whose note the job row still holds.
function latestAnsweredGate(closings: Map<Segment, Closing>, ctx: StreamContext): number | null {
  let latest: number | null = null;
  for (const closing of closings.values()) if (gateAnswered(closing, ctx)) latest = Math.max(latest ?? 0, closing.number);
  return latest;
}

// Folds every attempt's narration into one flat chronological list of lines, with the attempt, gate and answer lines composed from the job row.
export function foldStream(events: readonly NarrationEvent[], ctx: StreamContext): LogStream {
  const segments = segmentsOf(events, ctx.attempts.length);
  const closings = closingsOf(segments, ctx);
  const latestAnswered = latestAnsweredGate(closings, ctx);
  const state: FoldState = { rows: [], lanes: new Set(), lastEventKey: null, lastAnswer: null };
  let attemptCount = 0;
  for (const segment of segments) {
    if (segment.opener !== null) state.rows.push(attemptOpenRow(events, segment, ctx));
    attemptCount = Math.max(attemptCount, segment.number ?? 0);
    const closing = closings.get(segment);
    const dropsGate = closing !== undefined && ctx.attempts[closing.number - 1]?.outcome === "gate";
    for (const index of segment.indices) if (!(dropsGate && GATE_KINDS.has(events[index].kind))) placeEvent(state, events, index, ctx);
    if (closing) state.rows.push(...closeRows(events, closing, ctx, latestAnswered));
  }
  const final = ctx.ended ? state.lastAnswer : null;
  if (final) Object.assign(final, { final: true, body: "answer" });
  return { rows: state.rows, attemptCount, lastEventKey: state.lastEventKey, finalKey: final?.key ?? null };
}

// A lane's block opened by its laneOpen line, holding no line yet.
function openLaneGroup(head: LogRow, laneId: string): LaneGroup {
  return { type: "lane", key: `lane-${laneId}`, laneId, head, rows: [], ended: false, latest: null, tools: 0 };
}

// Settles a lane's block once every line is placed: ended with the stream, its latest tool call and its tool count.
function settleLaneGroup(group: LaneGroup, streamEnded: boolean) {
  const tools = group.rows.filter((row) => TOOL_KINDS.has(row.event.kind));
  group.ended ||= streamEnded;
  group.latest = tools.at(-1) ?? null;
  group.tools = tools.length;
}

// The visible lines with each lane whose laneOpen was seen gathered into one block at its open; every other line stays flat in place.
export function groupLanes(rows: readonly LogRow[], { ended }: { ended: boolean }): Array<LogRow | LaneGroup> {
  const out: Array<LogRow | LaneGroup> = [];
  const groups = new Map<string, LaneGroup>();
  for (const row of rows) {
    const laneId = row.event.laneId;
    const group = laneId ? groups.get(laneId) : undefined;
    if (group) {
      group.rows.push(row);
      if (LANE_END_KINDS.has(row.event.kind)) group.ended = true;
    } else if (laneId && row.event.kind === "laneOpen") {
      const opened = openLaneGroup(row, laneId);
      groups.set(laneId, opened);
      out.push(opened);
    } else out.push(row);
  }
  for (const group of groups.values()) settleLaneGroup(group, ended);
  return out;
}

// Tells whether a text reads as markdown: 3+ lines starting with `#`, `-` or `|`.
export function looksLikeMarkdown(text: string): boolean {
  let count = 0;
  for (const line of text.split("\n")) {
    if (MARKDOWN_LEAD.test(line.trimStart())) count += 1;
    if (count >= MARKDOWN_MIN_LINES) return true;
  }
  return false;
}

// A byte count as a short size: `812 B`, `2.3 KB`, `1.1 MB`; `-` when unknown.
export function formatBytes(bytes: number | null | undefined): string {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) return "-";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${BYTE_UNITS[unit]}`;
}

// The studio route of one artifact of a job's run directory.
export function artifactPath(jobRef: string, name: string): string {
  return `/api/jobs/${encodeURIComponent(jobRef)}/artifacts/${encodeURIComponent(name)}`;
}

// The studio route of a job's raw log from one byte on.
export function rawLogPath(jobRef: string, fromByte: number): string {
  return `/api/jobs/${encodeURIComponent(jobRef)}/log?from=${fromByte}`;
}
