import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { errorText } from "../../lib/actions";
import { getJson } from "../../lib/api";
import { parseUnifiedDiff } from "../../lib/diff";
import { usePrFileUrl } from "../../lib/pr-file";
import { jobRef } from "../../lib/queue";
import type { DiffHunk, DiffKind, DiffLine, DiffLineKind, DiffstatFile, FileDiff, JobDetail } from "../../lib/types";
import { SideDrawer } from "../SideDrawer";
import { Button } from "../ui";
import { KindIcon } from "./DiffKindIcon";

const SKELETON_ROWS = ["w-3/5", "w-4/5", "w-2/5", "w-3/4", "w-1/2", "w-2/3"];

const LINE_STYLE: Record<DiffLineKind, { sign: string; className: string }> = {
  add: { sign: "+", className: "bg-green/10 text-green" },
  del: { sign: "−", className: "bg-red/10 text-red" },
  ctx: { sign: " ", className: "text-log" },
  meta: { sign: "", className: "text-dim italic" },
};

interface DiffDrawerProps {
  job: JobDetail;
  file: DiffstatFile;
  kind: DiffKind | null;
  onClose: () => void;
}

// The diff of one file of a job, read once each time the drawer opens.
function useFileDiff(ref: string, path: string) {
  return useQuery({
    queryKey: ["file-diff", ref, path],
    queryFn: () => getJson<FileDiff>(`/api/jobs/${encodeURIComponent(ref)}/diff?path=${encodeURIComponent(path)}`),
    staleTime: 0,
    retry: false,
  });
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

// The loading state of the diff, shaped like numbered code lines.
function DiffSkeleton() {
  return (
    <div className="flex flex-col gap-2" aria-busy="true" aria-label="loading the diff">
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

// One numbered line of a hunk, coloured by whether it was added, removed or kept.
function DiffLineRow({ line }: { line: DiffLine }) {
  const { sign, className } = LINE_STYLE[line.kind];
  return (
    <tr className={className}>
      <td className="w-[1%] px-2 text-right whitespace-nowrap text-dim select-none">{line.oldNo ?? ""}</td>
      <td className="w-[1%] px-2 text-right whitespace-nowrap text-dim select-none">{line.newNo ?? ""}</td>
      <td className="px-2 whitespace-pre">{`${sign}${line.text}`}</td>
    </tr>
  );
}

// One hunk: its `@@` header row then its lines.
function HunkRows({ hunk }: { hunk: DiffHunk }) {
  return (
    <>
      <tr className="bg-inset text-dim">
        <td colSpan={3} className="px-2 py-1 whitespace-pre">
          {hunk.header}
        </td>
      </tr>
      {hunk.lines.map((line, index) => (
        <DiffLineRow key={index} line={line} />
      ))}
    </>
  );
}

// The hunks of a diff as a table of old/new numbers and lines, scrolling sideways for long lines.
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

// The body for a diff the server read: binary, unchanged, or its hunks with a note when cut.
function DiffBody({ answer }: { answer: FileDiff }) {
  const { hunks, binary } = parseUnifiedDiff(answer.diff);
  if (answer.binary || binary) return <DiffMessage>binary file — no text diff</DiffMessage>;
  if (hunks.length === 0) return <DiffMessage>{answer.note ?? "no textual change"}</DiffMessage>;
  return (
    <div className="flex flex-col gap-2">
      <HunksTable hunks={hunks} />
      {answer.truncated && <DiffMessage>The diff was cut at 1 MiB; the rest is in the pull request or the worktree.</DiffMessage>}
    </div>
  );
}

// The drawer header: the kind icon and the path, the old name first for a rename.
function DiffDrawerHeader({ file, kind }: { file: DiffstatFile; kind: DiffKind | null }) {
  return (
    <>
      <span className="w-[14px] shrink-0">
        <KindIcon kind={kind} />
      </span>
      <div className="min-w-0 font-mono text-sm font-semibold break-all">{file.from ? `${file.from} → ${file.path}` : file.path}</div>
    </>
  );
}

// The drawer footer: Close, and the file in the pull request when there is one.
function DiffDrawerFooter({ prUrl, path, onClose }: { prUrl: string | null; path: string; onClose: () => void }) {
  return (
    <div className="flex w-full items-center">
      <Button variant="ghost" onClick={onClose}>
        Close
      </Button>
      {prUrl && (
        <span className="ml-auto text-sm">
          <PrFileLink prUrl={prUrl} path={path}>
            Open in PR ↗
          </PrFileLink>
        </span>
      )}
    </div>
  );
}

// A read-only right drawer with the diff of one file a job changed; Esc or the backdrop closes it.
export function DiffDrawer({ job, file, kind, onClose }: DiffDrawerProps) {
  const diff = useFileDiff(jobRef(job.id), file.path);
  const prUrl = job.pr_url ?? null;
  return (
    <SideDrawer
      label={`diff of ${file.path}`}
      header={<DiffDrawerHeader file={file} kind={kind} />}
      footer={<DiffDrawerFooter prUrl={prUrl} path={file.path} onClose={onClose} />}
      onClose={onClose}
      widthClass="sm:w-[720px]"
    >
      {diff.isPending && <DiffSkeleton />}
      {diff.isError && <DiffMessage tone="text-red">{`The diff cannot be read: ${errorText(diff.error)}`}</DiffMessage>}
      {diff.data?.source === "unavailable" && <UnavailableBody answer={diff.data} prUrl={prUrl} />}
      {diff.data?.source === "worktree" && <DiffBody answer={diff.data} />}
    </SideDrawer>
  );
}
