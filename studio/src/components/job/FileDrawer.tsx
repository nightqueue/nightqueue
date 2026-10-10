import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { type ReactNode, useEffect } from "react";
import { errorText } from "../../lib/actions";
import { getJson } from "../../lib/api";
import { countsCell, drawerStep, fileKind, proportionBar } from "../../lib/files";
import { usePrFileUrl } from "../../lib/pr-file";
import { jobRef } from "../../lib/queue";
import type { DiffHunk, DiffLine, DiffstatFile, FileDiff, JobDetail } from "../../lib/types";
import { SideDrawer } from "../SideDrawer";
import { ICON_STROKE } from "../StatusIcon";
import { Button } from "../ui";
import { KindIcon } from "./DiffKindIcon";

const SKELETON_ROWS = ["w-3/5", "w-4/5", "w-2/5", "w-3/4", "w-1/2", "w-2/3"];

const TYPING_TAGS = ["INPUT", "TEXTAREA", "SELECT"];

const LINE_STYLE: Record<DiffLine["type"], { sign: string; className: string }> = {
  add: { sign: "+", className: "bg-[#0f2418] text-fg" },
  del: { sign: "−", className: "bg-[#2a1515] text-fg" },
  ctx: { sign: " ", className: "text-log" },
};

interface FileDrawerProps {
  job: JobDetail;
  files: DiffstatFile[];
  index: number;
  onMove: (index: number) => void;
  onClose: () => void;
}

// The diff of one file of a job, read once each time the drawer shows it.
function useFileDiff(ref: string, path: string) {
  return useQuery({
    queryKey: ["file-diff", ref, path],
    queryFn: () => getJson<FileDiff>(`/api/jobs/${encodeURIComponent(ref)}/diff?path=${encodeURIComponent(path)}`),
    staleTime: 0,
    retry: false,
  });
}

// Whether a key event comes from a field the operator is typing in.
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || TYPING_TAGS.includes(target.tagName);
}

// Moves to the previous or next file on a bare ↑/↓ while the drawer is open, never while typing.
function useFileArrows(index: number, count: number, onMove: (index: number) => void) {
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || isTypingTarget(event.target)) return;
      if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
      const step = drawerStep(event.key, index, count);
      if (!step || !("move" in step)) return;
      event.preventDefault();
      onMove(step.move);
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, [index, count, onMove]);
}

// A link to one file in the pull request diff.
function PrFileLink({ prUrl, path, children }: { prUrl: string; path: string; children: ReactNode }) {
  const url = usePrFileUrl(prUrl, path);
  return (
    <a href={url.data ?? `${prUrl}/files`} target="_blank" rel="noreferrer" className="text-link no-underline hover:underline">
      {children}
    </a>
  );
}

// The loading state of the diff, shaped like the counts line and numbered code lines.
function DiffSkeleton() {
  return (
    <div className="flex flex-col gap-2" aria-busy="true" aria-label="loading the diff">
      <span className="mb-1 block h-3 w-40 animate-pulse rounded bg-row-line" />
      {SKELETON_ROWS.map((width) => (
        <div key={width} className="flex items-center gap-3">
          <span className="block h-3 w-6 animate-pulse rounded bg-row-line" />
          <span className="block h-3 w-6 animate-pulse rounded bg-row-line" />
          <span className={`block h-3 animate-pulse rounded bg-row-line ${width}`} />
        </div>
      ))}
    </div>
  );
}

// A short sentence in place of the diff.
function DiffMessage({ children, tone = "text-dim" }: { children: ReactNode; tone?: string }) {
  return <p className={`m-0 text-sm ${tone}`}>{children}</p>;
}

// Why no diff can be shown, with the link to the file in the pull request when there is one.
function UnavailableBody({ answer, prUrl }: { answer: FileDiff; prUrl: string | null }) {
  return (
    <div className="flex flex-col gap-2">
      <DiffMessage tone="text-fg">diff unavailable</DiffMessage>
      {answer.note && <DiffMessage>{answer.note}</DiffMessage>}
      {prUrl && (
        <PrFileLink prUrl={prUrl} path={answer.path}>
          See this file in the pull request ↗
        </PrFileLink>
      )}
    </div>
  );
}

// The +/− of the file and its 120×8 proportion bar, green additions then red deletions.
function DiffCounts({ answer }: { answer: FileDiff }) {
  const { adds, dels } = countsCell({ added: answer.adds, deleted: answer.dels });
  const bar = proportionBar(answer.adds, answer.dels);
  if (!adds && !dels) return null;
  return (
    <div className="mb-3 flex items-center gap-3 font-mono text-[12px] font-medium">
      {adds && <span className="text-green">{adds}</span>}
      {dels && <span className="text-red">{dels}</span>}
      <span className="flex h-2 w-[120px] gap-[2px]" aria-hidden>
        {bar.add > 0 && <i className="block h-2 rounded-[1px] bg-[#5aa07a]" style={{ width: bar.add }} />}
        {bar.del > 0 && <i className="block h-2 rounded-[1px] bg-[#da3633]" style={{ width: bar.del }} />}
      </span>
    </div>
  );
}

// One numbered line of a hunk, coloured by whether it was added, removed or kept.
function DiffLineRow({ line }: { line: DiffLine }) {
  const { sign, className } = LINE_STYLE[line.type] ?? LINE_STYLE.ctx;
  return (
    <tr className={className}>
      <td className="w-[1%] px-2 text-right whitespace-nowrap text-[#4f5668] select-none">{line.old ?? ""}</td>
      <td className="w-[1%] px-2 text-right whitespace-nowrap text-[#4f5668] select-none">{line.new ?? ""}</td>
      <td className="px-2 whitespace-pre">{`${sign}${line.text}`}</td>
    </tr>
  );
}

