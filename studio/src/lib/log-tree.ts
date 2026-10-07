import type { NarrationEvent } from "./types";

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

const TOOL_RUN_HEAD = 3;

const TOOL_RUN_TAIL = 2;

const MIN_FOLDED_TOOLS = 2;

const MARKDOWN_MIN_LINES = 3;

const MARKDOWN_LEAD = /^[#|-]/;

const RUN_CHECK = /\brun check\b/;

const ALWAYS_SHOWN_KINDS = new Set(["toolError", "report"]);

const LANE_KINDS = new Set(["laneOpen", "laneClose", "laneOrphan"]);

const BYTE_UNITS = ["KB", "MB", "GB"];

export type BlockKind = "answer" | "handBack" | "report" | "toolError";

export interface LineItem {
  type: "line";
  key: string;
  event: NarrationEvent;
}

export interface BlockItem {
  type: "block";
  key: string;
  kind: BlockKind;
  event: NarrationEvent;
}

export interface MoreItem {
  type: "more";
  key: string;
  count: number;
}

export type LaneChild = LineItem | BlockItem;

export interface LaneNode {
  type: "lane";
  key: string;
  open: NarrationEvent;
  close: NarrationEvent | null;
  orphan: boolean;
  children: LaneChild[];
  tools: number;
  edits: number;
}

export type PhaseItem = LineItem | BlockItem | LaneNode;

export interface PhaseNode {
  key: string;
  number: number;
  agent: string | null;
  model: string | null;
  items: PhaseItem[];
  lanes: number;
  tools: number;
  report: string | null;
}

export interface FinalReport {
  key: string;
  event: NarrationEvent;
}

export interface LogTree {
  phases: PhaseNode[];
  currentKey: string | null;
  finalReport: FinalReport | null;
  lastEventKey: string | null;
}

export interface LogChips {
  narrated: boolean;
  orchestrator: boolean;
  lanes: boolean;
  allTools: boolean;
}

export const DEFAULT_CHIPS: LogChips = { narrated: true, orchestrator: false, lanes: true, allTools: false };

interface LaneOwner {
  lane: LaneNode;
  phase: PhaseNode;
}

interface FoldState {
  phases: PhaseNode[];
  byNumber: Map<number, PhaseNode>;
  owners: Map<string, LaneOwner>;
  current: PhaseNode | null;
  lastAnswer: FinalReport | null;
  lastEventKey: string | null;
}

// The phase node of one phase number, created at the end of the tree the first time the number shows up.
function phaseNode(state: FoldState, number: number): PhaseNode {
  const known = state.byNumber.get(number);
  if (known) return known;
  const node: PhaseNode = { key: `p${number}`, number, agent: null, model: null, items: [], lanes: 0, tools: 0, report: null };
  state.byNumber.set(number, node);
  state.phases.push(node);
  return node;
}

// The phase new events land in: the last one entered, an implicit phase 0 before any.
function currentPhase(state: FoldState): PhaseNode {
  if (!state.current) state.current = phaseNode(state, 0);
  return state.current;
}

// Enters the phase a `phase` event names, keeping the agent and model it carries.
function enterPhase(state: FoldState, event: NarrationEvent) {
  const node = phaseNode(state, Number.isInteger(event.phase) ? (event.phase as number) : 0);
  node.agent = event.agent ?? node.agent;
  node.model = event.model ?? node.model;
  state.current = node;
}

// Opens a lane node in the current phase; a repeated open of a known lane is ignored.
function openLane(state: FoldState, event: NarrationEvent, key: string) {
  if (event.laneId === null || event.laneId === undefined) return placeEvent(state, event, key);
  if (state.owners.has(event.laneId)) return;
  const phase = currentPhase(state);
  const lane: LaneNode = { type: "lane", key, open: event, close: null, orphan: false, children: [], tools: 0, edits: 0 };
  phase.items.push(lane);
  phase.lanes += 1;
  state.owners.set(event.laneId, { lane, phase });
  state.lastEventKey = key;
}

// The expandable blocks one event carries under its line: answer, hand-back, tool error.
function blocksOf(event: NarrationEvent, key: string): BlockItem[] {
  const body = event.body;
  if (typeof body !== "string" || body === "") return [];
  if (event.kind === "text" && body.trim() !== event.text.trim()) return [{ type: "block", key: `${key}-answer`, kind: "answer", event }];
  if (event.kind === "toolError") return [{ type: "block", key: `${key}-error`, kind: "toolError", event }];
  if (event.kind === "laneClose") return [{ type: "block", key: `${key}-handback`, kind: "handBack", event }];
  return [];
}

// The items one event becomes: a report is a block alone, any other event its line and its blocks.
function itemsOf(event: NarrationEvent, key: string): LaneChild[] {
  if (event.kind === "report") return [{ type: "block", key, kind: "report", event }];
  return [{ type: "line", key, event }, ...blocksOf(event, key)];
}

// Updates the counters of the phase and lane an event lands in, and the lane's close or orphan state.
function countEvent(event: NarrationEvent, phase: PhaseNode, lane: LaneNode | null) {
  if (event.kind === "report" && event.artifact) phase.report = event.artifact;
  if (event.kind === "tool") phase.tools += 1;
  if (!lane) return;
  if (event.kind === "tool") lane.tools += 1;
  if (event.kind === "tool" && event.file) lane.edits += 1;
  if (event.kind === "laneClose") lane.close = event;
  if (event.kind === "laneOrphan") lane.orphan = true;
}

// Places one event under its lane when the lane is known, else in the current phase.
function placeEvent(state: FoldState, event: NarrationEvent, key: string) {
  const owner = event.laneId ? state.owners.get(event.laneId) : undefined;
  const phase = owner?.phase ?? currentPhase(state);
  const target: PhaseItem[] = owner ? owner.lane.children : phase.items;
  for (const item of itemsOf(event, key)) target.push(item);
  countEvent(event, phase, owner?.lane ?? null);
  if (event.kind === "text" && !event.indent && event.body) state.lastAnswer = { key, event };
  if (event.kind !== "report") state.lastEventKey = key;
}

// Folds the narration of an attempt into phase → lane → event; the last orchestrator answer is the final report once the stream ended.
export function foldLog(events: readonly NarrationEvent[], { ended }: { ended: boolean }): LogTree {
  const state: FoldState = { phases: [], byNumber: new Map(), owners: new Map(), current: null, lastAnswer: null, lastEventKey: null };
  events.forEach((event, index) => {
    const key = `e${index}`;
    if (event.kind === "phase") enterPhase(state, event);
    else if (event.kind === "laneOpen") openLane(state, event, key);
    else placeEvent(state, event, key);
  });
  return { phases: state.phases, currentKey: state.current?.key ?? null, finalReport: ended ? state.lastAnswer : null, lastEventKey: state.lastEventKey };
}

// Tells whether an orchestrator tool line is notable: a memory recall, a phase marker, a run check or a phase done.
export function isNotableTool(event: NarrationEvent): boolean {
  if (event.tool && (MEMORY_TOOLS.has(event.tool) || event.tool === "run_phase_done")) return true;
  return Number.isInteger(event.phase) || RUN_CHECK.test(event.text);
}

// Tells whether one event line of a phase shows under the chips.
function eventVisible(event: NarrationEvent, chips: LogChips): boolean {
  if (ALWAYS_SHOWN_KINDS.has(event.kind)) return true;
  if (event.indent || LANE_KINDS.has(event.kind)) return chips.lanes;
  if (event.kind === "tool") return isNotableTool(event) ? chips.narrated : chips.orchestrator;
  return chips.narrated;
}

// Tells whether one item of a phase shows under the chips; report and tool-error blocks always do.
export function chipVisible(item: PhaseItem, chips: LogChips): boolean {
  if (item.type === "lane") return chips.lanes;
  if (item.type === "block") return item.kind === "answer" ? eventVisible(item.event, chips) : true;
  return eventVisible(item.event, chips);
}

// Tells whether a lane child is a plain tool line, the only kind a long run folds.
function isPlainTool(child: LaneChild): child is LineItem {
  return child.type === "line" && child.event.kind === "tool";
}

// One run of plain tool lines: its head and tail kept, the middle folded into a count.
function foldRun(run: LineItem[]): Array<LineItem | MoreItem> {
  const hidden = run.length - TOOL_RUN_HEAD - TOOL_RUN_TAIL;
  if (hidden < MIN_FOLDED_TOOLS) return run;
  const more: MoreItem = { type: "more", key: `${run[TOOL_RUN_HEAD].key}-more`, count: hidden };
  return [...run.slice(0, TOOL_RUN_HEAD), more, ...run.slice(-TOOL_RUN_TAIL)];
}

// The children of a lane with each long run of plain tool lines folded to `… N more tools`, unless all tools show.
export function foldTools(children: readonly LaneChild[], { allTools }: { allTools: boolean }): Array<LaneChild | MoreItem> {
  if (allTools) return [...children];
  const out: Array<LaneChild | MoreItem> = [];
  let run: LineItem[] = [];
  for (const child of children) {
    if (isPlainTool(child)) {
      run.push(child);
      continue;
    }
    for (const item of foldRun(run)) out.push(item);
    run = [];
    out.push(child);
  }
  for (const item of foldRun(run)) out.push(item);
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

// The first non-blank line of a text, its heading marker removed.
export function firstLineOf(text: string | null | undefined): string {
  const line = String(text ?? "").split("\n").find((candidate) => candidate.trim() !== "") ?? "";
  return line.replace(/^\s*#{1,6}\s+/, "").trim();
}
