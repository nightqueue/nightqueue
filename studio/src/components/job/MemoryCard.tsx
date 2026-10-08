import { useQuery } from "@tanstack/react-query";
import { Scale, Search } from "lucide-react";
import { type ReactNode, useState } from "react";
import { errorText } from "../../lib/actions";
import { getJson } from "../../lib/api";
import { elapsedClock } from "../../lib/format";
import { usePrFileUrl } from "../../lib/pr-file";
import { jobRef } from "../../lib/queue";
import type { JobDetail, Recall, RecallHit, RecallKind, RecallsAnswer } from "../../lib/types";
import { ICON_STROKE } from "../StatusIcon";
import { CardEmpty, CardTitle } from "./Card";
import { LogTag } from "./log/LogBits";
import { type MemoryEntry, MemoryDrawer } from "./MemoryDrawer";

const RUNNING_REFRESH_MS = 10_000;

const SKELETON_BLOCKS = ["w-3/4", "w-2/3", "w-1/2"];

const FALLBACK_VIA = "fallback";

const PREVIEW_HITS = 3;

type HitKind = Exclude<RecallKind, "context">;

const KIND_TEXT: Record<HitKind, string> = {
  decision: "text-mem-decision",
  lesson: "text-mem-lesson",
  index: "text-mem-index",
  memory: "text-note",
};

const KIND_BAR: Record<HitKind, string> = {
  decision: "bg-mem-decision",
  lesson: "bg-mem-lesson",
  index: "bg-mem-index",
  memory: "bg-note",
};

const KIND_WORDS: { kind: HitKind; one: string; many: string }[] = [
  { kind: "decision", one: "decision", many: "decisions" },
  { kind: "lesson", one: "lesson", many: "lessons" },
  { kind: "memory", one: "memory", many: "memories" },
];

const BADGE_KINDS: { kind: HitKind; letter: string; one: string; many: string }[] = [
  { kind: "decision", letter: "D", one: "decision", many: "decisions" },
  { kind: "lesson", letter: "L", one: "lesson", many: "lessons" },
  { kind: "memory", letter: "M", one: "memory", many: "memories" },
  { kind: "index", letter: "I", one: "index file", many: "index files" },
];

type OpenEntry = (entry: MemoryEntry) => void;

type KindPart = { count: number; word: string };

type BadgeCount = { kind: HitKind; letter: string; count: number; title: string };

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

// The colour family of a recall's kind, the memory one for a context block or a kind this page does not know.
function kindOf(recall: Recall): HitKind {
  return recall.kind in KIND_TEXT ? (recall.kind as HitKind) : "memory";
}

// The colour family of one hit: its own kind when the recall carries one per hit, else the recall's.
function hitKindOf(hit: RecallHit, recall: Recall): HitKind {
  return hit.kind && hit.kind in KIND_TEXT ? hit.kind : kindOf(recall);
}

// The sources that cite a hit, an empty list when the payload carries none.
function appliedOf(hit: RecallHit): string[] {
  return Array.isArray(hit.applied) ? hit.applied.filter((source) => typeof source === "string") : [];
}

// Whether the run went on to cite a hit.
function isApplied(hit: RecallHit): boolean {
  return appliedOf(hit).length > 0;
}

// The non-zero counts of a context block's hits per kind, decisions first.
function kindParts(hits: RecallHit[], recall: Recall): KindPart[] {
  return KIND_WORDS.map(({ kind, one, many }) => {
    const count = hits.filter((hit) => hitKindOf(hit, recall) === kind).length;
    return { count, word: count === 1 ? one : many };
  }).filter((part) => part.count > 0);
}

// The kind counts as `51 decisions · 4 lessons`.
function kindPartsLabel(parts: KindPart[]): string {
  return parts.map((part) => `${part.count} ${part.word}`).join(" · ");
}

// The non-zero hit counts of a context block per badge kind, in D, L, M, I order.
function badgeCounts(hits: RecallHit[], recall: Recall): BadgeCount[] {
  return BADGE_KINDS.map(({ kind, letter, one, many }) => {
    const count = hits.filter((hit) => hitKindOf(hit, recall) === kind).length;
    return { kind, letter, count, title: `${count} ${count === 1 ? one : many}` };
  }).filter((badge) => badge.count > 0);
}

