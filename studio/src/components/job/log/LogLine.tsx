import { useMemo } from "react";
import { artifactPath, type BodyKind, formatBytes, type LogRow } from "../../../lib/log-tree";
import { EventGutter, EventRow, EventText } from "./EventRow";
import { Chevron, LogTag } from "./LogBits";
import { RowBody } from "./LogBlock";

const BODY_LABELS: Record<BodyKind, string> = { answer: "answer", handBack: "hand-back", report: "report", toolError: "tool error", gate: "gate" };

const BODY_RULES: Record<string, string> = {
  gateQuestion: "border-amber-line",
  operator: "border-amber-line",
  toolError: "border-tag-red-line",
  report: "border-tag-blue-line",
  laneClose: "border-lane-rule",
};

interface LogLineProps {
  row: LogRow;
  jobRef: string;
  open: boolean;
  onToggle: () => void;
  cursor: boolean;
}

// The UTF-8 size of a text, for the size caption of a body.
function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

// The size a line's body reads as: the artifact's size, a tool error's window, else the body's own bytes.
function useBodySize(row: LogRow): string {
  const body = row.event.body ?? "";
  const bytes = useMemo(() => utf8Bytes(body), [body]);
  if (row.body === "report") return formatBytes(row.event.bytes);
  if (row.body === "toolError") return "last 40 lines";
  return formatBytes(bytes);
}

// The `kind · size` caption at the right of a line with a body; a final report wears its green tag instead of its kind.
function BodyMeta({ row }: { row: LogRow }) {
  const size = useBodySize(row);
  return (
    <span className="ml-auto flex flex-none items-center gap-1.5 font-sans text-xs whitespace-nowrap text-dim">
      {row.final ? <LogTag tone="green">final report</LogTag> : <span>{BODY_LABELS[row.body as BodyKind]}</span>}
      <span>{`· ${size}`}</span>
    </span>
  );
}

// A line that carries a body: the line itself is the control, and the body opens under it in the line's tone.
function BodyLine({ row, jobRef, open, onToggle, cursor }: LogLineProps) {
  const rule = BODY_RULES[row.event.kind] ?? "border-line";
  return (
    <div>
      <div className="flex items-center gap-2 pr-3">
        <button type="button" aria-expanded={open} onClick={onToggle} className="flex min-h-[28px] min-w-0 grow items-center gap-2 border-0 bg-transparent py-px pl-3 text-left font-mono whitespace-pre-wrap [overflow-wrap:anywhere]">
          <EventGutter event={row.event} />
          <EventText event={row.event} cursor={cursor} className="underline decoration-dotted underline-offset-2" />
          <BodyMeta row={row} />
          <Chevron open={open} />
        </button>
        {row.body === "report" && (
          <a href={artifactPath(jobRef, row.event.artifact ?? "")} target="_blank" rel="noopener noreferrer" className="flex-none font-sans text-xs">
            raw ↗
          </a>
        )}
      </div>
      {open && (
        <div className={`mr-3 mb-1 ml-[76px] border-l-2 bg-inset ${rule}`}>
          <RowBody row={row} jobRef={jobRef} />
        </div>
      )}
    </div>
  );
}

// One line of the log: a plain narrated line, or a line whose body opens under it.
export function LogLine(props: LogLineProps) {
  if (!props.row.body) return <EventRow event={props.row.event} cursor={props.cursor} />;
  return <BodyLine {...props} />;
}
