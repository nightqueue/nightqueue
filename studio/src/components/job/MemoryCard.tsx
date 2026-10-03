import { useQuery } from "@tanstack/react-query";
import { errorText } from "../../lib/actions";
import { getJson } from "../../lib/api";
import type { Recall, RecallGroup } from "../../lib/types";
import { Card, CardEmpty } from "./Card";

const RUNNING_REFRESH_MS = 10_000;

const SKELETON_ROWS = ["w-3/4", "w-1/2", "w-2/3"];

const TOOL_LABELS: Record<Recall["tool"], string> = {
  lesson_recall: "lessons",
  memory_recall: "memory",
  decision_recall: "decisions",
  index_recall: "index",
};

// The recalls of one job's whole log, refreshed every 10 s while it runs.
function useRecalls(jobRef: string, running: boolean) {
  return useQuery({
    queryKey: ["recalls", jobRef],
    queryFn: () => getJson<{ groups: RecallGroup[] }>(`/api/jobs/${encodeURIComponent(jobRef)}/recalls`),
    refetchInterval: running ? RUNNING_REFRESH_MS : false,
  });
}

// The heading of a group: the phase number when the agent has one, then the agent.
function groupLabel(group: RecallGroup): string {
  return group.phase === null ? group.agent : `phase ${group.phase} · ${group.agent}`;
}

// What one recall brought back: its refs and titles, or why there is nothing to show.
function RecallResults({ recall }: { recall: Recall }) {
  if (recall.pending) return <p className="m-0 text-xs text-dim">waiting for the answer…</p>;
  if (recall.error) return <p className="m-0 text-xs text-red">{recall.error}</p>;
  if (recall.results.length === 0) return <p className="m-0 text-xs text-dim">none</p>;
  return (
    <ul className="m-0 flex list-none flex-col gap-[2px] p-0 text-xs">
      {recall.results.map((result, index) => (
        <li key={`${result.ref ?? "?"}-${index}`} className="flex gap-2">
          <span className="shrink-0 font-mono text-muted">{result.ref ?? "?"}</span>
          <span className="min-w-0 text-note">{result.title ?? ""}</span>
        </li>
      ))}
    </ul>
  );
}

// One recall: the tool label, the query in mono, then what came back.
function RecallItem({ recall }: { recall: Recall }) {
  return (
    <li className="flex flex-col gap-1">
      <div className="flex items-baseline gap-2 text-[13px]">
        <span className="shrink-0 text-muted">{TOOL_LABELS[recall.tool] ?? recall.tool}</span>
        <span className="min-w-0 break-words font-mono text-note">{recall.query ?? "(no query)"}</span>
      </div>
      <RecallResults recall={recall} />
    </li>
  );
}

// The recalls one agent made in one phase, under its heading.
function RecallGroupBlock({ group }: { group: RecallGroup }) {
  const recalls = Array.isArray(group.recalls) ? group.recalls : [];
  return (
    <div className="flex flex-col gap-1.5">
      <h4 className="m-0 text-xs font-medium text-dim uppercase">{groupLabel(group)}</h4>
      <ul className="m-0 flex list-none flex-col gap-2 p-0">
        {recalls.map((recall, index) => (
          <RecallItem key={recall.id ?? index} recall={recall} />
        ))}
      </ul>
    </div>
  );
}

// The loading state of the card, shaped like a group heading and its recalls.
function MemorySkeleton() {
  return (
    <div className="flex flex-col gap-1.5" aria-busy="true" aria-label="loading the recalls">
      <span className="block h-3 w-24 animate-pulse rounded bg-row-line" />
      {SKELETON_ROWS.map((width) => (
        <span key={width} className={`block h-3 animate-pulse rounded bg-row-line ${width}`} />
      ))}
    </div>
  );
}

// The groups of recalls, or the empty state when the run recalled nothing.
function RecallGroups({ groups }: { groups: RecallGroup[] }) {
  if (groups.length === 0) return <CardEmpty>No lessons recalled.</CardEmpty>;
  return (
    <div className="flex flex-col gap-3">
      {groups.map((group) => (
        <RecallGroupBlock key={`${group.phase ?? "-"}:${group.agent}`} group={group} />
      ))}
    </div>
  );
}

// The memory card: every lesson, memory, decision and index recall of the run, grouped by phase and agent.
export function MemoryCard({ jobRef, running }: { jobRef: string; running: boolean }) {
  const recalls = useRecalls(jobRef, running);
  const groups = Array.isArray(recalls.data?.groups) ? recalls.data.groups : null;
  return (
    <Card label="memory" title="Memory">
      {recalls.isPending && <MemorySkeleton />}
      {recalls.isError && !recalls.data && <CardEmpty>{`The recalls cannot be read: ${errorText(recalls.error)}`}</CardEmpty>}
      {groups && <RecallGroups groups={groups} />}
    </Card>
  );
}
