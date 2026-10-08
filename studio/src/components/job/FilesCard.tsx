import { useQuery } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { errorText } from "../../lib/actions";
import { getJson } from "../../lib/api";
import { blocks5, prNumber, thousands } from "../../lib/format";
import { jobRef } from "../../lib/queue";
import type { DiffKind, Diffstat, DiffstatFile, JobDetail } from "../../lib/types";
import { useNow } from "../../lib/useNow";
import { CardEmpty, CardTitle } from "./Card";
import { DiffDrawer } from "./DiffDrawer";
import { KindIcon } from "./DiffKindIcon";

const RUNNING_REFRESH_MS = 10_000;

const SKELETON_ROWS = ["w-4/5", "w-3/5", "w-2/3"];

type OpenFile = (file: DiffstatFile) => void;

const ROW_GRID ="grid grid-cols-[minmax(0,1fr)_34px_52px_44px_34px] items-center gap-x-2 px-3.5 py-[5px]";

// The diffstat of one job, refreshed every 10 s while it runs.
function useDiffstat(ref: string, running: boolean) {
  return useQuery({
    queryKey: ["diffstat", ref],
    queryFn: () => getJson<Diffstat>(`/api/jobs/${encodeURIComponent(ref)}/diffstat`),
    refetchInterval: running ? RUNNING_REFRESH_MS : false,
  });
}

// The files of an answer, an empty list when the payload carries none.
function filesOf(diffstat: Diffstat | undefined): DiffstatFile[] {
  return Array.isArray(diffstat?.files) ? diffstat.files : [];
}

// The kind of one file, `new` for an untracked entry of a server that predates kinds.
function kindOf(file: DiffstatFile): DiffKind | null {
  if (file.kind) return file.kind;
  return file.untracked === true ? "new" : null;
}

// A positive count with its sign and thousands separator, empty otherwise.
function signedCount(sign: string, value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? `${sign}${thousands(value)}` : "";
}

// GitHub's five proportion blocks of a change, green additions then red deletions then grey.
function DiffBlocks({ added, deleted, size }: { added: number | null | undefined; deleted: number | null | undefined; size: string }) {
  const { green, red } = blocks5(added, deleted);
  const tones = Array.from({ length: 5 }, (_, index) => (index < green ? "bg-green" : index < green + red ? "bg-red-strong" : "bg-line"));
  return (
    <span className="flex justify-end gap-px" aria-hidden>
      {tones.map((tone, index) => (
        <i key={index} className={`block flex-none rounded-[1px] ${size} ${tone}`} />
      ))}
    </span>
  );
}

// A repo-relative path with its directory dim and its name bright, truncated from the left.
function FilePath({ file }: { file: DiffstatFile }) {
  const cut = file.path.lastIndexOf("/") + 1;
  const title = file.from ? `${file.from} → ${file.path}` : file.path;
  return (
    <span className="overflow-hidden text-left text-ellipsis whitespace-nowrap [direction:rtl]" title={title}>
      <span dir="ltr" className="[unicode-bidi:isolate]">
        <span className="text-log">{file.path.slice(0, cut)}</span>
        <span className="font-medium text-fg">{file.path.slice(cut)}</span>
      </span>
    </span>
  );
}

// One touched file: its path opening its diff, kind, its own +/− and its five blocks.
function FileRow({ file, onOpen }: { file: DiffstatFile; onOpen: OpenFile }) {
  return (
    <li className={`${ROW_GRID} border-b border-row-line last:border-b-0`}>
      <button type="button" className="flex min-w-0 cursor-pointer border-0 bg-transparent p-0 text-left font-[inherit] hover:underline" aria-label={`diff of ${file.path}`} onClick={() => onOpen(file)}>
        <FilePath file={file} />
      </button>
      <KindIcon kind={kindOf(file)} />
      <span className="text-right whitespace-nowrap text-green">{signedCount("+", file.added)}</span>
      <span className="text-right whitespace-nowrap text-red">{signedCount("−", file.deleted)}</span>
      <DiffBlocks added={file.added} deleted={file.deleted} size="h-[7px] w-[6px]" />
    </li>
  );
}

