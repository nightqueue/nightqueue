import { type RefObject, useEffect, useRef, useState } from "react";
import type { JobStreamState } from "../../lib/events";
import { filterNarration, LOG_FILTERS, type LogFilter, narrationTone } from "../../lib/job";
import type { NarrationEvent } from "../../lib/types";
import { Chip } from "../ui";
import { CardTitle } from "./Card";

const BOTTOM_SLACK_PX = 24;

interface LiveLogProps {
  stream: JobStreamState;
  running: boolean;
  attempt: number;
}

// One narrated line: clock, lane indent, glyph, the lane label, the text with its dim tail.
function LogLine({ event }: { event: NarrationEvent }) {
  const text = event.text ?? "";
  const tail = event.dim && text.endsWith(event.dim) ? event.dim : "";
  const said = tail ? text.slice(0, text.length - tail.length) : text;
  const label = event.lane ? `[${event.lane}] ` : "";
  return (
    <div>
      <span className="text-dim">{event.clock}</span>
      {event.indent ? "      " : "  "}
      <span className={narrationTone(event)}>
        {`${event.glyph} ${label}${said}`}
        {tail && <span className="text-log-dim">{tail}</span>}
      </span>
    </div>
  );
}

// What the log's caption says about the stream: live, ended, or unavailable.
function streamCaption({ stream, running, attempt }: LiveLogProps): string {
  if (stream.error && !stream.ended) return `narrated · ${stream.error}`;
  if (stream.ended) return `narrated · attempt ${attempt} · ended ${stream.ended.status ? `at ${stream.ended.status}` : ""}`.trim();
  return running ? "narrated · /events tail" : `narrated · attempt ${attempt}`;
}

// The empty or loading body of the log, shaped like narrated lines.
function LogPlaceholder({ stream }: { stream: JobStreamState }) {
  if (stream.events.length > 0) return <p className="m-0 font-sans text-muted">No line of this attempt matches this chip.</p>;
  if (stream.ended) return <p className="m-0 font-sans text-muted">{stream.ended.reason ?? "Nothing narrated in this attempt."}</p>;
  return (
    <div className="flex flex-col gap-2" aria-busy="true">
      {[70, 55, 80, 40, 65].map((width) => (
        <span key={width} className="block h-3 animate-pulse rounded bg-row-line" style={{ width: `${width}%` }} />
      ))}
    </div>
  );
}

// Keeps a scrolled box at its bottom while `follow` is on; a scroll up turns follow off.
function useFollow(box: RefObject<HTMLDivElement | null>, count: number) {
  const [follow, setFollow] = useState(true);
  useEffect(() => {
    if (follow && box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [follow, count, box]);
  const onScroll = () => {
    const element = box.current;
    if (!element) return;
    const atBottom = element.scrollHeight - element.scrollTop - element.clientHeight <= BOTTOM_SLACK_PX;
    if (follow !== atBottom) setFollow(atBottom);
  };
  return { follow, setFollow, onScroll };
}

// The live log card: the narrated current attempt with its chips, follow toggle and the blinking cursor while the job runs.
export function LiveLog({ stream, running, attempt }: LiveLogProps) {
  const [filter, setFilter] = useState<LogFilter>("narrated");
  const box = useRef<HTMLDivElement>(null);
  const events = filterNarration(stream.events, filter);
  const { follow, setFollow, onScroll } = useFollow(box, events.length);
  return (
    <section aria-label="live log" className="flex min-w-0 flex-col rounded-lg border border-line bg-surface">
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2.5">
        <CardTitle>{running ? "Live log" : "Log"}</CardTitle>
        <span className="text-sm text-muted">{streamCaption({ stream, running, attempt })}</span>
        <div className="flex flex-wrap gap-1.5 sm:ml-auto">
          {LOG_FILTERS.map((option) => (
            <Chip key={option.value} on={filter === option.value} onClick={() => setFilter(option.value)}>
              {option.label}
            </Chip>
          ))}
          <span className="mx-1 w-px self-stretch bg-line" aria-hidden="true" />
          <Chip on={follow} onClick={() => setFollow(!follow)}>
            follow
          </Chip>
        </div>
      </div>
      <div ref={box} onScroll={onScroll} className="max-h-[560px] overflow-auto lg:h-[720px] lg:max-h-none px-3.5 py-3 font-mono text-[12.5px] leading-[1.7] whitespace-pre text-log lg:h-[720px]">
        {events.length === 0 ? <LogPlaceholder stream={stream} /> : events.map((event, index) => <LogLine key={index} event={event} />)}
        {running && !stream.ended && <div className="animate-blink text-accent">{"     "}  ▌</div>}
      </div>
    </section>
  );
}
