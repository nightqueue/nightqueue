import { useQuery } from "@tanstack/react-query";
import { errorText } from "../../lib/actions";
import { callTool } from "../../lib/mcp";
import type { RecallKind } from "../../lib/types";
import { useEscape } from "../../lib/useEscape";
import { Button } from "../ui";
import { Markdown } from "./Markdown";

export interface MemoryEntry {
  ref: string;
  kind: RecallKind;
  title: string | null;
  text: string | null;
}

interface DecisionText {
  title?: string;
  status?: string;
  decision?: string;
  context?: string;
  consequences?: string;
}

const DECISION_SECTIONS: readonly (readonly [keyof DecisionText, string])[] = [
  ["decision", "Decision"],
  ["context", "Context"],
  ["consequences", "Consequences"],
];

const SKELETON_ROWS = ["w-2/3", "w-full", "w-5/6", "w-3/4"];

// The arguments that read one decision: an org-qualified ref alone, a bare `D-<n>` inside the job's project.
function decisionArgs(ref: string, project: string): Record<string, unknown> {
  return ref.includes("/") ? { id: ref } : { id: ref, project };
}

// One decision read whole through `decision_recall`, only while the drawer shows a decision.
function useDecision(entry: MemoryEntry, project: string) {
  return useQuery({
    queryKey: ["decision", project, entry.ref],
    queryFn: () => callTool<DecisionText>("decision_recall", decisionArgs(entry.ref, project)),
    enabled: entry.kind === "decision",
    staleTime: 60_000,
  });
}

// The markdown of a decision: its labelled sections, each only when present.
function decisionMarkdown(decision: DecisionText): string {
  return DECISION_SECTIONS.filter(([field]) => typeof decision[field] === "string" && decision[field])
    .map(([field, label]) => `**${label}**\n\n${decision[field]}`)
    .join("\n\n");
}

// The loading state of the drawer body, shaped like a title and its paragraphs.
function DrawerSkeleton() {
  return (
    <div className="flex flex-col gap-2" aria-busy="true" aria-label="loading the decision">
      {SKELETON_ROWS.map((width) => (
        <span key={width} className={`block h-3 animate-pulse rounded bg-row-line ${width}`} />
      ))}
    </div>
  );
}

// The body of a decision: loading, its read error, or its title, status and sections.
function DecisionBody({ entry, project }: { entry: MemoryEntry; project: string }) {
  const decision = useDecision(entry, project);
  if (decision.isPending) return <DrawerSkeleton />;
  if (decision.isError) return <p className="m-0 text-sm text-red">{`The decision cannot be read: ${errorText(decision.error)}`}</p>;
  const data = decision.data ?? {};
  return (
    <div className="flex flex-col gap-2">
      <div className="text-[15px] font-medium text-fg">{data.title ?? entry.title ?? entry.ref}</div>
      {data.status && <div className="text-xs text-dim">{data.status}</div>}
      <Markdown source={decisionMarkdown(data) || "No text."} />
    </div>
  );
}

// The body of a lesson or memory hit: the title and the text the recall returned.
function RecalledBody({ entry }: { entry: MemoryEntry }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="text-[15px] font-medium text-fg">{entry.title ?? entry.ref}</div>
      <Markdown source={entry.text ?? "The recall returned no text for this entry."} />
    </div>
  );
}

// A read-only right drawer with the whole text of one recalled decision, lesson or memory; Esc or the backdrop closes it.
export function MemoryDrawer({ entry, project, onClose }: { entry: MemoryEntry; project: string; onClose: () => void }) {
  useEscape(onClose);
  return (
    <div className="fixed inset-0 z-40">
      <div className="absolute inset-0 bg-[rgba(5,7,10,.55)]" onMouseDown={onClose} aria-hidden="true" />
      <aside aria-label={`${entry.kind} ${entry.ref}`} className="absolute top-0 right-0 bottom-0 flex w-full flex-col border-l border-line bg-surface text-[14px] leading-[1.45] text-fg shadow-[-20px_0_60px_rgba(0,0,0,.5)] sm:w-[480px]">
        <div className="flex items-center gap-3 border-b border-line px-5 py-4">
          <div className="font-mono text-base font-semibold">{entry.ref}</div>
          <span className="text-xs text-dim">{entry.kind}</span>
        </div>
        <div className="grow overflow-auto p-5">{entry.kind === "decision" ? <DecisionBody entry={entry} project={project} /> : <RecalledBody entry={entry} />}</div>
        <div className="flex border-t border-line px-5 py-4">
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
        </div>
      </aside>
    </div>
  );
}