// One hunk: its `@@` header row then its lines.
function HunkRows({ hunk }: { hunk: DiffHunk }) {
  return (
    <>
      <tr className="bg-[#0e1420] text-link">
        <td colSpan={3} className="px-2 py-1 whitespace-pre">
          {hunk.header}
        </td>
      </tr>
      {(Array.isArray(hunk.lines) ? hunk.lines : []).map((line, index) => (
        <DiffLineRow key={index} line={line} />
      ))}
    </>
  );
}

// The hunks of a diff as a unified table of old/new numbers and lines, scrolling sideways for long lines.
function HunksTable({ hunks }: { hunks: DiffHunk[] }) {
  return (
    <div className="overflow-x-auto rounded border border-line">
      <table className="w-full border-collapse font-mono text-[12px] leading-[1.5]">
        <tbody>
          {hunks.map((hunk, index) => (
            <HunkRows key={index} hunk={hunk} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

// Why the shown hunks stop early: the server's byte-cut note, else the 2,000-line cap.
function TruncatedNote({ note }: { note: string | null }) {
  return <DiffMessage>{note ?? "Only the first 2,000 lines are shown; the rest is in the pull request."}</DiffMessage>;
}

// The body for a diff the server read: binary, unchanged, or its hunks with a note when cut.
function DiffBody({ answer }: { answer: FileDiff }) {
  const hunks = Array.isArray(answer.hunks) ? answer.hunks : [];
  if (answer.binary) return <DiffMessage>binary file — no text diff</DiffMessage>;
  return (
    <div className="flex flex-col gap-2">
      <DiffCounts answer={answer} />
      {hunks.length === 0 ? <DiffMessage>{answer.note ?? "no textual change"}</DiffMessage> : <HunksTable hunks={hunks} />}
      {answer.truncated && hunks.length > 0 && <TruncatedNote note={answer.note} />}
    </div>
  );
}

// An icon button of the drawer header.
function HeaderIconButton({ label, disabled = false, onClick, children }: { label: string; disabled?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <Button variant="ghost" size="sm" aria-label={label} title={label} disabled={disabled} onClick={onClick} className="px-1">
      {children}
    </Button>
  );
}

// The drawer header: the kind icon, the path (old name first for a rename), the file stepper and the close button.
function FileDrawerHeader({ file, index, count, onMove, onClose }: { file: DiffstatFile; index: number; count: number; onMove: (index: number) => void; onClose: () => void }) {
  return (
    <>
      <span className="w-[14px] shrink-0">
        <KindIcon kind={fileKind(file)} />
      </span>
      <div className="min-w-0 grow font-mono text-sm font-semibold break-all">{file.from ? `${file.from} → ${file.path}` : file.path}</div>
      <div className="flex shrink-0 items-center gap-1 text-sm text-muted">
        <HeaderIconButton label="previous file" disabled={index <= 0} onClick={() => onMove(index - 1)}>
          <ChevronLeft size={14} strokeWidth={ICON_STROKE} aria-hidden />
        </HeaderIconButton>
        <span className="font-mono text-[12px] whitespace-nowrap">{`${index + 1} / ${count}`}</span>
        <HeaderIconButton label="next file" disabled={index >= count - 1} onClick={() => onMove(index + 1)}>
          <ChevronRight size={14} strokeWidth={ICON_STROKE} aria-hidden />
        </HeaderIconButton>
        <HeaderIconButton label="close" onClick={onClose}>
          <X size={14} strokeWidth={ICON_STROKE} aria-hidden />
        </HeaderIconButton>
      </div>
    </>
  );
}

// The drawer footer: the keyboard hint, and the file in the pull request when there is one.
function FileDrawerFooter({ prUrl, path }: { prUrl: string | null; path: string }) {
  return (
    <div className="flex w-full items-center text-sm">
      <span className="text-dim">Esc closes · ↑↓ previous/next file</span>
      {prUrl && (
        <span className="ml-auto">
          <PrFileLink prUrl={prUrl} path={path}>
            Open in PR ↗
          </PrFileLink>
        </span>
      )}
    </div>
  );
}

// A read-only right drawer with the diff of one file a job changed, stepping through the job's files; Esc or the backdrop closes it.
export function FileDrawer({ job, files, index, onMove, onClose }: FileDrawerProps) {
  const file = files[index];
  const diff = useFileDiff(jobRef(job.id), file.path);
  const prUrl = job.pr_url ?? null;
  useFileArrows(index, files.length, onMove);
  return (
    <SideDrawer
      label={`diff of ${file.path}`}
      header={<FileDrawerHeader file={file} index={index} count={files.length} onMove={onMove} onClose={onClose} />}
      footer={<FileDrawerFooter prUrl={prUrl} path={file.path} />}
      onClose={onClose}
      headerClassName="bg-inset"
    >
      {diff.isPending && <DiffSkeleton />}
      {diff.isError && <DiffMessage tone="text-red">{`The diff cannot be read: ${errorText(diff.error)}`}</DiffMessage>}
      {diff.data?.source === "unavailable" && <UnavailableBody answer={diff.data} prUrl={prUrl} />}
      {diff.data && diff.data.source !== "unavailable" && <DiffBody answer={diff.data} />}
    </SideDrawer>
  );
}
