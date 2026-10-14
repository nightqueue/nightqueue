import type { RecallKind } from "../../lib/types";
import { SideDrawer } from "../SideDrawer";
import { Markdown } from "./Markdown";

export interface MemoryEntry {
  ref: string;
  kind: RecallKind;
  title: string | null;
  text: string | null;
}

// The body of a lesson or memory hit: the title and the text the recall returned.
function RecalledBody({ entry }: { entry: MemoryEntry }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="text-[15px] font-medium text-fg">{entry.title ?? entry.ref}</div>
      <Markdown source={entry.text ?? "The recall returned no text for this entry."} />
    </div>
  );
}

// A read-only right drawer with the whole text of one recalled lesson or memory; Esc or the backdrop closes it.
export function MemoryDrawer({ entry, onClose }: { entry: MemoryEntry; onClose: () => void }) {
  return (
    <SideDrawer label={`${entry.kind} ${entry.ref}`} header={<MemoryDrawerHeader entry={entry} />} onClose={onClose}>
      <RecalledBody entry={entry} />
    </SideDrawer>
  );
}

// The drawer header: the entry's ref and its kind.
function MemoryDrawerHeader({ entry }: { entry: MemoryEntry }) {
  return (
    <>
      <div className="font-mono text-base font-semibold">{entry.ref}</div>
      <span className="text-xs text-dim">{entry.kind}</span>
    </>
  );
}
