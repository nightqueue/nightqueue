import { formatDurationMs } from "../../../lib/format";
import { chipVisible, PHASE_NAMES, type PhaseNode } from "../../../lib/log-tree";
import type { TimelinePhase } from "../../../lib/types";
import { useNow } from "../../../lib/useNow";
import { spentMs } from "../PhaseTimeline";
import { LaneSection } from "./LaneSection";
import { Chevron, countLabel, LogTag, type TagTone } from "./LogBits";
import { type TreeView, TreeItem } from "./TreeItem";

const STATE_TAGS: Partial<Record<TimelinePhase["state"], { label: string; tone: TagTone }>> = {
  done: { label: "done", tone: "green" },
  now: { label: "running", tone: "accent" },
  gate: { label: "gate", tone: "red" },
};

interface PhaseSectionProps {
  node: PhaseNode;
  track: TimelinePhase | undefined;
  open: boolean;
  onToggle: () => void;
  view: TreeView;
}

// The time a running phase has spent, ticking from the attempt's start.
function LivePhaseTime({ phase, startedAtMs }: { phase: TimelinePhase; startedAtMs: number }) {
  const now = useNow();
  return <span className="text-accent">{formatDurationMs(spentMs(phase, now - startedAtMs))}</span>;
}

// The duration of a phase from the timeline: ticking while it runs, its summed time otherwise.
function PhaseTime({ phase, startedAtMs }: { phase: TimelinePhase | undefined; startedAtMs: number | null }) {
  if (!phase || (phase.durationMs === null && phase.liveSinceMs === null)) return null;
  if (phase.state === "now" && phase.liveSinceMs !== null && startedAtMs !== null) return <LivePhaseTime phase={phase} startedAtMs={startedAtMs} />;
  return <span>{formatDurationMs(phase.durationMs)}</span>;
}

// The title of a phase row: number, name and model.
function phaseTitle(node: PhaseNode, track: TimelinePhase | undefined): string {
  const name = track?.name ?? PHASE_NAMES.get(node.number) ?? node.agent ?? "phase";
  const model = track?.model ?? node.model;
  return model ? `${node.number} ${name} · ${model}` : `${node.number} ${name}`;
}

// The right-hand caption of a phase row: duration, tokens, lanes and tools, and its last report.
function PhaseMeta({ node, track, startedAtMs }: { node: PhaseNode; track: TimelinePhase | undefined; startedAtMs: number | null }) {
  const counts = node.lanes > 0 ? `${countLabel(node.lanes, "lane")} · ${countLabel(node.tools, "tool")}` : countLabel(node.tools, "tool");
  return (
    <span className="ml-auto flex items-center gap-2.5 font-sans text-xs whitespace-nowrap text-dim">
      <PhaseTime phase={track} startedAtMs={startedAtMs} />
      {track && track.tokens > 0 && <span className={track.state === "now" ? "text-accent" : ""}>{`${track.tokens_label} tok`}</span>}
      <span>{counts}</span>
      {node.report && <LogTag tone="blue">{node.report}</LogTag>}
    </span>
  );
}

// One phase of the tree: its inset row, and its events and lanes only while open.
export function PhaseSection({ node, track, open, onToggle, view }: PhaseSectionProps) {
  const state = track ? STATE_TAGS[track.state] : undefined;
  return (
    <div className="border-b border-row-line">
      <button type="button" aria-expanded={open} onClick={onToggle} className="flex w-full items-center gap-2 border-0 bg-inset px-3 py-[7px] text-left font-sans">
        <Chevron open={open} />
        <span className={`font-medium ${track?.state === "done" ? "text-muted" : "text-fg"}`}>{phaseTitle(node, track)}</span>
        {state && <LogTag tone={state.tone}>{state.label}</LogTag>}
        <PhaseMeta node={node} track={track} startedAtMs={view.startedAtMs} />
      </button>
      {open && (
        <div className="pt-0.5 pb-1.5 pl-5">
          {node.items
            .filter((item) => chipVisible(item, view.chips))
            .map((item) => (item.type === "lane" ? <LaneSection key={item.key} lane={item} view={view} /> : <TreeItem key={item.key} item={item} view={view} />))}
        </div>
      )}
    </div>
  );
}
