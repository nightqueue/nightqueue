import { useQuery } from "@tanstack/react-query";
import { type ReactNode, useMemo } from "react";
import { getText } from "../../../lib/api";
import { artifactPath, type BlockItem, firstLineOf, formatBytes, looksLikeMarkdown, rawLogPath } from "../../../lib/log-tree";
import type { NarrationEvent } from "../../../lib/types";
import { Markdown } from "../Markdown";
import { Chevron, LogTag, type TagTone } from "./LogBits";

const BODY_CAP_LABEL = "32 KB";

interface BlockPanelProps {
  open: boolean;
  onToggle: () => void;
  tag: string;
  tone?: TagTone;
  name: string;
  detail?: string;
  meta: ReactNode;
  final?: boolean;
  children: ReactNode;
}

interface BlockProps {
  item: BlockItem;
  jobRef: string;
  open: boolean;
  onToggle: () => void;
}

// The UTF-8 size of a text, for the size caption of a block.
function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

// An inset expandable panel of the log: tag, first line and meta on its row, the content below while open.
function BlockPanel({ open, onToggle, tag, tone = "plain", name, detail, meta, final = false, children }: BlockPanelProps) {
  return (
    <div className={`my-1 overflow-hidden rounded-md border bg-inset ${final ? "mx-3 border-run-line" : "mr-3 ml-16 border-line"}`}>
      <div className="flex items-center gap-2 px-2.5 py-1.5 text-sm text-muted">
        <button type="button" aria-expanded={open} onClick={onToggle} className="flex min-w-0 grow items-center gap-2 border-0 bg-transparent p-0 text-left text-muted">
          <Chevron open={open} />
          <LogTag tone={tone}>{tag}</LogTag>
          <span className="min-w-0 truncate font-sans text-fg">{name}</span>
          {detail && <span className="min-w-0 truncate text-log-dim">{`— ${detail}`}</span>}
        </button>
        <span className="ml-auto flex-none text-xs whitespace-nowrap text-dim">{meta}</span>
      </div>
      {open && <div className="border-t border-row-line">{children}</div>}
    </div>
  );
}

// The note of a body the narration cut at 32 KB, linking to the raw log from where it was cut.
function TruncatedNote({ event, jobRef }: { event: NarrationEvent; jobRef: string }) {
  if (!event.body_truncated) return null;
  return (
    <p className="m-0 px-3 pb-2 font-sans text-xs text-dim">
      {`cut at ${BODY_CAP_LABEL}`}
      {event.body_offset !== null && (
        <>
          {" · "}
          <a href={rawLogPath(jobRef, event.body_offset)} target="_blank" rel="noopener noreferrer">
            raw log ↗
          </a>
        </>
      )}
    </p>
  );
}

// A body rendered as markdown, with its truncation note.
function MarkdownBody({ event, jobRef }: { event: NarrationEvent; jobRef: string }) {
  return (
    <>
      <Markdown source={event.body ?? ""} rich className="px-3 pt-2 pb-1 font-sans" />
      <TruncatedNote event={event} jobRef={jobRef} />
    </>
  );
}

// A failed tool's last lines: a mono pre, or markdown when the text reads as markdown.
function ToolErrorBody({ event, jobRef }: { event: NarrationEvent; jobRef: string }) {
  const body = event.body ?? "";
  if (looksLikeMarkdown(body)) return <MarkdownBody event={event} jobRef={jobRef} />;
  return (
    <>
      <pre className="m-0 max-h-[220px] overflow-auto px-3 py-2 text-sm whitespace-pre-wrap text-log">{body}</pre>
      <TruncatedNote event={event} jobRef={jobRef} />
    </>
  );
}

// The loading shape of a report: a heading bar and a few text lines.
function ReportSkeleton() {
  return (
    <div className="flex flex-col gap-2 px-3 py-2.5" aria-busy="true">
      <span className="block h-3 w-1/3 animate-pulse rounded bg-row-line" />
      {[90, 75, 82].map((width) => (
        <span key={width} className="block h-2.5 animate-pulse rounded bg-row-line" style={{ width: `${width}%` }} />
      ))}
    </div>
  );
}

// A phase artifact read from the run directory once, the first time its block opens.
function ReportBody({ jobRef, name, eventKey }: { jobRef: string; name: string; eventKey: string }) {
  const query = useQuery({ queryKey: ["artifact", jobRef, name, eventKey], queryFn: () => getText(artifactPath(jobRef, name)), staleTime: Infinity, retry: false });
  if (query.isPending) return <ReportSkeleton />;
  if (query.isError) return <p className="m-0 px-3 py-2 font-sans text-sm text-red">{`${name} cannot be read: ${query.error.message}`}</p>;
  return <Markdown source={query.data} rich className="px-3 pt-2 pb-1 font-sans" />;
}

// A report block: the artifact's name and title, its size and a link to the raw file.
function ReportBlock({ item, jobRef, open, onToggle }: BlockProps) {
  const name = item.event.artifact ?? "";
  const meta = (
    <>
      {`${formatBytes(item.event.bytes)} · `}
      <a href={artifactPath(jobRef, name)} target="_blank" rel="noopener noreferrer">
        open ↗
      </a>
    </>
  );
  return (
    <BlockPanel open={open} onToggle={onToggle} tag="report" tone="blue" name={name} detail={item.event.title ?? undefined} meta={meta}>
      <ReportBody jobRef={jobRef} name={name} eventKey={item.key} />
    </BlockPanel>
  );
}

// An answer or hand-back block: the body's first line on the row, the whole body as markdown.
function TextBlock({ item, jobRef, open, onToggle }: BlockProps) {
  const body = item.event.body ?? "";
  const bytes = useMemo(() => utf8Bytes(body), [body]);
  const tag = item.kind === "handBack" ? "hand-back" : "answer";
  return (
    <BlockPanel open={open} onToggle={onToggle} tag={tag} name={firstLineOf(body)} meta={formatBytes(bytes)}>
      <MarkdownBody event={item.event} jobRef={jobRef} />
    </BlockPanel>
  );
}

// One expandable block of the tree, by its kind.
export function LogBlock(props: BlockProps) {
  if (props.item.kind === "report") return <ReportBlock {...props} />;
  if (props.item.kind === "toolError") {
    return (
      <BlockPanel open={props.open} onToggle={props.onToggle} tag="tool error" tone="red" name={props.item.event.tool ?? props.item.event.text} meta="last 40 lines">
        <ToolErrorBody event={props.item.event} jobRef={props.jobRef} />
      </BlockPanel>
    );
  }
  return <TextBlock {...props} />;
}

// The run's last answer, tagged final report and shown at the end of the tree once the job ended.
export function FinalReportBlock({ event, jobRef, open, onToggle }: { event: NarrationEvent; jobRef: string; open: boolean; onToggle: () => void }) {
  const body = event.body ?? "";
  const bytes = useMemo(() => utf8Bytes(body), [body]);
  return (
    <BlockPanel open={open} onToggle={onToggle} tag="final report" tone="green" name={firstLineOf(body)} meta={`rendered markdown · ${formatBytes(bytes)}`} final>
      <MarkdownBody event={event} jobRef={jobRef} />
    </BlockPanel>
  );
}
