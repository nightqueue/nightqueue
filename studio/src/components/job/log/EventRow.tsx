import { memo } from "react";
import { narrationTone } from "../../../lib/job";
import type { NarrationEvent } from "../../../lib/types";
import { LogCursor } from "./LogBits";

// The said part of a narrated line: the lane label and the text, its dim tail apart, and the cursor when it is the last.
export function EventText({ event, cursor, className = "" }: { event: NarrationEvent; cursor: boolean; className?: string }) {
  const text = event.text ?? "";
  const tail = event.dim && text.endsWith(event.dim) ? event.dim : "";
  const said = tail ? text.slice(0, text.length - tail.length) : text;
  const label = event.lane ? `[${event.lane}] ` : "";
  return (
    <span className={`min-w-0 ${narrationTone(event)} ${className}`}>
      {`${label}${said}`}
      {tail && <span className="text-log-dim">{tail}</span>}
      {cursor && <LogCursor />}
    </span>
  );
}

// The clock and glyph columns of a narrated line.
export function EventGutter({ event }: { event: NarrationEvent }) {
  return (
    <>
      <span className="w-[52px] flex-none text-dim">{event.clock}</span>
      <span className={`w-3 flex-none ${narrationTone(event)}`}>{event.glyph}</span>
    </>
  );
}

// One narrated line: clock, glyph, the lane label and the whole text wrapped, with its dim tail and the cursor when it is the last.
export const EventRow = memo(function EventRow({ event, cursor }: { event: NarrationEvent; cursor: boolean }) {
  return (
    <div className="flex gap-2 px-3 py-px whitespace-pre-wrap [overflow-wrap:anywhere]">
      <EventGutter event={event} />
      <EventText event={event} cursor={cursor} />
    </div>
  );
});
