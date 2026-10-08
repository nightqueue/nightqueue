import type { ReactNode } from "react";
import type { LaneGroup, LogRow } from "../../../lib/log-tree";
import { EventGutter, EventText } from "./EventRow";
import { Chevron, LaneRule } from "./LogBits";

interface LaneBlockProps {
  group: LaneGroup;
  open: boolean;
  onToggle: () => void;
  cursorKey: string | null;
  renderRow: (row: LogRow) => ReactNode;
}

// The `N tools` caption of a collapsed lane block.
function toolsCaption(count: number): string {
  return `${count} ${count === 1 ? "tool" : "tools"}`;
}

// The header of a lane block: its laneOpen line as the control, with the tool count while collapsed.
function LaneHeader({ group, open, onToggle, cursorKey }: Omit<LaneBlockProps, "renderRow">) {
  return (
    <button type="button" aria-expanded={open} onClick={onToggle} className="flex w-full min-w-0 items-center gap-2 border-0 bg-transparent py-px pr-3 pl-3 text-left font-mono whitespace-pre-wrap [overflow-wrap:anywhere]">
      <EventGutter event={group.head.event} />
      <EventText event={group.head.event} cursor={group.head.key === cursorKey} />
      {!open && <span className="ml-auto flex-none font-sans text-xs whitespace-nowrap text-dim">{toolsCaption(group.tools)}</span>}
      <span className={open ? "ml-auto flex-none" : "flex-none"}>
        <Chevron open={open} />
      </span>
    </button>
  );
}

// The lines a lane block shows: all of them open, only the latest tool call while collapsed and running, none once ended.
function shownRows(group: LaneGroup, open: boolean): LogRow[] {
  if (open) return group.rows;
  if (group.ended || !group.latest) return [];
  return [group.latest];
}

// One launched agent's lane as a collapsible block headed by its laneOpen line.
export function LaneBlock({ group, open, onToggle, cursorKey, renderRow }: LaneBlockProps) {
  const rows = shownRows(group, open);
  return (
    <div>
      <LaneHeader group={group} open={open} onToggle={onToggle} cursorKey={cursorKey} />
      {rows.length > 0 && (
        <LaneRule>
          {rows.map((row) => (
            <div key={row.key}>{renderRow(row)}</div>
          ))}
        </LaneRule>
      )}
    </div>
  );
}
