import { useQuery } from "@tanstack/react-query";
import { Search } from "lucide-react";
import { type ReactNode, useState } from "react";
import { errorText } from "../../lib/actions";
import { getJson } from "../../lib/api";
import { elapsedClock } from "../../lib/format";
import { jobRef } from "../../lib/queue";
import type { JobDetail, Recall, RecallHit, RecallKind, RecallsAnswer } from "../../lib/types";
import { ICON_STROKE } from "../StatusIcon";
import { CardEmpty, CardTitle } from "./Card";
import { type MemoryEntry, MemoryDrawer } from "./MemoryDrawer";

const RUNNING_REFRESH_MS = 10_000;

const SKELETON_BLOCKS = ["w-3/4", "w-2/3", "w-1/2"];

const FALLBACK_VIA = "fallback";

const KIND_TEXT: Record<RecallKind, string> = {
  decision: "text-mem-decision",
  lesson: "text-mem-lesson",
  index: "text-mem-index",
  memory: "text-note",
};

const KIND_BAR: Record<RecallKind, string> = {
  decision: "bg-mem-decision",
  lesson: "bg-mem-lesson",
  index: "bg-mem-index",
  memory: "bg-note",
};

type OpenEntry = (entry: MemoryEntry) => void;

// The recalls of one job's whole log with the refs they applied, refreshed every 10 s while it runs.
function useRecalls(ref: string, running: boolean) {
  return useQuery({
    queryKey: ["recalls", ref],
    queryFn: () => getJson<RecallsAnswer>(`/api/jobs/${encodeURIComponent(ref)}/recalls`),
    refetchInterval: running ? RUNNING_REFRESH_MS : false,
  });
}

// The recalls of an answer, an empty list when the payload carries none.
function recallsOf(answer: RecallsAnswer | undefined): Recall[] {
  return Array.isArray(answer?.recalls) ? answer.recalls : [];
}

// The hits of a recall, an empty list when the payload carries none.
function hitsOf(recall: Recall): RecallHit[] {
  return Array.isArray(recall.hits) ? recall.hits : [];
}

// Whether a hit is recent context the recall fell back to rather than a match of the query.
function isFallback(hit: RecallHit): boolean {
  return hit.via === FALLBACK_VIA;
}

// The colour family of a recall's kind, the memory one for a kind this page does not know.
function kindOf(recall: Recall): RecallKind {
  return recall.kind in KIND_TEXT ? recall.kind : "memory";
}

// A 0..1 similarity as `.81`, or null when it is not a finite number.
function scoreLabel(score: number | null | undefined): string | null {
  if (typeof score !== "number" || !Number.isFinite(score)) return null;
  return score.toFixed(2).replace(/^0(?=\.)/, "");
}

// The last path segment of an indexed file, the whole ref otherwise.
function shortRef(ref: string, kind: RecallKind): string {
  return kind === "index" ? ref.slice(ref.lastIndexOf("/") + 1) || ref : ref;
}

// The hex SHA-256 of a text, the anchor GitHub gives a file in a pull request diff.
async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

// The link to a file in the pull request diff, the diff's file list when the anchor cannot be computed.
function usePrFileUrl(prUrl: string, path: string) {
  return useQuery({
    queryKey: ["pr-file-anchor", prUrl, path],
    queryFn: async () => {
      try {
        return `${prUrl}/files#diff-${await sha256Hex(path)}`;
      } catch {
        return `${prUrl}/files`;
      }
    },
    staleTime: Number.POSITIVE_INFINITY,
  });
}

// The header strip: title and the recall, hit and applied counts.
function MemoryHeader({ answer }: { answer: RecallsAnswer | undefined }) {
  const recalls = recallsOf(answer);
  const hits = recalls.reduce((sum, recall) => sum + hitsOf(recall).filter((hit) => !isFallback(hit)).length, 0);
  const applied = typeof answer?.applied_total === "number" ? answer.applied_total : 0;
  return (
    <div className="flex items-center gap-2 border-b border-line bg-inset px-3.5 py-2.5">
      <CardTitle>Memory</CardTitle>
      {answer && (
        <div className="ml-auto flex gap-2.5 font-mono text-[11px] text-muted">
          <span>
            <b className="font-medium text-fg">{recalls.length}</b> recalls
          </span>
          <span>
            <b className="font-medium text-fg">{hits}</b> hits
          </span>
          <span className="text-accent">
            <b className="font-medium">{applied}</b> applied
          </span>
        </div>
      )}
    </div>
  );
}

