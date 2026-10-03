import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { errorText } from "../lib/actions";
import { callTool } from "../lib/mcp";
import { useDebounced } from "../lib/useDebounced";
import { Button, FIELD_CLASS } from "./ui";

interface IssueHit {
  ref: string;
  title: string;
  status: string | null;
}

interface IssueDetail {
  ref: string;
  title: string;
  detail: string | null;
}

interface IssuePickerProps {
  project: string;
  selected: string | null;
  onSelect: (ref: string | null) => void;
}

const SEARCH_DELAY_MS = 250;

const BOX_CLASS = "mt-2 rounded-md border border-line bg-header p-3 text-[13px] text-[#b7bdc9]";

// The hits of an `issue_search` answer, keeping only the well-formed ones.
function hitsOf(answer: { hits?: unknown } | null): IssueHit[] {
  const hits = Array.isArray(answer?.hits) ? (answer.hits as Partial<IssueHit>[]) : [];
  return hits.filter((hit): hit is IssueHit => typeof hit?.ref === "string" && typeof hit?.title === "string");
}

// The issues of the project matching the typed words, searched once the typing settles; a newer query always wins.
function useIssueSearch(project: string, query: string, enabled: boolean) {
  const settled = useDebounced(query.trim(), SEARCH_DELAY_MS);
  return useQuery({
    queryKey: ["issue-search", project, settled],
    queryFn: async () => hitsOf(await callTool<{ hits?: unknown }>("issue_search", { project, query: settled })),
    enabled: enabled && project !== "" && settled.length >= 2,
    staleTime: 30_000,
  });
}

// The chosen issue in full, its detail being the brief the job is built from.
function useIssueDetail(ref: string | null) {
  return useQuery({
    queryKey: ["issue", ref],
    queryFn: () => callTool<IssueDetail>("issue_get", { id: ref }),
    enabled: ref !== null,
  });
}

// The list of hits under the search box, with its loading, empty and failed states.
function HitList({ search, onSelect }: { search: ReturnType<typeof useIssueSearch>; onSelect: (ref: string) => void }) {
  if (search.fetchStatus === "idle" && search.isPending) return null;
  if (search.isPending) return <div className={`${BOX_CLASS} h-16 animate-pulse`} aria-label="searching issues" />;
  if (search.isError) return <p className={`${BOX_CLASS} text-red`}>The search failed: {errorText(search.error)}</p>;
  if (search.data.length === 0) return <p className={BOX_CLASS}>No issue matches these words.</p>;
  return (
    <ul className={`${BOX_CLASS} m-0 flex max-h-[180px] list-none flex-col gap-0.5 overflow-auto p-1`}>
      {search.data.map((hit) => (
        <li key={hit.ref}>
          <button type="button" className="w-full truncate rounded px-2 py-1.5 text-left text-fg hover:bg-row-line" onClick={() => onSelect(hit.ref)}>
            <span className="font-mono text-accent">{hit.ref}</span> · {hit.title}
            {hit.status && <span className="text-dim"> · {hit.status}</span>}
          </button>
        </li>
      ))}
    </ul>
  );
}

// The read-only brief of the chosen issue: its title and detail as plain text.
function IssueBrief({ refName }: { refName: string }) {
  const detail = useIssueDetail(refName);
  return (
    <div className={`${BOX_CLASS} max-h-[150px] overflow-auto`}>
      <div className="mb-1.5 text-[11px] text-muted">BRIEF — the item is the brief; read it before queueing</div>
      {detail.isPending && <div className="h-12 animate-pulse rounded bg-row-line" aria-label="loading the brief" />}
      {detail.isError && <span className="text-red">The issue cannot be read: {errorText(detail.error)}</span>}
      {detail.isSuccess && (
        <>
          <div className="font-medium text-fg">{detail.data.title}</div>
          <div className="mt-1 whitespace-pre-wrap">{detail.data.detail?.trim() || "This issue has no detail beyond its title."}</div>
        </>
      )}
    </div>
  );
}

// The issue field of the Add job drawer: a search over the project's issues, then the chosen one's brief.
export function IssuePicker({ project, selected, onSelect }: IssuePickerProps) {
  const [query, setQuery] = useState("");
  const search = useIssueSearch(project, query, selected === null);
  if (selected !== null) {
    return (
      <div>
        <div className="flex items-center gap-2">
          <span className="min-w-0 grow truncate font-mono text-accent">{selected}</span>
          <Button variant="ghost" size="sm" onClick={() => onSelect(null)}>
            Change
          </Button>
        </div>
        <IssueBrief refName={selected} />
      </div>
    );
  }
  return (
    <div>
      <input
        id="add-issue"
        type="search"
        className={`${FIELD_CLASS} min-h-9 w-full px-2.5`}
        placeholder={project ? "search the project's issues by words…" : "choose a project first"}
        disabled={!project}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      <HitList search={search} onSelect={onSelect} />
    </div>
  );
}