// The header strip: title, file count and, when counted, the total diff with its blocks.
function FilesHeader({ diffstat }: { diffstat: Diffstat | undefined }) {
  const totals = diffstat?.totals ?? null;
  return (
    <div className="flex items-center gap-2.5 border-b border-line bg-inset px-3.5 py-2.5">
      <CardTitle>Files</CardTitle>
      {diffstat && <span className="text-xs text-muted">{`${filesOf(diffstat).length} changed`}</span>}
      {totals && (
        <div className="ml-auto flex items-center gap-2 font-mono text-xs font-medium">
          <span className="text-green">{`+${thousands(totals.added)}`}</span>
          <span className="text-red">{`−${thousands(totals.deleted)}`}</span>
          <span className="ml-1">
            <DiffBlocks added={totals.added} deleted={totals.deleted} size="size-[7px]" />
          </span>
        </div>
      )}
    </div>
  );
}

// The loading state of the file list, shaped like its rows.
function FilesSkeleton() {
  return (
    <ul className="m-0 list-none p-0" aria-busy="true" aria-label="loading the files">
      {SKELETON_ROWS.map((width) => (
        <li key={width} className={ROW_GRID}>
          <span className={`block h-3 animate-pulse rounded bg-row-line ${width}`} />
          <span className="block h-3 animate-pulse rounded bg-row-line" />
          <span className="block h-3 animate-pulse rounded bg-row-line" />
          <span className="block h-3 animate-pulse rounded bg-row-line" />
          <span className="block h-[7px] animate-pulse rounded bg-row-line" />
        </li>
      ))}
    </ul>
  );
}

// A padded line inside the card for its loading error or empty state.
function FilesMessage({ children }: { children: ReactNode }) {
  return (
    <div className="px-3.5 py-2.5">
      <CardEmpty>{children}</CardEmpty>
    </div>
  );
}

// The scrolling list of touched files, the empty sentence when there is none.
function FilesList({ diffstat, onOpen }: { diffstat: Diffstat; onOpen: OpenFile }) {
  const files = filesOf(diffstat);
  if (files.length === 0) return <FilesMessage>None yet.</FilesMessage>;
  return (
    <ul className="m-0 max-h-[276px] list-none overflow-y-auto p-0 font-mono text-sm">
      {files.map((file) => (
        <FileRow key={file.path} file={file} onOpen={onOpen} />
      ))}
    </ul>
  );
}

// Where the list comes from: the pull request once merged or closed, the live worktree, else the server's note.
function sourceText(job: JobDetail, diffstat: Diffstat, secondsAgo: number): string | null {
  const pr = prNumber(job.pr_url);
  if (pr !== null && (job.pr_state === "merged" || job.status === "closed")) return job.pr_state ? `PR #${pr} · ${job.pr_state}` : `PR #${pr}`;
  if (diffstat.source === "worktree") return `worktree vs ${(diffstat.base ?? "base").replace(/^origin\//, "")} · refreshed ${secondsAgo}s ago`;
  return diffstat.note;
}

// The footer: the source of the list and the link to the pull request's diff.
function FilesFooter({ job, diffstat, updatedAt }: { job: JobDetail; diffstat: Diffstat; updatedAt: number }) {
  const now = useNow(1000);
  const text = sourceText(job, diffstat, Math.max(0, Math.round((now - updatedAt) / 1000)));
  if (!text && !job.pr_url) return null;
  return (
    <div className="flex items-center gap-2.5 border-t border-line px-3.5 py-2 text-sm text-dim">
      {text && <span className="min-w-0">{text}</span>}
      {job.pr_url && (
        <a href={`${job.pr_url}/files`} target="_blank" rel="noreferrer" className="ml-auto shrink-0 text-link no-underline">
          Open PR diff ↗
        </a>
      )}
    </div>
  );
}

// The files touched card: the worktree's diff against its base with kinds and line counts, or the recorded names once it is released.
export function FilesCard({ job, running }: { job: JobDetail; running: boolean }) {
  const diffstat = useDiffstat(jobRef(job.id), running);
  const [opened, setOpened] = useState<DiffstatFile | null>(null);
  return (
    <section aria-label="files" className="flex min-w-0 flex-col overflow-hidden rounded-lg border border-line bg-surface p-0">
      <FilesHeader diffstat={diffstat.data} />
      {diffstat.isPending && <FilesSkeleton />}
      {diffstat.isError && !diffstat.data && <FilesMessage>{`The files cannot be read: ${errorText(diffstat.error)}`}</FilesMessage>}
      {diffstat.data && <FilesList diffstat={diffstat.data} onOpen={setOpened} />}
      {diffstat.data && <FilesFooter job={job} diffstat={diffstat.data} updatedAt={diffstat.dataUpdatedAt} />}
      {opened && <DiffDrawer job={job} file={opened} kind={kindOf(opened)} onClose={() => setOpened(null)} />}
    </section>
  );
}
