import { Clock } from "lucide-react";
import type { ReactNode } from "react";
import { activeMs, attemptsSummary, compactCount, durationLabel, formatDurationMs, tokenCounters, tokensTotalLabel, usdLabel, wallMs } from "../../lib/format";
import { type ShareEntry, shareEntries } from "../../lib/track";
import type { Job, JobDetail, JobMeta, Timeline, TimelinePhase } from "../../lib/types";
import { useNow } from "../../lib/useNow";
import { ActionIcon } from "../StatusIcon";

export interface TotalsStripProps {
  job: JobDetail;
  row: Job | undefined;
  baseline: JobMeta["baseline"] | undefined;
  tier: string | null;
  timeline: Timeline;
}

interface Total {
  key: ReactNode;
  value: string;
  live?: boolean;
  lines: (string | null)[];
  title?: string;
}

const SHARE_RUNNING_OPACITY = 0.7;

const CELL_GRID = "grid grid-cols-2 gap-x-[22px] gap-y-3 md:grid-cols-[repeat(4,minmax(0,1fr))_minmax(220px,1.4fr)]";

// `1 gate`, `2 gates`: a count with its noun, plural past one.
function counted(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

// The active time cell: every attempt summed while it ticks, the wall and gate time under it once the history is known.
function activeTotal(job: JobDetail, now: number): Total {
  const active = activeMs(job, now);
  const value = active === null ? durationLabel(job.started_at, job.finished_at, now) : formatDurationMs(active);
  const hasLog = Array.isArray(job.attempts_log) && job.attempts_log.length > 0;
  const wall = hasLog ? wallMs(job, now) : null;
  const atGate = wall !== null && active !== null ? wall - active : 0;
  const sub = wall === null ? null : atGate > 0 ? `wall ${formatDurationMs(wall)} · ${formatDurationMs(atGate)} at gate` : `wall ${formatDurationMs(wall)}`;
  return { key: <><ActionIcon icon={Clock} size={12} />active time</>, value, live: true, lines: [sub] };
}

// The tokens cell: the same total the queue row shows, then the counters split by kind.
function tokensTotal(job: JobDetail, row: Job | undefined): Total {
  const counters = tokenCounters(job);
  const cache = (counters.cacheRead ?? 0) + (counters.cacheWrite ?? 0);
  const anyCache = counters.cacheRead !== null || counters.cacheWrite !== null;
  return {
    key: "tokens",
    value: row?.studio.tokens_label || tokensTotalLabel(job),
    live: true,
    lines: [`in ${compactCount(counters.in)} · out ${compactCount(counters.out)} · cache ${anyCache ? compactCount(cache) : "-"}`, `cache read ${compactCount(counters.cacheRead)} · write ${compactCount(counters.cacheWrite)}`],
  };
}

// The cost cell: the cost so far, the tier median beside it, the orchestrator's turns and context.
function costTotal(job: JobDetail, baseline: JobMeta["baseline"] | undefined, tier: string | null): Total {
  const median = tier && baseline && baseline.n > 0 ? baseline : null;
  return {
    key: job.status === "running" ? "cost so far" : "cost",
    value: usdLabel(job.cost_usd),
    lines: [median ? `median ${tier} ${usdLabel(median.cost)}` : null, `orch ${compactCount(job.orch_turns)} turns · ctx ${compactCount(job.orch_ctx_last)} · base ctx ${compactCount(job.baseline_ctx)}`],
    title: median ? `${tier} median: ${compactCount(median.turns)} turns · ${compactCount(median.ctx)} ctx · ${usdLabel(median.cost)} (n=${median.n})` : undefined,
  };
}

// The attempts cell with its gates, failures and bash timeouts; TODO(NQ-88): keys are optional on older homes / rows read without attempts.
function attemptsTotal(job: JobDetail): Total {
  const { count, gates, failed } = attemptsSummary(job);
  const outcomes = gates === null || failed === null ? null : `${counted(gates, "gate")} · ${failed} failed`;
  return { key: "attempts", value: String(count), lines: [outcomes, counted(job.bash_timeouts ?? 0, "bash timeout")] };
}

// One cell of the strip: an uppercase key, a big mono value and its dim sub-lines.
function TotalCell({ total, running, divided }: { total: Total; running: boolean; divided: boolean }) {
  const tone = total.live && running ? "text-accent" : "text-fg";
  return (
    <div title={total.title} className={`min-w-0 ${divided ? "md:border-l md:border-line md:pl-[18px]" : ""}`}>
      <div className="flex items-center gap-1.5 text-xs tracking-[.3px] text-dim uppercase">{total.key}</div>
      <div className={`mt-[3px] truncate font-mono text-[22px] leading-[26px] font-medium ${tone}`}>{total.value}</div>
      {total.lines.filter((line): line is string => line !== null).map((line) => (
        <div key={line} title={total.title ? `${line}\n${total.title}` : line} className="mt-0.5 truncate font-mono text-xs text-dim">
          {line}
        </div>
      ))}
    </div>
  );
}

// The legend of the share bar: a dot in the segment's color, the phase name and its percent, per phase in bar order.
function ShareLegend({ entries }: { entries: ShareEntry[] }) {
  return (
    <ul className="m-0 mt-2 flex list-none flex-wrap gap-x-3 gap-y-1 p-0 text-xs text-muted">
      {entries.map((entry) => (
        <li key={entry.number} className="flex items-center gap-1.5" style={{ opacity: entry.running ? SHARE_RUNNING_OPACITY : 1 }}>
          <i className="block h-2 w-2 flex-none rounded-full" style={{ background: entry.color }} />
          <span>{entry.name}</span>
          <span className="font-mono text-dim">{entry.percent}</span>
        </li>
      ))}
    </ul>
  );
}

// The token share of every phase that spent any, as one stacked bar with its legend; an empty grey bar before any.
function ShareBar({ phases }: { phases: TimelinePhase[] }) {
  const entries = shareEntries(phases);
  const spent = phases.filter((phase) => phase.tokens > 0);
  const title = spent.map((phase) => `${phase.number} ${phase.name} ${phase.tokens_label}`).join(" · ");
  return (
    <div className="col-span-2 min-w-0 md:col-span-1 md:border-l md:border-line md:pl-[18px]">
      <div className="text-xs tracking-[.3px] text-dim uppercase">token share by phase</div>
      <div className="mt-3 flex h-2 overflow-hidden rounded bg-row-line" title={title || undefined}>
        {entries.map((entry) => (
          <i key={entry.number} className="block h-full" style={{ width: `${entry.share * 100}%`, background: entry.color, opacity: entry.running ? SHARE_RUNNING_OPACITY : 1 }} />
        ))}
      </div>
      <ShareLegend entries={entries} />
    </div>
  );
}

// The job's totals above the phases: active time, tokens, cost, attempts and the token share by phase.
export function TotalsStrip({ job, row, baseline, tier, timeline }: TotalsStripProps) {
  const now = useNow();
  const running = job.status === "running";
  const totals = [activeTotal(job, now), tokensTotal(job, row), costTotal(job, baseline, tier), attemptsTotal(job)];
  return (
    <div className={`${CELL_GRID} rounded-md border border-line bg-inset px-3.5 pt-2.5 pb-3`}>
      {totals.map((total, index) => (
        <TotalCell key={index} total={total} running={running} divided={index > 0} />
      ))}
      <ShareBar phases={timeline.phases} />
    </div>
  );
}