// The query line of a recall: the search icon, the quoted query, then who asked and when.
function QueryLine({ recall }: { recall: Recall }) {
  const attempt = recall.attempt > 1 ? `#${recall.attempt} ` : "";
  const when = elapsedClock(typeof recall.at_s === "number" ? recall.at_s * 1000 : null);
  return (
    <div className="flex items-center gap-[7px] font-mono text-xs text-fg">
      <Search size={12} strokeWidth={ICON_STROKE} aria-hidden="true" className="shrink-0 text-accent" />
      <span className="min-w-0 break-words">
        <span className="text-accent">"</span>
        {recall.query ?? "(no query)"}
        <span className="text-accent">"</span>
      </span>
      <span className="ml-auto font-sans text-[10px] whitespace-nowrap text-dim">{`${recall.agent} · ${attempt}${when}`}</span>
    </div>
  );
}

// The ref of an index hit: a link to the file in the pull request diff, plain text without a pull request.
function IndexRef({ path, prUrl, className }: { path: string; prUrl: string; className: string }) {
  const url = usePrFileUrl(prUrl, path);
  return (
    <a href={url.data ?? `${prUrl}/files`} target="_blank" rel="noreferrer" title={path} className={`${className} no-underline hover:underline`}>
      {shortRef(path, "index")}
    </a>
  );
}

// The ref of a hit: opens the drawer for a decision, lesson or memory, links to the PR diff for an index file.
function HitRef({ hit, kind, job, onOpen }: { hit: RecallHit; kind: RecallKind; job: JobDetail; onOpen: OpenEntry }) {
  const className = `flex-none font-mono text-[11px] font-medium ${KIND_TEXT[kind]}`;
  if (!hit.ref) return <span className={className}>?</span>;
  if (kind === "index") return job.pr_url ? <IndexRef path={hit.ref} prUrl={job.pr_url} className={className} /> : <span className={className} title={hit.ref}>{shortRef(hit.ref, kind)}</span>;
  const entry: MemoryEntry = { ref: hit.ref, kind, title: hit.title, text: hit.text ?? null };
  return (
    <button type="button" className={`${className} cursor-pointer border-0 bg-transparent p-0 hover:underline`} onClick={() => onOpen(entry)}>
      {hit.ref}
    </button>
  );
}

// The score of a hit and its 36px meter in the kind's colour, nothing when the hit has no score.
function ScoreMeter({ score, kind }: { score: number | null; kind: RecallKind }) {
  const label = scoreLabel(score);
  if (label === null || score === null) return null;
  const width = `${Math.round(Math.min(1, Math.max(0, score)) * 100)}%`;
  return (
    <span className="ml-auto flex flex-none items-center gap-[5px] font-mono text-[10px] text-dim">
      {label}
      <span className="h-1 w-9 overflow-hidden rounded-sm bg-line">
        <i className={`block h-full ${KIND_BAR[kind]}`} style={{ width }} />
      </span>
    </span>
  );
}

// One hit under its query: coloured ref, title and score; a fallback hit is dimmed.
function HitRow({ hit, kind, job, onOpen }: { hit: RecallHit; kind: RecallKind; job: JobDetail; onOpen: OpenEntry }) {
  const fallback = isFallback(hit);
  const score = scoreLabel(hit.score);
  const title = fallback ? "recent context — did not match the query" : [hit.title, score].filter(Boolean).join(" · ");
  return (
    <div className={`flex min-w-0 items-center gap-[7px] pl-[19px] text-xs ${fallback ? "opacity-50" : ""}`} title={title}>
      <HitRef hit={hit} kind={kind} job={job} onOpen={onOpen} />
      <span className="min-w-0 truncate text-log">{hit.title ?? ""}</span>
      <ScoreMeter score={hit.score} kind={kind} />
    </div>
  );
}

