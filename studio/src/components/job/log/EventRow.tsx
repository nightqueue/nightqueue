import { memo } from "react";
import { narrationTone } from "../../../lib/job";
import type { NarrationEvent } from "../../../lib/types";
import { LogCursor } from "./LogBits";

// One narrated line: clock, glyph, the lane label and the whole text wrapped, with its dim tail and the cursor when it is the last.
export const EventRow = memo(function EventRow({ event, cursor }: { event: NarrationEvent; cursor: boolean }) {
  const text = event.text ?? "";
  const tail = event.dim && text.endsWith(event.dim) ? event.dim : "";
  const said = tail ? text.slice(0, text.length - tail.length) : text;
  const label = event.lane ? `[${event.lane}] ` : "";
  const tone = narrationTone(event);
  return (
    <div className="flex gap-2 px-3 py-px whitespace-pre-wrap [overflow-wrap:anywhere]">
      <span className="w-[52px] flex-none text-dim">{event.clock}</span>
      <span className={`w-3 flex-none ${tone}`}>{event.glyph}</span>
      <span className={`min-w-0 ${tone}`}>
        {`${label}${said}`}
        {tail && <span className="text-log-dim">{tail}</span>}
        {cursor && <LogCursor />}
      </span>
    </div>
  );
});
