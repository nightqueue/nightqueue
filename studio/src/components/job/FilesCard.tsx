import { useQuery } from "@tanstack/react-query";
import { type ReactNode, useCallback, useState } from "react";
import { errorText } from "../../lib/actions";
import { getJson } from "../../lib/api";
import { countsCell, fileKind, filesTitle, pathParts } from "../../lib/files";
import { prNumber, thousands } from "../../lib/format";
import { jobRef } from "../../lib/queue";
import type { Diffstat, DiffstatFile, JobDetail } from "../../lib/types";
import { useNow } from "../../lib/useNow";
import { CardEmpty, CardTitle } from "./Card";
import { KindIcon } from "./DiffKindIcon";
import { FileDrawer } from "./FileDrawer";

const RUNNING_REFRESH_MS = 10_000;

const SKELETON_ROWS = ["w-4/5", "w-3/5", "w-2/3"];

type OpenFile = (file: DiffstatFile) => void;

const ROW_GRID = "grid grid-cols-[minmax(0,1fr)_14px_auto] items-center gap-x-2.5 px-3.5 py-[5px]";

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

// A repo-relative path with its directory dim and its name bright, truncated from the left.
function FilePath({ file }: { file: DiffstatFile }) {
  const { dir, name } = pathParts(file.path);
  const title = file.from ? `${file.from} → ${file.path}` : file.path;
  return (
    <span className="overflow-hidden text-left text-ellipsis whitespace-nowrap [direction:rtl]" title={title}>
      <span dir="ltr" className="[unicode-bidi:isolate]">
        <span className="text-log">{dir}</span>
        <span className="font-medium text-fg">{name}</span>
      </span>
    </span>
  );
}

// The green additions and red deletions of a file, each side absent when not counted.
function CountsCell({ added, deleted }: { added: number | null | undefined; deleted: number | null | undefined }) {
  const { adds, dels } = countsCell({ added, deleted });
  return (
    <span className="flex justify-end gap-1.5 text-right font-mono text-[12px] font-medium whitespace-nowrap">
      {adds && <span className="text-green">{adds}</span>}
      {dels && <span className="text-red">{dels}</span>}
    </span>
  );
}

// One touched file as a button opening its diff: path, kind icon and its own +/−.
function FileRow({ file, open, onOpen }: { file: DiffstatFile; open: boolean; onOpen: OpenFile }) {
  const state = open ? "bg-row-line shadow-[inset_3px_0_0_var(--color-link)]" : "bg-transparent hover:bg-button";
  return (
    <li className="border-b border-row-line last:border-b-0">
      <button type="button" className={`${ROW_GRID} w-full cursor-pointer border-0 text-left font-[inherit] ${state}`} aria-label={`diff of ${file.path}`} aria-current={open ? "true" : undefined} onClick={() => onOpen(file)}>
        <FilePath file={file} />
        <KindIcon kind={fileKind(file)} />
        <CountsCell added={file.added} deleted={file.deleted} />
      </button>
    </li>
  );
}

// The header strip: the title with the file count and, when counted, the total +/−.
function FilesHeader({ diffstat }: { diffstat: Diffstat | undefined }) {
  const totals = diffstat?.totals ?? null;
  return (
    <div className="flex items-center gap-2.5 border-b border-line bg-inset px-3.5 py-2.5">
      <CardTitle>{diffstat ? filesTitle(filesOf(diffstat).length) : "Files"}</CardTitle>
      {totals && (
        <div className="ml-auto flex items-center gap-2 font-mono text-xs font-medium">
          <span className="text-green">{`+${thousands(totals.added)}`}</span>
          <span className="text-red">{`−${thousands(totals.deleted)}`}</span>
        </div>
      )}
    </div>
  );
}

// The loading state of the file list, shaped like its three-column rows.
function FilesSkeleton() {
  return (
    <ul className="m-0 list-none p-0" aria-busy="true" aria-label="loading the files">
      {SKELETON_ROWS.map((width) => (
        <li key={width} className={ROW_GRID}>
          <span className={`block h-3 animate-pulse rounded bg-row-line ${width}`} />
          <span className="block size-3 animate-pulse rounded bg-row-line" />
          <span className="block h-3 w-14 animate-pulse rounded bg-row-line" />
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

// The scrolling list of touched files, the open one marked; the empty sentence when there is none.
function FilesList({ files, openPath, onOpen }: { files: DiffstatFile[]; openPath: string | null; onOpen: OpenFile }) {
  if (files.length === 0) return <FilesMessage>None yet.</FilesMessage>;
  return (
    <ul className="m-0 max-h-[276px] list-none overflow-y-auto p-0 font-mono text-sm">
      {files.map((file) => (
        <FileRow key={file.path} file={file} open={file.path === openPath} onOpen={onOpen} />
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

// The files the drawer steps through and the open one's place: the live list, or the last known file alone once it left the list.
function drawerFiles(files: DiffstatFile[], opened: DiffstatFile): { files: DiffstatFile[]; index: number } {
  const index = files.findIndex((file) => file.path === opened.path);
  return index >= 0 ? { files, index } : { files: [opened], index: 0 };
}

// The files touched card: the worktree's diff against its base with kinds and line counts, or the recorded names once it is released.
export function FilesCard({ job, running }: { job: JobDetail; running: boolean }) {
  const diffstat = useDiffstat(jobRef(job.id), running);
  const [opened, setOpened] = useState<DiffstatFile | null>(null);
  const files = filesOf(diffstat.data);
  const drawer = opened ? drawerFiles(files, opened) : null;
  const drawerList = drawer?.files;
  const onMove = useCallback((index: number) => setOpened(drawerList?.[index] ?? null), [drawerList]);
  const onClose = useCallback(() => setOpened(null), []);
  return (
    <section aria-label="files" className="flex min-w-0 flex-col overflow-hidden rounded-lg border border-line bg-surface p-0">
      <FilesHeader diffstat={diffstat.data} />
      {diffstat.isPending && <FilesSkeleton />}
      {diffstat.isError && !diffstat.data && <FilesMessage>{`The files cannot be read: ${errorText(diffstat.error)}`}</FilesMessage>}
      {diffstat.data && <FilesList files={files} openPath={opened?.path ?? null} onOpen={setOpened} />}
      {diffstat.data && <FilesFooter job={job} diffstat={diffstat.data} updatedAt={diffstat.dataUpdatedAt} />}
      {drawer && <FileDrawer job={job} files={drawer.files} index={drawer.index} onMove={onMove} onClose={onClose} />}
    </section>
  );
}
