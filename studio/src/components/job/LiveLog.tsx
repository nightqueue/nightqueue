import { type RefObject, useEffect, useMemo, useRef, useState } from "react";
import type { JobStreamState } from "../../lib/events";
import { attemptsLabel } from "../../lib/format";
import { foldStream, groupLanes, type LaneGroup, type LogRow, type LogStream, type StreamContext } from "../../lib/log-tree";
import type { JobDetail } from "../../lib/types";
import { useToggles } from "../../lib/useToggles";
import { Chip } from "../ui";
import { CardTitle } from "./Card";
import { LaneBlock } from "./log/LaneBlock";
import { LaneRule } from "./log/LogBits";
import { LogLine } from "./log/LogLine";

const BOTTOM_SLACK_PX = 24;

const SKELETON_WIDTHS = [30, 70, 55, 80, 40, 65];

interface LiveLogProps {
  stream: JobStreamState;
  job: JobDetail;
  jobRef: string;
}

interface LogToolbarProps {
  expandAll: boolean;
  onExpandAll: () => void;
  follow: boolean;
  onFollow: () => void;
}

type LogItem = LogRow | LaneGroup;

type Openable = LogRow | LaneGroup;

interface LogBodyProps {
  items: LogItem[];
  jobRef: string;
  isOpen: (item: Openable) => boolean;
  onToggle: (item: Openable, open: boolean) => void;
  cursorKey: string | null;
}

// What the log's caption says about the stream: its attempts, live or ended, or the stream unavailable.
function streamCaption({ stream, live, attempts }: { stream: JobStreamState; live: boolean; attempts: number }): string {
  if (stream.error && !stream.ended) return `narrated · ${stream.error}`;
  if (stream.ended) return `${attemptsLabel(attempts)} · ended${stream.ended.status ? ` at ${stream.ended.status}` : ""}`;
  return live ? `${attemptsLabel(attempts)} · /events tail` : attemptsLabel(attempts);
}

// The empty or loading body of the log, shaped like flat narrated lines with their clock column.
function LogPlaceholder({ stream }: { stream: JobStreamState }) {
  if (stream.ended) return <p className="m-0 px-3 py-3 font-sans text-muted">{stream.ended.reason ?? "Nothing narrated."}</p>;
  return (
    <div className="flex flex-col gap-2 px-3 py-3" aria-busy="true">
      {SKELETON_WIDTHS.map((width) => (
        <div key={width} className="flex items-center gap-2">
          <span className="block h-3 w-[52px] flex-none animate-pulse rounded bg-row-line" />
          <span className="block h-3 animate-pulse rounded bg-row-line" style={{ width: `${width}%` }} />
        </div>
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

// The chips of the log: expand all and follow.
function LogToolbar({ expandAll, onExpandAll, follow, onFollow }: LogToolbarProps) {
  return (
    <div className="flex flex-wrap gap-1.5 sm:ml-auto">
      <Chip on={expandAll} onClick={onExpandAll}>
        expand all
      </Chip>
      <Chip on={follow} onClick={onFollow}>
        follow
      </Chip>
    </div>
  );
}

// The lines of the log: each seen lane as one collapsible block and other lane lines under their rule.
function LogBody({ items, jobRef, isOpen, onToggle, cursorKey }: LogBodyProps) {
  const renderRow = (row: LogRow) => {
    const open = isOpen(row);
    return <LogLine row={row} jobRef={jobRef} open={open} onToggle={() => onToggle(row, !open)} cursor={row.key === cursorKey} />;
  };
  return (
    <div className="py-1">
      {items.map((item) => {
        if (item.type === "lane") {
          const open = isOpen(item);
          return <LaneBlock key={item.key} group={item} open={open} onToggle={() => onToggle(item, !open)} cursorKey={cursorKey} renderRow={renderRow} />;
        }
        return item.lane ? <LaneRule key={item.key}>{renderRow(item)}</LaneRule> : <div key={item.key}>{renderRow(item)}</div>;
      })}
    </div>
  );
}

// The fold's context from the job row and the stream: attempts, status, the gate's notice and answer, the track's phase names.
function streamContext(stream: JobStreamState, job: JobDetail): StreamContext {
  const phaseNames = new Map((stream.timeline?.phases ?? []).map((phase) => [phase.number, phase.name]));
  const attempts = Array.isArray(job.attempts_log) ? job.attempts_log : [];
  return { ended: stream.ended !== null, attempts, status: job.status, notice: job.notice_md, operatorNote: job.operator_note, phaseNames };
}

// The folded stream with every line grouped by lane, recomputed only when the stream or the job row move.
function useLogItems(stream: JobStreamState, job: JobDetail): { folded: LogStream; items: LogItem[] } {
  const folded = useMemo(() => foldStream(stream.events, streamContext(stream, job)), [stream, job]);
  const items = useMemo(() => groupLanes(folded.rows, { ended: stream.ended !== null }), [folded, stream.ended]);
  return { folded, items };
}

// The live log card: every attempt of the job in one chronological stream, with expand all, follow and the blinking cursor while it runs.
export function LiveLog({ stream, job, jobRef }: LiveLogProps) {
  const [expandAll, setExpandAll] = useState(false);
  const { folded, items } = useLogItems(stream, job);
  const blocks = useToggles();
  const box = useRef<HTMLDivElement>(null);
  const { follow, setFollow, onScroll } = useFollow(box, stream.events.length);
  const running = job.status === "running";
  const live = running && !stream.ended;
  const attempts = Math.max(Array.isArray(job.attempts_log) ? job.attempts_log.length : 0, folded.attemptCount);
  const lastKey = items.at(-1)?.key ?? null;
  const onToggle = (item: Openable, open: boolean) => {
    blocks.set(item.key, open);
    if (open && item.key !== lastKey) setFollow(false);
  };
  const isOpen = (item: Openable) => blocks.isOpen(item.key, expandAll || (item.type === "line" && item.final));
  const onExpandAll = () => {
    setExpandAll(!expandAll);
    blocks.reset();
  };
  return (
    <section aria-label="live log" className="flex min-w-0 flex-col rounded-lg border border-line bg-surface">
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2.5">
        <CardTitle>{running ? "Live log" : "Log"}</CardTitle>
        <span className="text-sm text-muted">{streamCaption({ stream, live, attempts })}</span>
        <LogToolbar expandAll={expandAll} onExpandAll={onExpandAll} follow={follow} onFollow={() => setFollow(!follow)} />
      </div>
      <div ref={box} onScroll={onScroll} className="max-h-[560px] overflow-auto font-mono text-[12.5px] leading-[1.65] text-log lg:h-[720px] lg:max-h-none">
        {stream.events.length === 0 ? (
          <LogPlaceholder stream={stream} />
        ) : (
          <LogBody items={items} jobRef={jobRef} isOpen={isOpen} onToggle={onToggle} cursorKey={live ? folded.lastEventKey : null} />
        )}
      </div>
    </section>
  );
}
