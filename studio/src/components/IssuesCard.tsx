import { useQuery } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { errorText } from "../lib/actions";
import { fetchTrackerIssues } from "../lib/mcp";
import {
  connectCommand,
  DEFAULT_TRACKER_PREFS,
  type FilterOption,
  groupIssues,
  type IssueDraft,
  isOption,
  issueDraft,
  parseTrackerPrefs,
  projectOptions,
  serializeTrackerPrefs,
  teamOptions,
  type TrackerPrefs,
  type TrackerView,
  trackerLabel,
} from "../lib/tracker";
import type { TrackerAnswer, TrackerFilters, TrackerItem } from "../lib/types";
import { ConnectTrackerModal } from "./ConnectTrackerModal";
import { Button, FIELD_CLASS, Kbd, Segmented } from "./ui";

interface IssuesCardProps {
  onQueue: (draft: IssueDraft) => void;
  reloadKey: number;
}

const PREFS_KEY = "nightqueue.studio.tracker";

const ISSUE_LIMIT = 50;

const SKELETON_ROWS = 4;

const STUDIO_CONNECTABLE = "linear";

const VIEW_OPTIONS: { value: TrackerView; label: string }[] = [
  { value: "open", label: "Open" },
  { value: "all", label: "All" },
];

const STATE_CLASSES: Record<string, string> = {
  started: "border-run-line text-accent",
  completed: "border-line text-green",
  canceled: "border-line text-dim",
};

// The card preferences saved by an earlier visit; unreadable storage gives the defaults.
function readPrefs(): TrackerPrefs {
  try {
    return parseTrackerPrefs(window.localStorage.getItem(PREFS_KEY));
  } catch {
    return DEFAULT_TRACKER_PREFS;
  }
}

// Saves the card preferences; a storage failure only loses them.
function writePrefs(prefs: TrackerPrefs) {
  try {
    window.localStorage.setItem(PREFS_KEY, serializeTrackerPrefs(prefs));
  } catch {
    return;
  }
}

// The team, project and open/all choices of the card, saved on every change.
function useTrackerPrefs(): [TrackerPrefs, (next: TrackerPrefs) => void] {
  const [prefs, setPrefs] = useState<TrackerPrefs>(readPrefs);
  const change = (next: TrackerPrefs) => {
    setPrefs(next);
    writePrefs(next);
  };
  return [prefs, change];
}

// The issue list read on mount, on a filter change, on Refresh and after a queue; the filters only on the first load and on Refresh.
function useTrackerIssues({ team, project, reloadKey }: { team: string; project: string; reloadKey: number }) {
  const [refreshTick, setRefreshTick] = useState(0);
  const [filters, setFilters] = useState<TrackerFilters | null>(null);
  const needFilters = useRef(true);
  const query = useQuery({
    queryKey: ["tracker", team, project, refreshTick, reloadKey],
    queryFn: async (): Promise<TrackerAnswer> => {
      const answer = await fetchTrackerIssues({ state: "all", limit: ISSUE_LIMIT, include_filters: needFilters.current, ...(team ? { team } : {}), ...(project ? { project } : {}) });
      if (answer.ok && answer.filters) {
        needFilters.current = false;
        setFilters(answer.filters);
      }
      return answer;
    },
    refetchInterval: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    staleTime: Infinity,
    retry: false,
  });
  const refresh = () => {
    needFilters.current = true;
    setRefreshTick((tick) => tick + 1);
  };
  return { query, filters, refresh };
}

