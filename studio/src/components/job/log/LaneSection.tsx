import { formatDurationMs } from "../../../lib/format";
import { foldTools, type LaneNode } from "../../../lib/log-tree";
import { useNow } from "../../../lib/useNow";
import { Chevron, countLabel } from "./LogBits";
import { type TreeView, TreeItem } from "./TreeItem";

// The time a lane has been running, ticking from the attempt's start.
function LaneRunningTime({ startedAtMs, openedAtMs }: { startedAtMs: number; openedAtMs: number }) {
  const now = useNow();
  return <>{formatDurationMs(Math.max(0, now - startedAtMs - openedAtMs))}</>;
}

// The right-hand caption of a lane: its close summary, never reported back, or its running time and counts.
function LaneMeta({ lane, startedAtMs }: { lane: LaneNode; startedAtMs: number | null }) {
  const counts = `${countLabel(lane.tools, "tool")} · ${countLabel(lane.edits, "edit")}`;
  if (lane.close) return <span className="text-dim">{`${formatDurationMs(lane.close.durationMs)} · ${counts}`}</span>;
  if (lane.orphan) return <span className="text-red">{`never reported back · ${counts}`}</span>;
  const openedAtMs = lane.open.elapsedMs;
  return (
    <span className="text-accent">
      {"running "}
      {startedAtMs !== null && openedAtMs !== null ? <LaneRunningTime startedAtMs={startedAtMs} openedAtMs={openedAtMs} /> : "-"}
      {` · ${counts}`}
    </span>
  );
}

// A subagent lane: the cyan rule, its ▶ row with agent, phase, model and summary, and its events while open.
export function LaneSection({ lane, view }: { lane: LaneNode; view: TreeView }) {
  const open = view.lanes.isOpen(lane.key, true);
  const { agent, phase, model } = lane.open;
  const where = [Number.isInteger(phase) ? `phase ${phase}` : null, model].filter(Boolean).join(" · ");
  return (
    <div className="my-0.5 ml-3 border-l-2 border-lane-rule">
      <button type="button" aria-expanded={open} onClick={() => view.lanes.set(lane.key, !open)} className="flex w-full items-center gap-2 border-0 bg-transparent px-3 py-[3px] text-left font-mono">
        <Chevron open={open} />
        <span className="text-log-lane">▶</span>
        <span className="text-log-lane">{agent ?? lane.open.text}</span>
        {where && <span className="text-log-dim">{where}</span>}
        <span className="ml-auto text-xs whitespace-nowrap">
          <LaneMeta lane={lane} startedAtMs={view.startedAtMs} />
        </span>
      </button>
      {open && (
        <div className="pl-4">
          {foldTools(lane.children, { allTools: view.chips.allTools }).map((item) => (
            <TreeItem key={item.key} item={item} view={view} />
          ))}
        </div>
      )}
    </div>
  );
}