// What a recall brought back: its hits, or why there is nothing to show.
function RecallHits({ recall, job, onOpen }: { recall: Recall; job: JobDetail; onOpen: OpenEntry }) {
  const hits = hitsOf(recall);
  if (recall.pending) return <p className="m-0 pl-[19px] text-xs text-dim">waiting for the answer…</p>;
  if (recall.error) return <p className="m-0 pl-[19px] text-xs text-red">{recall.error}</p>;
  if (hits.length === 0) return <p className="m-0 pl-[19px] text-xs text-dim">none</p>;
  return (
    <>
      {hits.map((hit, index) => (
        <HitRow key={`${hit.ref ?? "?"}-${index}`} hit={hit} kind={kindOf(recall)} job={job} onOpen={onOpen} />
      ))}
    </>
  );
}

// One recall block: its query line, then its hits.
function RecallBlock({ recall, job, onOpen }: { recall: Recall; job: JobDetail; onOpen: OpenEntry }) {
  return (
    <li className="flex flex-col gap-1.5 border-b border-row-line px-3.5 py-[9px] last:border-b-0">
      <QueryLine recall={recall} />
      <RecallHits recall={recall} job={job} onOpen={onOpen} />
    </li>
  );
}

// A padded line inside the card for its loading error or empty state.
function MemoryMessage({ children }: { children: ReactNode }) {
  return (
    <div className="px-3.5 py-2.5">
      <CardEmpty>{children}</CardEmpty>
    </div>
  );
}

// The loading state of the card, shaped like recall blocks: a query line and its hits.
function MemorySkeleton() {
  return (
    <ul className="m-0 list-none p-0" aria-busy="true" aria-label="loading the recalls">
      {SKELETON_BLOCKS.map((width) => (
        <li key={width} className="flex flex-col gap-1.5 border-b border-row-line px-3.5 py-[9px] last:border-b-0">
          <span className={`block h-3 animate-pulse rounded bg-row-line ${width}`} />
          <span className="ml-[19px] block h-3 w-4/5 animate-pulse rounded bg-row-line" />
        </li>
      ))}
    </ul>
  );
}

// The recall timeline in run order, scrolling past about twelve rows, or the empty sentence.
function RecallList({ answer, job, onOpen }: { answer: RecallsAnswer; job: JobDetail; onOpen: OpenEntry }) {
  const recalls = recallsOf(answer);
  if (recalls.length === 0) return <MemoryMessage>Nothing remembered yet — the run has not asked memory.</MemoryMessage>;
  return (
    <ul className="m-0 max-h-[324px] list-none overflow-y-auto p-0">
      {recalls.map((recall, index) => (
        <RecallBlock key={recall.id ?? index} recall={recall} job={job} onOpen={onOpen} />
      ))}
    </ul>
  );
}

// The footer: the embedding the hits were ranked with and the link to the run's whole recall record.
function MemoryFooter({ answer, jobRefText }: { answer: RecallsAnswer; jobRefText: string }) {
  const embedding = answer.embedding;
  const threshold = scoreLabel(embedding?.threshold);
  return (
    <div className="flex items-center gap-2.5 border-t border-line px-3.5 py-2 text-xs text-dim">
      {embedding && <span className="min-w-0">{`embedding ${embedding.model}${threshold ? ` · threshold ${threshold}` : ""}`}</span>}
      <a href={`/api/jobs/${encodeURIComponent(jobRefText)}/recalls`} target="_blank" rel="noreferrer" className="ml-auto shrink-0 text-link no-underline">
        All memory ↗
      </a>
    </div>
  );
}

// The memory card: every recall of the run in order, each with what came back, and the drawer of one recalled entry.
export function MemoryCard({ job, running }: { job: JobDetail; running: boolean }) {
  const ref = jobRef(job.id);
  const recalls = useRecalls(ref, running);
  const [opened, setOpened] = useState<MemoryEntry | null>(null);
  return (
    <section aria-label="memory" className="flex min-w-0 flex-col overflow-hidden rounded-lg border border-line bg-surface p-0">
      <MemoryHeader answer={recalls.data} />
      {recalls.isPending && <MemorySkeleton />}
      {recalls.isError && !recalls.data && <MemoryMessage>{`The recalls cannot be read: ${errorText(recalls.error)}`}</MemoryMessage>}
      {recalls.data && <RecallList answer={recalls.data} job={job} onOpen={setOpened} />}
      {recalls.data && <MemoryFooter answer={recalls.data} jobRefText={ref} />}
      {opened && <MemoryDrawer entry={opened} project={job.project} onClose={() => setOpened(null)} />}
    </section>
  );
}