// Who asked and when: the agent, its call count when merged, the attempt past the first and the clock.
function whoLabel(recall: Recall): string {
  const calls = typeof recall.calls === "number" && recall.calls > 1 ? ` · ${recall.calls} calls` : "";
  const attempt = recall.attempt > 1 ? `#${recall.attempt} ` : "";
  const when = elapsedClock(typeof recall.at_s === "number" ? recall.at_s * 1000 : null);
  return `${recall.agent}${calls} · ${attempt}${when}`;
}

// The hits a block shows at first, the ones behind its unfold button and that button's label.
function foldHits(recall: Recall, hits: RecallHit[]): { shown: RecallHit[]; hidden: RecallHit[]; more: string } {
  if (recall.kind !== "context") {
    const hidden = hits.slice(PREVIEW_HITS);
    return { shown: hits.slice(0, PREVIEW_HITS), hidden, more: `… ${hidden.length} more` };
  }
  const hidden = hits.filter((hit) => !isApplied(hit));
  const [first, ...rest] = kindParts(hidden, recall);
  const label = first ? [`${first.count} more ${first.word}`, kindPartsLabel(rest)].filter(Boolean).join(" · ") : "";
  return { shown: hits.filter(isApplied), hidden, more: `… ${label}, not cited` };
}

// A 0..1 similarity as `.81`, or null when it is not a finite number.
function scoreLabel(score: number | null | undefined): string | null {
  if (typeof score !== "number" || !Number.isFinite(score)) return null;
  return score.toFixed(2).replace(/^0(?=\.)/, "");
}

