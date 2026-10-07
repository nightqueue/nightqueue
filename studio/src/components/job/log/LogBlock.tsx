import { useQuery } from "@tanstack/react-query";
import { getText } from "../../../lib/api";
import { artifactPath, type LogRow, looksLikeMarkdown, rawLogPath } from "../../../lib/log-tree";
import type { NarrationEvent } from "../../../lib/types";
import { Markdown } from "../Markdown";

const BODY_CAP_LABEL = "32 KB";

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

// A phase artifact read from the run directory once, the first time its line opens.
function ReportBody({ jobRef, name, eventKey }: { jobRef: string; name: string; eventKey: string }) {
  const query = useQuery({ queryKey: ["artifact", jobRef, name, eventKey], queryFn: () => getText(artifactPath(jobRef, name)), staleTime: Infinity, retry: false });
  if (query.isPending) return <ReportSkeleton />;
  if (query.isError) return <p className="m-0 px-3 py-2 font-sans text-sm text-red">{`${name} cannot be read: ${query.error.message}`}</p>;
  return <Markdown source={query.data} rich className="px-3 pt-2 pb-1 font-sans" />;
}

// The body one line opens, by its kind: a report's artifact, a tool error's last lines, any other body as markdown.
export function RowBody({ row, jobRef }: { row: LogRow; jobRef: string }) {
  if (row.body === "report") return <ReportBody jobRef={jobRef} name={row.event.artifact ?? ""} eventKey={row.key} />;
  if (row.body === "toolError") return <ToolErrorBody event={row.event} jobRef={jobRef} />;
  return <MarkdownBody event={row.event} jobRef={jobRef} />;
}
