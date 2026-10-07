import { type ReactNode, type RefObject, useEffect, useMemo, useRef, useState } from "react";
import type { JobStreamState } from "../../lib/events";
import { attemptsLabel } from "../../lib/format";
import { DEFAULT_CHIPS, foldRows, foldStream, type LogChips, type LogRow, type LogStream, type MoreRow, rowVisible, type StreamContext } from "../../lib/log-tree";
import type { JobDetail } from "../../lib/types";
import { useToggles } from "../../lib/useToggles";
import { Chip } from "../ui";
import { CardTitle } from "./Card";
import { MoreToolsRow } from "./log/LogBits";
import { LogLine } from "./log/LogLine";

const BOTTOM_SLACK_PX = 24;

const CHIP_OPTIONS: readonly { key: keyof LogChips; label: string }[] = [
  { key: "narrated", label: "narrated" },
  { key: "orchestrator", label: "orchestrator" },
  { key: "lanes", label: "lanes" },
  { key: "allTools", label: "all tools" },
];

const SKELETON_WIDTHS = [30, 70, 55, 80, 40, 65];

interface LiveLogProps {
  stream: JobStreamState;
  job: JobDetail;
  jobRef: string;
}

interface LogToolbarProps {
  chips: LogChips;
  onChips: (chips: LogChips) => void;
  expandAll: boolean;
  onExpandAll: () => void;
  follow: boolean;
  onFollow: () => void;
}

interface LogBodyProps {
  items: Array<LogRow | MoreRow>;
  jobRef: string;
  isOpen: (row: LogRow) => boolean;
  onToggle: (row: LogRow, open: boolean) => void;
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

// The chips of the log: the four filters, expand all and follow.
function LogToolbar({ chips, onChips, expandAll, onExpandAll, follow, onFollow }: LogToolbarProps) {
  return (
    <div className="flex flex-wrap gap-1.5 sm:ml-auto">
      {CHIP_OPTIONS.map((option) => (
        <Chip key={option.key} on={chips[option.key]} onClick={() => onChips({ ...chips, [option.key]: !chips[option.key] })}>
          {option.label}
        </Chip>
      ))}
      <span className="mx-1 w-px self-stretch bg-line" aria-hidden="true" />
      <Chip on={expandAll} onClick={onExpandAll}>
        expand all
      </Chip>
      <Chip on={follow} onClick={onFollow}>
        follow
      </Chip>
    </div>
  );
}

// The cyan rule a subagent lane's lines sit under.
function LaneRule({ children }: { children: ReactNode }) {
  return <div className="ml-3 border-l-2 border-lane-rule pl-3">{children}</div>;
}

// The flat lines of the log, lane lines under their rule and folded tool runs as one count.
function LogBody({ items, jobRef, isOpen, onToggle, cursorKey }: LogBodyProps) {
  return (
    <div className="py-1">
      {items.map((item) => {
        if (item.type === "more") return <LaneRule key={item.key}><MoreToolsRow count={item.count} /></LaneRule>;
        const open = isOpen(item);
        const line = <LogLine row={item} jobRef={jobRef} open={open} onToggle={() => onToggle(item, !open)} cursor={item.key === cursorKey} />;
        return item.lane ? <LaneRule key={item.key}>{line}</LaneRule> : <div key={item.key}>{line}</div>;
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

// The folded stream with its visible lines, recomputed only when the stream, the job row or the chips move.
function useLogItems(stream: JobStreamState, job: JobDetail, chips: LogChips): { folded: LogStream; items: Array<LogRow | MoreRow> } {
  const folded = useMemo(() => foldStream(stream.events, streamContext(stream, job)), [stream, job]);
  const items = useMemo(() => foldRows(folded.rows.filter((row) => rowVisible(row, chips)), { allTools: chips.allTools }), [folded, chips]);
  return { folded, items };
}

// The live log card: every attempt of the job in one chronological stream, with its chips, expand all, follow and the blinking cursor while it runs.
export function LiveLog({ stream, job, jobRef }: LiveLogProps) {
  const [chips, setChips] = useState<LogChips>(DEFAULT_CHIPS);
  const [expandAll, setExpandAll] = useState(false);
  const { folded, items } = useLogItems(stream, job, chips);
  const blocks = useToggles();
  const box = useRef<HTMLDivElement>(null);
  const { follow, setFollow, onScroll } = useFollow(box, stream.events.length);
  const running = job.status === "running";
  const live = running && !stream.ended;
  const attempts = Math.max(Array.isArray(job.attempts_log) ? job.attempts_log.length : 0, folded.attemptCount);
  const lastKey = items.at(-1)?.key ?? null;
  const onToggle = (row: LogRow, open: boolean) => {
    blocks.set(row.key, open);
    if (open && row.key !== lastKey) setFollow(false);
  };
  const onExpandAll = () => {
    setExpandAll(!expandAll);
    blocks.reset();
  };
  return (
    <section aria-label="live log" className="flex min-w-0 flex-col rounded-lg border border-line bg-surface">
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2.5">
        <CardTitle>{running ? "Live log" : "Log"}</CardTitle>
        <span className="text-sm text-muted">{streamCaption({ stream, live, attempts })}</span>
        <LogToolbar chips={chips} onChips={setChips} expandAll={expandAll} onExpandAll={onExpandAll} follow={follow} onFollow={() => setFollow(!follow)} />
      </div>
      <div ref={box} onScroll={onScroll} className="max-h-[560px] overflow-auto font-mono text-[12.5px] leading-[1.65] text-log lg:h-[720px] lg:max-h-none">
        {stream.events.length === 0 ? (
          <LogPlaceholder stream={stream} />
        ) : (
          <LogBody items={items} jobRef={jobRef} isOpen={(row) => blocks.isOpen(row.key, expandAll || row.final)} onToggle={onToggle} cursorKey={live ? folded.lastEventKey : null} />
        )}
      </div>
    </section>
  );
}
