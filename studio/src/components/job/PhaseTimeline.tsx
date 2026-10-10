import { CircleCheck, LoaderCircle, SkipForward, TriangleAlert } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import { phaseVar } from "../../lib/phase-colors";
import { phaseAttemptsTitle, phaseCaption, trackCounts } from "../../lib/track";
import type { AttemptRow, Job, JobDetail, JobMeta, JobStatus, Timeline, TimelinePhase } from "../../lib/types";
import { ActionIcon, StatusIcon } from "../StatusIcon";
import { CardTitle } from "./Card";
import { BUDGET_COUNTER_TOOLTIP } from "./JobHeader";
import { TotalsStrip } from "./TotalsStrip";

type PhaseState = TimelinePhase["state"];

const LANE_PHASES = new Set([1, 2, 3, 4, 5, 6]);

const FLOW_BAR_CLASS = "bg-[length:200%_100%] animate-flow motion-reduce:animate-none";

const FLOW_BAR_IMAGE = "linear-gradient(90deg, color-mix(in srgb, var(--ph) 40%, #0f1219), var(--ph), color-mix(in srgb, var(--ph) 40%, #0f1219))";

const BAR_CLASS: Record<PhaseState, string> = {
  done: "",
  now: FLOW_BAR_CLASS,
  gate: "bg-gate-bar",
  pending: "bg-line",
  skipped: "ph-hatch",
};

const BAR_STYLE: Partial<Record<PhaseState, CSSProperties>> = {
  done: { background: "var(--ph)" },
  now: { backgroundImage: FLOW_BAR_IMAGE },
};

const DOT_STYLE: Record<PhaseState, CSSProperties> = {
  done: { background: "var(--ph)" },
  now: { background: "var(--ph)" },
  gate: { background: "var(--ph)" },
  pending: { background: "var(--ph)", opacity: 0.45 },
  skipped: { border: "1.5px solid var(--ph)", background: "transparent" },
};

const NAME_STYLE: Record<PhaseState, string> = {
  done: "text-fg",
  now: "text-fg",
  gate: "text-fg",
  pending: "text-muted",
  skipped: "text-dim",
};

const TIME_STYLE: Record<PhaseState, string> = {
  done: "text-dim",
  now: "text-accent",
  gate: "text-red",
  pending: "text-dim",
  skipped: "text-dim",
};

const CHIP = "inline-flex items-center gap-[5px] rounded-full border px-[9px] py-[3px] text-sm leading-4";

interface PhaseTimelineProps {
  job: JobDetail;
  row: Job | undefined;
  baseline: JobMeta["baseline"] | undefined;
  tier: string | null;
  timeline: Timeline | null;
  runElapsedMs: number | null;
}

// The tokens caption of one phase: its tokens once it spent any, `—` for a done phase that spent none, blank before it ran.
function phaseTokens(phase: TimelinePhase): string {
  if (phase.state === "pending" || phase.state === "skipped") return " ";
  if (phase.tokens > 0) return phase.tokens_label;
  return phase.state === "done" ? "—" : " ";
}

// The last phase the run reached, null before any started.
function reachedPhase(phases: TimelinePhase[]): TimelinePhase | null {
  return [...phases].reverse().find((phase) => phase.state !== "pending") ?? null;
}

// A rounded caption chip of the card's header.
function Chip({ children, className = "border-line text-muted", title }: { children: ReactNode; className?: string; title?: string }) {
  return (
    <span title={title} className={`${CHIP} ${className}`}>
      {children}
    </span>
  );
}

// A phase's place among the running slots as `n of m`, the same position/count rule as the Queue row's `n/m` counter.
function trackCounter(phases: TimelinePhase[], phase: TimelinePhase): string {
  return `${phases.indexOf(phase) + 1} of ${phases.length}`;
}

// The outcome chip of the header over the running slots: the running phase, where the gate stopped it, done, or where it failed.
function OutcomeChip({ phases, status }: { phases: TimelinePhase[]; status: JobStatus }) {
  const total = phases.length;
  if (status === "gate") {
    const stopped = phases.find((phase) => phase.state === "gate") ?? phases[0];
    return (
      <Chip className="border-gate-line text-red">
        <ActionIcon icon={TriangleAlert} size={12} />
        {stopped ? `gate at phase ${stopped.number}` : "gate"}
      </Chip>
    );
  }
  if (total === 0) return null;
  const reached = phases.find((phase) => phase.state === "now") ?? reachedPhase(phases);
  if (status === "running") {
    return (
      <Chip>
        <ActionIcon icon={LoaderCircle} size={12} className="animate-spin text-accent" />
        {reached ? `phase ${trackCounter(phases, reached)}` : "starting"}
      </Chip>
    );
  }
  if (status === "done" || status === "closed") {
    return (
      <Chip className="border-run-line text-green">
        <ActionIcon icon={CircleCheck} size={12} />
        {`done · ${total} of ${total}`}
      </Chip>
    );
  }
  if (status === "failed" || status === "cancelled") {
    return (
      <Chip>
        <StatusIcon status={status} closeState={null} closing={false} size={12} />
        {reached ? `${status} · phase ${trackCounter(phases, reached)}` : status}
      </Chip>
    );
  }
  return null;
}

// The phase range of the track and how many of its running agent slots are done.
function agentsSummary(phases: TimelinePhase[], running: TimelinePhase[]): string | null {
  const first = phases[0];
  const last = phases[phases.length - 1];
  if (!first || !last) return null;
  const lanes = running.filter((phase) => LANE_PHASES.has(phase.number));
  const done = lanes.filter((phase) => phase.state === "done").length;
  return `phases ${first.number}–${last.number} · ${done} of ${lanes.length} agents done`;
}