// The last path segment of an indexed file, the whole ref otherwise.
function shortRef(ref: string, kind: HitKind): string {
  return kind === "index" ? ref.slice(ref.lastIndexOf("/") + 1) || ref : ref;
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

// Who asked and when, at the right end of a block's heading.
function WhoLabel({ recall }: { recall: Recall }) {
  return <span className="ml-auto font-sans text-[10px] whitespace-nowrap text-dim">{whoLabel(recall)}</span>;
}

// The query line of a recall: the search icon, the quoted query, then who asked and when.
function QueryLine({ recall }: { recall: Recall }) {
  return (
    <div className="flex items-center gap-[7px] font-mono text-xs text-fg">
      <Search size={12} strokeWidth={ICON_STROKE} aria-hidden="true" className="shrink-0 text-accent" />
      <span className="min-w-0 break-words">
        <span className="text-accent">"</span>
        {recall.query ?? "(no query)"}
        <span className="text-accent">"</span>
      </span>
      <WhoLabel recall={recall} />
    </div>
  );
}

// One kind count of a context block as a small coloured badge like `D 51`.
function KindBadge({ badge }: { badge: BadgeCount }) {
  return (
    <span title={badge.title} className={`rounded-[3px] border border-current/40 px-[5px] font-mono text-[10px] leading-[14px] ${KIND_TEXT[badge.kind]}`}>
      {`${badge.letter} ${badge.count}`}
    </span>
  );
}

// The kind badges of a context block, only the kinds it brought back.
function KindBadges({ recall }: { recall: Recall }) {
  return badgeCounts(hitsOf(recall), recall).map((badge) => <KindBadge key={badge.kind} badge={badge} />);
}

// The heading of a context block: the one-line phase title, then its kind badges and who asked and when.
function ContextLine({ recall }: { recall: Recall }) {
  const subject = typeof recall.phase === "number" ? `phase ${recall.phase}` : (recall.target ?? "a phase");
  const title = `context for ${subject}`;
  return (
    <div className="flex flex-col gap-1">
      <div className="flex min-w-0 items-center gap-[7px] font-mono text-xs text-fg">
        <Scale size={12} strokeWidth={ICON_STROKE} aria-hidden="true" className="shrink-0 text-accent" />
        <span className="min-w-0 flex-1 truncate" title={title}>
          {title}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-1.5 pl-[19px]">
        <KindBadges recall={recall} />
        <WhoLabel recall={recall} />
      </div>
    </div>
  );
}

// The heading of a block: a context block's phase line, the quoted query of any other recall.
function BlockHeading({ recall }: { recall: Recall }) {
  return recall.kind === "context" ? <ContextLine recall={recall} /> : <QueryLine recall={recall} />;
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
function HitRef({ hit, kind, job, onOpen }: { hit: RecallHit; kind: HitKind; job: JobDetail; onOpen: OpenEntry }) {
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
function ScoreMeter({ score, kind }: { score: number | null; kind: HitKind }) {
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

// The green tag of an applied hit naming the first source that cites it, every source on hover.
function AppliedTag({ sources }: { sources: string[] }) {
  return (
    <span className="ml-auto flex-none" title={`cited in ${sources.join(", ")}`}>
      <LogTag tone="green">{`✓ ${sources[0].replace(/\.md$/, "")}`}</LogTag>
    </span>
  );
}

// One hit under its heading: coloured ref, title, then where it was cited or its score; a fallback hit is dimmed.
function HitRow({ hit, kind, job, onOpen }: { hit: RecallHit; kind: HitKind; job: JobDetail; onOpen: OpenEntry }) {
  const fallback = isFallback(hit);
  const sources = appliedOf(hit);
  const score = scoreLabel(hit.score);
  const title = fallback ? "recent context — did not match the query" : [hit.title, score].filter(Boolean).join(" · ");
  return (
    <div className={`flex min-w-0 items-center gap-[7px] pl-[19px] text-xs ${fallback ? "opacity-50" : ""}`} title={title}>
      <HitRef hit={hit} kind={kind} job={job} onOpen={onOpen} />
      <span className={`min-w-0 truncate ${sources.length > 0 ? "text-fg" : "text-log"}`}>{hit.title ?? ""}</span>
      {sources.length > 0 ? <AppliedTag sources={sources} /> : <ScoreMeter score={hit.score} kind={kind} />}
    </div>
  );
}

// The button that unfolds the hits a block keeps folded.
function MoreHitsButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="cursor-pointer self-start border-0 bg-transparent p-0 pl-[19px] text-left font-mono text-[11px] text-dim hover:text-fg">
      {label}
    </button>
  );
}

// A block's hits folded to the first few (to the cited ones for a context block), the rest behind a button.
function FoldedHits({ recall, hits, job, onOpen }: { recall: Recall; hits: RecallHit[]; job: JobDetail; onOpen: OpenEntry }) {
  const [unfolded, setUnfolded] = useState(false);
  const { shown, hidden, more } = foldHits(recall, hits);
  const visible = unfolded ? [...shown, ...hidden] : shown;
  return (
    <>
      {visible.map((hit, index) => (
        <HitRow key={`${hit.ref ?? "?"}-${index}`} hit={hit} kind={hitKindOf(hit, recall)} job={job} onOpen={onOpen} />
      ))}
      {!unfolded && hidden.length > 0 && <MoreHitsButton label={more} onClick={() => setUnfolded(true)} />}
    </>
  );
}

// What a recall brought back: its hits, or why there is nothing to show.
function RecallHits({ recall, job, onOpen }: { recall: Recall; job: JobDetail; onOpen: OpenEntry }) {
  const hits = hitsOf(recall);
  if (recall.pending) return <p className="m-0 pl-[19px] text-xs text-dim">waiting for the answer…</p>;
  if (recall.error) return <p className="m-0 pl-[19px] text-xs text-red">{recall.error}</p>;
  if (hits.length === 0) return <p className="m-0 pl-[19px] text-xs text-dim">none</p>;
  return <FoldedHits recall={recall} hits={hits} job={job} onOpen={onOpen} />;
}

// One recall block: its heading, then its hits.
function RecallBlock({ recall, job, onOpen }: { recall: Recall; job: JobDetail; onOpen: OpenEntry }) {
  return (
    <li className="flex flex-col gap-1.5 border-b border-row-line px-3.5 py-[9px] last:border-b-0">
      <BlockHeading recall={recall} />
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
