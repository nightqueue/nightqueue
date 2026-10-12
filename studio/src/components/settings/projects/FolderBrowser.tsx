import { ArrowUp, Folder, FolderGit2 } from "lucide-react";
import { errorText } from "../../../lib/actions";
import { breadcrumb, entryBadge, type EntryBadge } from "../../../lib/projects";
import type { DirEntry } from "../../../lib/types";
import { useDirs } from "../../../lib/useProjectsSettings";
import { Bar, Note } from "../bits";

interface FolderBrowserProps {
  dir: string;
  selected: string;
  onEnter: (path: string) => void;
  onSelect: (path: string) => void;
}

const BADGE_TONES: Record<EntryBadge["kind"], string> = {
  git: "bg-[#163a26] text-accent",
  registered: "bg-row-line text-muted",
  worktree: "bg-[#1b2440] text-[#a9bdf0]",
  plain: "bg-transparent text-dim",
};

// The skeleton of a folder listing: a few rows shaped like folders.
function ListingSkeleton() {
  return (
    <div className="flex flex-col" aria-busy="true" aria-label="reading folders">
      {Array.from({ length: 5 }, (_, index) => (
        <div key={index} className="flex items-center gap-2.5 border-t border-[#1b2030] px-3 py-2.5 first:border-t-0">
          <Bar className="size-4" />
          <Bar className={`h-3.5 ${index % 2 ? "w-[120px]" : "w-[180px]"}`} />
          <Bar className="ml-auto h-4 w-[70px] rounded-full" />
        </div>
      ))}
    </div>
  );
}

// One folder of the listing: a repository is selected, a plain folder is entered, a registered one is locked.
function EntryRow({ entry, selected, onEnter, onSelect }: { entry: DirEntry; selected: boolean; onEnter: () => void; onSelect: () => void }) {
  const badge = entryBadge(entry);
  const locked = !badge.selectable && !badge.enterable;
  const Icon = entry.git ? FolderGit2 : Folder;
  return (
    <button
      type="button"
      aria-pressed={badge.selectable ? selected : undefined}
      disabled={locked}
      onClick={badge.selectable ? onSelect : onEnter}
      className={`flex w-full items-center gap-2.5 border-t border-[#1b2030] px-3 py-2 text-left first:border-t-0 hover:bg-row-line disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-transparent max-sm:min-h-11 ${selected ? "bg-[#14251b]" : ""}`}
    >
      <Icon size={16} aria-hidden="true" className={entry.git ? "text-accent" : "text-dim"} />
      <span className="min-w-0 truncate font-mono text-[13px]">{entry.name}</span>
      <span className={`ml-auto shrink-0 rounded-full px-2 text-xs leading-5 ${BADGE_TONES[badge.kind]}`}>{badge.label}</span>
    </button>
  );
}

// The Up button and the breadcrumb of the current folder.
function FolderNav({ path, home, parent, onEnter }: { path: string; home: string; parent: string | null; onEnter: (path: string) => void }) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <button type="button" aria-label="up one folder" disabled={!parent} onClick={() => parent && onEnter(parent)} className="inline-flex min-h-[30px] min-w-[30px] items-center justify-center rounded-md border border-button-line bg-button text-fg disabled:opacity-40 max-sm:min-h-11 max-sm:min-w-11">
        <ArrowUp size={14} aria-hidden="true" />
      </button>
      <nav aria-label="folder path" className="flex min-w-0 items-center gap-1 overflow-x-auto font-mono text-[13px] whitespace-nowrap">
        {breadcrumb(path, home).map((crumb, index, all) => (
          <span key={crumb.path} className="flex items-center gap-1">
            {index > 0 && <span className="text-dim">/</span>}
            <button type="button" className={`hover:underline ${index === all.length - 1 ? "text-fg" : "text-link"}`} onClick={() => onEnter(crumb.path)}>
              {crumb.label}
            </button>
          </span>
        ))}
      </nav>
    </div>
  );
}

// The Browse tab: the folders of one directory of the home, with Up, a breadcrumb and a badge per folder.
export function FolderBrowser({ dir, selected, onEnter, onSelect }: FolderBrowserProps) {
  const listing = useDirs(dir, true);
  if (listing.isError) {
    return (
      <Note tone="err" icon="⚠" role="alert">
        <div>{errorText(listing.error)}</div>
        <button type="button" className="self-start text-link hover:underline" onClick={() => onEnter("")}>
          Back to the home folder
        </button>
      </Note>
    );
  }
  const data = listing.data;
  return (
    <div className="flex flex-col gap-2.5">
      {data ? <FolderNav path={data.path} home={data.home} parent={data.parent} onEnter={onEnter} /> : <Bar className="h-[30px] w-[260px]" />}
      <div className="max-h-[320px] overflow-y-auto rounded-lg border border-line max-sm:max-h-none">
        {!data && <ListingSkeleton />}
        {data && data.entries.length === 0 && <div className="px-3 py-3 text-sm text-dim">No folders here.</div>}
        {data?.entries.map((entry) => (
          <EntryRow key={entry.path} entry={entry} selected={entry.path === selected} onEnter={() => onEnter(entry.path)} onSelect={() => onSelect(entry.path)} />
        ))}
      </div>
      {data?.truncated && <span className="text-xs text-dim">Showing the first 1000 folders; paste a path to reach the others.</span>}
    </div>
  );
}
