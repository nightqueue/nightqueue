import type { BlockItem, LaneChild, LogChips, MoreItem } from "../../../lib/log-tree";
import type { NarrationEvent } from "../../../lib/types";
import type { Toggles } from "../../../lib/useToggles";
import { EventRow } from "./EventRow";
import { LogBlock } from "./LogBlock";
import { MoreToolsRow } from "./LogBits";

export interface TreeView {
  jobRef: string;
  chips: LogChips;
  lanes: Toggles;
  blocks: Toggles;
  expandAll: boolean;
  startedAtMs: number | null;
  cursorKey: string | null;
  finalEvent: NarrationEvent | null;
}

// Tells whether a block is the answer the final report already shows at the end of the tree.
function isFinalAnswer(item: BlockItem, view: TreeView): boolean {
  return item.kind === "answer" && item.event === view.finalEvent;
}

// One leaf of the tree: an event line, an expandable block or the folded tools of a lane.
export function TreeItem({ item, view }: { item: LaneChild | MoreItem; view: TreeView }) {
  if (item.type === "more") return <MoreToolsRow count={item.count} />;
  if (item.type === "line") return <EventRow event={item.event} cursor={item.key === view.cursorKey} />;
  if (isFinalAnswer(item, view)) return null;
  const open = view.blocks.isOpen(item.key, view.expandAll);
  return <LogBlock item={item} jobRef={view.jobRef} open={open} onToggle={() => view.blocks.set(item.key, !open)} />;
}