// The card's header: the track or `tier pending`, its phase range and agents done, the outcome, skipped and attempt chips.
function TrackHeader({ job, timeline }: { job: JobDetail; timeline: Timeline | null }) {
  const known = timeline !== null && timeline.track !== null;
  const phases = timeline?.phases ?? [];
  const { running, skipped } = trackCounts(phases);
  const summary = agentsSummary(phases, running);
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted">
      <CardTitle>{known ? `Pipeline · ${timeline.track} track` : "Pipeline"}</CardTitle>
      {timeline !== null && !known && <span className="text-dim">tier pending</span>}
      {summary && <span>{summary}</span>}
      <span className="ml-auto inline-flex flex-wrap items-center gap-2">
        {known && <OutcomeChip phases={running} status={job.status} />}
        {skipped > 0 && <Chip className="border-line text-dim">{`${skipped} skipped`}</Chip>}
        <Chip title={BUDGET_COUNTER_TOOLTIP}>{`attempt ${job.attempts} of ${job.max_attempts}`}</Chip>
      </span>
    </div>
  );
}

// The icon before a phase's name: a spinner while it runs, a triangle where the gate stopped it, a skip arrow on a skipped slot.
function PhaseIcon({ state }: { state: PhaseState }) {
  if (state === "now") return <ActionIcon icon={LoaderCircle} size={12} className="animate-spin text-accent" />;
  if (state === "gate") return <ActionIcon icon={TriangleAlert} size={11} className="text-red" />;
  if (state === "skipped") return <ActionIcon icon={SkipForward} size={11} className="text-dim" />;
  return null;
}

// The 7px role dot and the 4px bar of one slot, both painted from the slot's `--ph` colour.
function PhaseRail({ state }: { state: PhaseState }) {
  return (
    <div className="flex items-center gap-1.5">
      <i className="block h-[7px] w-[7px] flex-none rounded-full" style={DOT_STYLE[state]} />
      <div className={`h-1 flex-1 rounded-sm ${BAR_CLASS[state]}`} style={BAR_STYLE[state]} />
    </div>
  );
}

// One slot of the track: its rail, name and model, its caption with the per-attempt hover, and its tokens unless it was skipped.
function PhaseSegment({ phase, caption, attemptsTitle }: { phase: TimelinePhase; caption: string; attemptsTitle: string }) {
  const label = phase.model ? `${phase.number} ${phase.name} · ${phase.model}` : `${phase.number} ${phase.name}`;
  const skipped = phase.state === "skipped";
  const style = { "--ph": phaseVar(phase.agent), flex: skipped ? "0.62 1 0%" : "1 1 0%" } as CSSProperties;
  return (
    <div className={`flex flex-col gap-1.5 ${skipped ? "min-w-[64px]" : "min-w-[96px]"}`} style={style}>
      <PhaseRail state={phase.state} />
      <div className={`flex items-center gap-[5px] truncate text-sm ${NAME_STYLE[phase.state]}`} title={label}>
        <PhaseIcon state={phase.state} />
        <span className="truncate">{label}</span>
      </div>
      <div className={`truncate font-mono text-xs whitespace-nowrap ${TIME_STYLE[phase.state]}`} title={attemptsTitle || caption}>
        {caption}
      </div>
      {!skipped && <div className={`font-mono text-xs whitespace-nowrap ${phase.state === "now" ? "text-accent" : "text-muted"}`}>{phaseTokens(phase)}</div>}
    </div>
  );
}

interface TrackProps {
  phases: TimelinePhase[];
  tier: string | null;
  runElapsedMs: number | null;
  clockMs: number | null;
  attemptsLog: AttemptRow[] | null | undefined;
}

// The nine slots on one line; a gate is the state of the phase it stopped, a skipped slot is narrower and hatched.
function Track({ phases, tier, runElapsedMs, clockMs, attemptsLog }: TrackProps) {
  return (
    <div className="flex items-start gap-1.5 overflow-x-auto pb-1">
      {phases.map((phase) => (
        <PhaseSegment key={phase.number} phase={phase} caption={phaseCaption(phase, { runElapsedMs, clockMs, tier })} attemptsTitle={phaseAttemptsTitle(phase, attemptsLog)} />
      ))}
    </div>
  );
}

// The loading shape of the track: nine grey segments.
function TrackSkeleton() {
  return (
    <div className="flex gap-1.5" aria-busy="true">
      {Array.from({ length: 9 }, (_, index) => (
        <div key={index} className="flex min-w-[96px] flex-1 flex-col gap-1.5">
          <span className="block h-1 rounded-sm bg-line" />
          <span className="block h-3 w-3/4 animate-pulse rounded bg-row-line" />
          <span className="block h-2.5 w-1/2 animate-pulse rounded bg-row-line" />
          <span className="block h-2.5 w-1/3 animate-pulse rounded bg-row-line" />
        </div>
      ))}
    </div>
  );
}

// The pipeline card: the job's totals, then the nine slots of the universal track.
export function PhaseTimeline({ job, row, baseline, tier, timeline, runElapsedMs }: PhaseTimelineProps) {
  return (
    <section aria-label="phases" className="flex flex-col gap-3 rounded-lg border border-line bg-surface px-4 py-3.5">
      <TrackHeader job={job} timeline={timeline} />
      {timeline === null ? (
        <TrackSkeleton />
      ) : (
        <>
          <TotalsStrip job={job} row={row} baseline={baseline} tier={tier} timeline={timeline} />
          <Track phases={timeline.phases} tier={timeline.tier ?? null} runElapsedMs={runElapsedMs} clockMs={timeline.clockMs ?? null} attemptsLog={job.attempts_log} />
        </>
      )}
    </section>
  );
}
