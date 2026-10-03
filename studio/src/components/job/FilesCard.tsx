import { useQuery } from "@tanstack/react-query";
import { errorText } from "../../lib/actions";
import { getJson } from "../../lib/api";
import type { Diffstat, DiffstatFile } from "../../lib/types";
import { Card, CardEmpty } from "./Card";

const RUNNING_REFRESH_MS = 10_000;

const SKELETON_ROWS = ["w-4/5", "w-3/5", "w-2/3"];

// The diffstat of one job, refreshed every 10 s while it runs.
function useDiffstat(jobRef: string, running: boolean) {
  return useQuery({
    queryKey: ["diffstat", jobRef],
    queryFn: () => getJson<Diffstat>(`/api/jobs/${encodeURIComponent(jobRef)}/diffstat`),
    refetchInterval: running ? RUNNING_REFRESH_MS : false,
  });
}

// The card title: the file count, plus the line totals when the worktree was read.
function filesTitle(diffstat: Diffstat | undefined): string {
  const files = Array.isArray(diffstat?.files) ? diffstat.files : [];
  const totals = diffstat?.totals;
  return totals ? `Files · ${files.length} · +${totals.added} −${totals.deleted}` : `Files · ${files.length}`;
}

// The counts beside one path: `new` for an untracked file, `+N -M` when counted, nothing for a name-only entry.
function FileCounts({ file }: { file: DiffstatFile }) {
  if (file.untracked) return <span className="shrink-0 text-green">new</span>;
  if (file.added === null && file.deleted === null) return null;
  return (
    <span className="flex shrink-0 gap-1.5">
      <span className="text-green">{`+${file.added ?? "-"}`}</span>
      <span className="text-red">{`-${file.deleted ?? "-"}`}</span>
    </span>
  );
}

// One touched file: its repo-relative path and its line counts.
function FileRow({ file }: { file: DiffstatFile }) {
  return (
    <li className="flex items-baseline justify-between gap-3">
      <span className="min-w-0 break-all text-note">{file.path}</span>
      <FileCounts file={file} />
    </li>
  );
}

// The loading state of the file list, shaped like its rows.
function FilesSkeleton() {
  return (
    <ul className="m-0 flex list-none flex-col gap-[7px] p-0" aria-busy="true" aria-label="loading the files">
      {SKELETON_ROWS.map((width) => (
        <li key={width} className="flex items-center justify-between gap-3">
          <span className={`block h-3 animate-pulse rounded bg-row-line ${width}`} />
          <span className="block h-3 w-12 animate-pulse rounded bg-row-line" />
        </li>
      ))}
    </ul>
  );
}

// The list of touched files with the note that explains a names-only answer.
function FilesList({ diffstat }: { diffstat: Diffstat }) {
  const files = Array.isArray(diffstat.files) ? diffstat.files : [];
  return (
    <>
      {files.length === 0 ? (
        <CardEmpty>None yet.</CardEmpty>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-[3px] p-0 font-mono text-sm">
          {files.map((file) => (
            <FileRow key={file.path} file={file} />
          ))}
        </ul>
      )}
      {diffstat.source !== "worktree" && diffstat.note && <p className="m-0 text-xs text-dim">{diffstat.note}</p>}
    </>
  );
}

// The files touched card: the worktree's diff against its base, with line counts, or the recorded names once it is released.
export function FilesCard({ jobRef, running }: { jobRef: string; running: boolean }) {
  const diffstat = useDiffstat(jobRef, running);
  return (
    <Card label="files" title={filesTitle(diffstat.data)}>
      {diffstat.isPending && <FilesSkeleton />}
      {diffstat.isError && !diffstat.data && <CardEmpty>{`The files cannot be read: ${errorText(diffstat.error)}`}</CardEmpty>}
      {diffstat.data && <FilesList diffstat={diffstat.data} />}
    </Card>
  );
}