// One filter select of the card header.
function FilterSelect({ label, options, value, onChange }: { label: string; options: FilterOption[]; value: string; onChange: (value: string) => void }) {
  return (
    <select aria-label={label} className={`${FIELD_CLASS} min-h-9 w-full min-w-0 sm:w-48`} value={value} onChange={(event) => onChange(event.target.value)}>
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

// The card header: title, team and project filters, the open/all toggle and Refresh.
function IssuesHeader({ title, filters, prefs, onPrefs, onRefresh }: { title: string; filters: TrackerFilters | null; prefs: TrackerPrefs; onPrefs: (next: TrackerPrefs) => void; onRefresh: () => void }) {
  const teams = teamOptions(filters);
  const projects = projectOptions(filters, prefs.team);
  const changeTeam = (team: string) => onPrefs({ ...prefs, team, project: isOption(projectOptions(filters, team), prefs.project) ? prefs.project : "" });
  return (
    <div className="flex flex-col gap-2 border-b border-line px-3 py-2.5 sm:flex-row sm:flex-wrap sm:items-center">
      <h2 className="m-0 text-base font-semibold">{title}</h2>
      <div className="flex flex-col gap-2 sm:ml-auto sm:flex-row sm:flex-wrap sm:items-center">
        <FilterSelect label="team" options={teams} value={prefs.team} onChange={changeTeam} />
        <FilterSelect label="project" options={projects} value={prefs.project} onChange={(project) => onPrefs({ ...prefs, project })} />
        <div className="flex gap-2">
          <Segmented<TrackerView> label="issues shown" options={VIEW_OPTIONS} value={prefs.view} onChange={(view) => onPrefs({ ...prefs, view })} />
          <Button onClick={onRefresh}>Refresh</Button>
        </div>
      </div>
    </div>
  );
}

// The state of an issue as a badge coloured by its state type.
function StateBadge({ item }: { item: TrackerItem }) {
  const tone = STATE_CLASSES[item.state?.type ?? ""] ?? "border-line text-muted";
  return <span className={`rounded-full border px-2 py-0.5 text-xs whitespace-nowrap ${tone}`}>{item.state?.name ?? "unknown"}</span>;
}

// One issue: ref link, title, state, priority, labels and the Queue button; stacked on narrow screens.
function IssueRow({ item, onQueue }: { item: TrackerItem; onQueue: (item: TrackerItem) => void }) {
  return (
    <li className="flex min-w-0 flex-col gap-1.5 border-b border-row-line px-3 py-2.5 sm:flex-row sm:items-center sm:gap-3">
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 sm:contents">
        {item.url ? (
          <a href={item.url} target="_blank" rel="noreferrer" className="font-mono text-sm whitespace-nowrap">
            {item.ref}
          </a>
        ) : (
          <span className="font-mono text-sm whitespace-nowrap">{item.ref}</span>
        )}
        <StateBadge item={item} />
      </div>
      <span className="min-w-0 break-words sm:flex-1 sm:truncate">{item.title}</span>
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted">
        {item.priorityLabel && <span className="whitespace-nowrap">{item.priorityLabel}</span>}
        {item.labels.map((label) => (
          <span key={label} className="rounded border border-button-line px-1.5 text-xs">
            {label}
          </span>
        ))}
        <Button size="sm" className="ml-auto" onClick={() => onQueue(item)}>
          Queue
        </Button>
      </div>
    </li>
  );
}

// A list of issue rows.
function IssueList({ items, onQueue }: { items: TrackerItem[]; onQueue: (item: TrackerItem) => void }) {
  return (
    <ul className="m-0 list-none p-0">
      {items.map((item) => (
        <IssueRow key={item.ref} item={item} onQueue={onQueue} />
      ))}
    </ul>
  );
}

// The open issues first, then the done and canceled ones folded away when the toggle shows all.
function IssueGroups({ answer, view, onQueue }: { answer: Extract<TrackerAnswer, { ok: true }>; view: TrackerView; onQueue: (draft: IssueDraft) => void }) {
  const { open, closed } = groupIssues(answer.items);
  const queue = (item: TrackerItem) => onQueue(issueDraft(item, answer.provider));
  return (
    <>
      {open.length === 0 ? <p className="m-0 px-3 py-4 text-center text-muted">no open issues</p> : <IssueList items={open} onQueue={queue} />}
      {view === "all" && closed.length > 0 && (
        <details>
          <summary className="cursor-pointer px-3 py-2 text-sm text-muted">Done/canceled ({closed.length})</summary>
          <IssueList items={closed} onQueue={queue} />
        </details>
      )}
      {answer.truncated && <p className="m-0 px-3 py-2 text-sm text-dim">Showing the {ISSUE_LIMIT} most recently updated issues; narrow by team or project.</p>}
    </>
  );
}

// The button that opens the connect dialog of a tracker the studio can connect.
function ConnectTrackerButton({ provider, onConnected }: { provider: string; onConnected: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button className="self-start" onClick={() => setOpen(true)}>
        Conectar {trackerLabel(provider)}
      </Button>
      {open && <ConnectTrackerModal provider={provider} onClose={() => setOpen(false)} onConnected={onConnected} />}
    </>
  );
}

// What the card shows when the tracker refused: how to connect it, or why it is unavailable.
function TrackerRefusal({ answer, onConnected }: { answer: Extract<TrackerAnswer, { ok: false }>; onConnected: () => void }) {
  if (answer.error === "no-connection" && answer.provider) {
    return (
      <div className="flex flex-col gap-2 px-3 py-4 text-sm text-muted">
        <span className="font-semibold text-fg">Connect {trackerLabel(answer.provider)}</span>
        <span className="break-all">
          <Kbd>{connectCommand(answer.provider)}</Kbd>
        </span>
        {answer.provider === STUDIO_CONNECTABLE && <ConnectTrackerButton provider={answer.provider} onConnected={onConnected} />}
      </div>
    );
  }
  return <p className="m-0 px-3 py-4 text-sm text-amber">{trackerLabel(answer.provider)} is unavailable: {answer.hint}</p>;
}

// The loading state of the card: issue rows shaped like the real ones.
function IssuesSkeleton() {
  return (
    <div aria-busy="true" aria-label="loading issues">
      {Array.from({ length: SKELETON_ROWS }, (_, index) => (
        <div key={index} className="flex flex-col gap-1.5 border-b border-row-line px-3 py-3 sm:flex-row sm:items-center sm:gap-3">
          <span className="block h-3 w-14 animate-pulse rounded bg-row-line" />
          <span className="block h-4 w-16 animate-pulse rounded-full bg-row-line" />
          <span className="block h-3 w-3/5 animate-pulse rounded bg-row-line sm:flex-1" />
          <span className="block h-7 w-16 animate-pulse rounded-md bg-row-line sm:ml-auto" />
        </div>
      ))}
    </div>
  );
}

// The card body for the current read: skeleton, failure, refusal or the issue groups.
function IssuesBody({ query, view, onQueue, onConnected }: { query: ReturnType<typeof useTrackerIssues>["query"]; view: TrackerView; onQueue: (draft: IssueDraft) => void; onConnected: () => void }) {
  if (query.isPending) return <IssuesSkeleton />;
  if (query.isError) return <p className="m-0 px-3 py-4 text-sm text-red">The issues cannot be read: {errorText(query.error)}</p>;
  if (!query.data.ok) return <TrackerRefusal answer={query.data} onConnected={onConnected} />;
  return <IssueGroups answer={query.data} view={view} onQueue={onQueue} />;
}

// The Issues card: the home tracker's issues filtered by team and project, each one queued as a job through the Add job drawer.
export function IssuesCard({ onQueue, reloadKey }: IssuesCardProps) {
  const [prefs, setPrefs] = useTrackerPrefs();
  const { query, filters, refresh } = useTrackerIssues({ team: prefs.team, project: prefs.project, reloadKey });
  const provider = query.data?.provider ?? null;
  return (
    <section aria-label="issues" className="overflow-hidden rounded-lg border border-line bg-surface">
      <IssuesHeader title={provider ? `${trackerLabel(provider)} issues` : "Issues"} filters={filters} prefs={prefs} onPrefs={setPrefs} onRefresh={refresh} />
      <IssuesBody query={query} view={prefs.view} onQueue={onQueue} onConnected={refresh} />
    </section>
  );
}
