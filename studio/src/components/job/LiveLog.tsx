import { type RefObject, useEffect, useMemo, useRef, useState } from "react";
import type { JobStreamState } from "../../lib/events";
import { DEFAULT_CHIPS, type FinalReport, foldLog, type LogChips, type LogTree } from "../../lib/log-tree";
import { type Toggles, useToggles } from "../../lib/useToggles";
import { Chip } from "../ui";
import { CardTitle } from "./Card";
import { FinalReportBlock } from "./log/LogBlock";
import { PhaseSection } from "./log/PhaseSection";
import type { TreeView } from "./log/TreeItem";

const BOTTOM_SLACK_PX = 24;

const CHIP_OPTIONS: readonly { key: keyof LogChips; label: string }[] = [
  { key: "narrated", label: "narrated" },
  { key: "orchestrator", label: "orchestrator" },
  { key: "lanes", label: "lanes" },
  { key: "allTools", label: "all tools" },
];

interface LiveLogProps {
  stream: JobStreamState;
  running: boolean;
  attempt: number;
  jobRef: string;
  startedAtMs: number | null;
}

interface LogToolbarProps {
  chips: LogChips;
  onChips: (chips: LogChips) => void;
  expandAll: boolean;
  onExpandAll: () => void;
  follow: boolean;
  onFollow: () => void;
}

// What the log's caption says about the stream: live, ended, or unavailable.
function streamCaption({ stream, running, attempt }: Pick<LiveLogProps, "stream" | "running" | "attempt">): string {
  if (stream.error && !stream.ended) return `narrated · ${stream.error}`;
  if (stream.ended) return `narrated · attempt ${attempt} · ended ${stream.ended.status ? `at ${stream.ended.status}` : ""}`.trim();
  return running ? "narrated · /events tail" : `narrated · attempt ${attempt}`;
}

// The empty or loading body of the log, shaped like phase rows with narrated lines.
function LogPlaceholder({ stream }: { stream: JobStreamState }) {
  if (stream.ended) return <p className="m-0 px-3 py-3 font-sans text-muted">{stream.ended.reason ?? "Nothing narrated in this attempt."}</p>;
  return (
    <div className="flex flex-col gap-2 px-3 py-3" aria-busy="true">
      <span className="block h-4 w-1/4 animate-pulse rounded bg-row-line" />
      {[70, 55, 80, 40, 65].map((width) => (
        <span key={width} className="ml-5 block h-3 animate-pulse rounded bg-row-line" style={{ width: `${width}%` }} />
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

// The phases of the tree, then the final report once the job ended; opening an earlier phase turns follow off.
function LogTreeBody({ tree, stream, phases, view, onLeaveFollow }: { tree: LogTree; stream: JobStreamState; phases: Toggles; view: TreeView; onLeaveFollow: () => void }) {
  const track = stream.timeline?.phases ?? [];
  const finalReport = tree.finalReport;
  return (
    <>
      {tree.phases.map((node) => {
        const current = node.key === tree.currentKey;
        const open = phases.isOpen(node.key, current);
        const onToggle = () => {
          phases.set(node.key, !open);
          if (!open && !current) onLeaveFollow();
        };
        return <PhaseSection key={node.key} node={node} track={track.find((phase) => phase.number === node.number)} open={open} onToggle={onToggle} view={view} />;
      })}
      {finalReport && <FinalReportSection report={finalReport} view={view} />}
    </>
  );
}

// The final report at the end of the tree, born expanded.
function FinalReportSection({ report, view }: { report: FinalReport; view: TreeView }) {
  const key = `${report.key}-final`;
  const open = view.blocks.isOpen(key, true);
  return (
    <div className="py-2">
      <FinalReportBlock event={report.event} jobRef={view.jobRef} open={open} onToggle={() => view.blocks.set(key, !open)} />
    </div>
  );
}

// The live log card: the current attempt folded as phase → lane → event, with its chips, expand all, follow and the blinking cursor while the job runs.
export function LiveLog({ stream, running, attempt, jobRef, startedAtMs }: LiveLogProps) {
  const tree = useMemo(() => foldLog(stream.events, { ended: stream.ended !== null }), [stream.events, stream.ended]);
  const [chips, setChips] = useState<LogChips>(DEFAULT_CHIPS);
  const [expandAll, setExpandAll] = useState(false);
  const phases = useToggles();
  const lanes = useToggles();
  const blocks = useToggles();
  const box = useRef<HTMLDivElement>(null);
  const { follow, setFollow, onScroll } = useFollow(box, stream.events.length);
  const live = running && !stream.ended;
  const view: TreeView = { jobRef, chips, lanes, blocks, expandAll, startedAtMs: live ? startedAtMs : null, cursorKey: live ? tree.lastEventKey : null, finalEvent: tree.finalReport?.event ?? null };
  const onExpandAll = () => {
    setExpandAll(!expandAll);
    blocks.reset();
  };
  return (
    <section aria-label="live log" className="flex min-w-0 flex-col rounded-lg border border-line bg-surface">
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2.5">
        <CardTitle>{running ? "Live log" : "Log"}</CardTitle>
        <span className="text-sm text-muted">{streamCaption({ stream, running, attempt })}</span>
        <LogToolbar chips={chips} onChips={setChips} expandAll={expandAll} onExpandAll={onExpandAll} follow={follow} onFollow={() => setFollow(!follow)} />
      </div>
      <div ref={box} onScroll={onScroll} className="max-h-[560px] overflow-auto font-mono text-[12.5px] leading-[1.65] text-log lg:h-[720px] lg:max-h-none">
        {stream.events.length === 0 ? <LogPlaceholder stream={stream} /> : <LogTreeBody tree={tree} stream={stream} phases={phases} view={view} onLeaveFollow={() => setFollow(false)} />}
      </div>
    </section>
  );
}
