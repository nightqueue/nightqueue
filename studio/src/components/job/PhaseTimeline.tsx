import { CircleCheck, LoaderCircle, TriangleAlert } from "lucide-react";
import { Fragment, type ReactNode } from "react";
import { formatDurationMs, type GateWait, gatePosition, gateWaits } from "../../lib/format";
import { withoutHeadingMarker } from "../../lib/markdown";
import type { Job, JobDetail, JobMeta, JobStatus, Timeline, TimelinePhase } from "../../lib/types";
import { ActionIcon, StatusIcon } from "../StatusIcon";
import { CardTitle } from "./Card";
import { BUDGET_COUNTER_TOOLTIP } from "./JobHeader";
import { TotalsStrip } from "./TotalsStrip";

const LANE_PHASES = new Set([1, 2, 3, 4, 5, 6]);

const FLOW_BAR = "bg-[linear-gradient(90deg,#2f4f3c_0%,#8cc8a0_40%,#d7f2e1_50%,#8cc8a0_60%,#2f4f3c_100%)] bg-[length:200%_100%] animate-flow motion-reduce:animate-none";

const BAR_STYLE: Record<TimelinePhase["state"], string> = {
  done: "bg-green",
  now: FLOW_BAR,
  gate: "bg-gate-bar",
  pending: "bg-line",
  skip: "bg-row-line",
};

const NAME_STYLE: Record<TimelinePhase["state"], string> = {
  done: "text-fg",
  now: "text-fg",
  gate: "text-fg",
  pending: "text-muted",
  skip: "text-dim",
};

const TIME_STYLE: Record<TimelinePhase["state"], string> = {
  done: "text-dim",
  now: "text-accent",
  gate: "text-red",
  pending: "text-dim",
  skip: "text-dim",
};

const CHIP = "inline-flex items-center gap-[5px] rounded-full border px-[9px] py-[3px] text-sm leading-4";

interface PhaseTimelineProps {
  job: JobDetail;
  row: Job | undefined;
  baseline: JobMeta["baseline"] | undefined;
  tier: string | null;
  timeline: Timeline | null;
  reason: string | null;
  runElapsedMs: number | null;
}

// The time a phase has spent so far: its summed duration, plus the part still open while it runs.
export function spentMs(phase: TimelinePhase, runElapsedMs: number | null): number | null {
  if (phase.state !== "now" || phase.liveSinceMs === null || runElapsedMs === null) return phase.durationMs;
  return (phase.durationMs ?? 0) + Math.max(0, runElapsedMs - phase.liveSinceMs);
}

// The time caption of one phase: its duration, `gate` where the gate stopped it, `—` before it ran.
function phaseTime(phase: TimelinePhase, runElapsedMs: number | null): string {
  if (phase.state === "pending" || phase.state === "skip") return "—";
  const spent = formatDurationMs(spentMs(phase, runElapsedMs));
  return phase.state === "gate" ? `${spent} · gate` : spent;
}

// The tokens caption of one phase: its tokens once it spent any, `—` for a done phase that spent none, blank before it ran.
function phaseTokens(phase: TimelinePhase): string {
  if (phase.state === "pending" || phase.state === "skip") return " ";
  if (phase.tokens > 0) return phase.tokens_label;
  return phase.state === "done" ? "—" : " ";
}

// The last phase the run reached, null before any started.
function reachedPhase(phases: TimelinePhase[]): TimelinePhase | null {
  return [...phases].reverse().find((phase) => phase.state !== "pending" && phase.state !== "skip") ?? null;
}

// A rounded caption chip of the card's header.
function Chip({ children, className = "border-line text-muted", title }: { children: ReactNode; className?: string; title?: string }) {
  return (
    <span title={title} className={`${CHIP} ${className}`}>
      {children}
    </span>
  );
}

// A phase's place in the track as `n of m`, the same position/count rule as the Queue row's `n/m` counter.
function trackCounter(phases: TimelinePhase[], phase: TimelinePhase): string {
  return `${phases.indexOf(phase) + 1} of ${phases.length}`;
}

// The outcome chip of the header: the running phase, where the gate stopped it, done, or where it failed.
function OutcomeChip({ phases, status, reason }: { phases: TimelinePhase[]; status: JobStatus; reason: string | null }) {
  const total = phases.length;
  if (total === 0) return null;
  const stopped = phases.find((phase) => phase.state === "gate");
  if (status === "gate" && stopped) {
    const caption = reason ? withoutHeadingMarker(reason) : "";
    return <span className="text-red">{`stopped at phase ${stopped.number}${caption ? ` — ${caption}` : ""}`}</span>;
  }
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

// The card's header: the track, its phase range and agents done, the outcome chip and the attempt chip.
function TrackHeader({ job, timeline, reason }: { job: JobDetail; timeline: Timeline | null; reason: string | null }) {
  const known = timeline !== null && timeline.track !== null;
  const phases = timeline?.phases ?? [];
  const lanes = phases.filter((phase) => LANE_PHASES.has(phase.number));
  const agents = `${lanes.filter((phase) => phase.state === "done").length} of ${lanes.length} agents done`;
  const first = phases[0];
  const last = phases[phases.length - 1];
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted">
      <CardTitle>{known ? `Pipeline · ${timeline.track} track` : "Pipeline"}</CardTitle>
      {known && first && last && <span>{`phases ${first.number}–${last.number} · ${agents}`}</span>}
      {timeline !== null && !known && <span>track unknown</span>}
      <span className="ml-auto inline-flex flex-wrap items-center gap-2">
        {known && <OutcomeChip phases={phases} status={job.status} reason={reason} />}
        <Chip title={BUDGET_COUNTER_TOOLTIP}>{`attempt ${job.attempts} of ${job.max_attempts}`}</Chip>
      </span>
    </div>
  );
}

// One segment of the track: its bar, name and model, its time caption and its tokens.
function PhaseSegment({ phase, time }: { phase: TimelinePhase; time: string }) {
  const label = phase.model ? `${phase.number} ${phase.name} · ${phase.model}` : `${phase.number} ${phase.name}`;
  const now = phase.state === "now";
  return (
    <div className="flex min-w-[96px] flex-1 flex-col gap-1.5">
      <div className={`h-1 rounded-sm ${BAR_STYLE[phase.state]}`} />
      <div className={`flex items-center gap-[5px] truncate text-sm ${NAME_STYLE[phase.state]}`} title={label}>
        {now && <ActionIcon icon={LoaderCircle} size={12} className="animate-spin text-accent" />}
        <span className="truncate">{label}</span>
      </div>
      <div className={`font-mono text-xs whitespace-nowrap ${TIME_STYLE[phase.state]}`}>{time}</div>
      <div className={`font-mono text-xs whitespace-nowrap ${now ? "text-accent" : "text-muted"}`}>{phaseTokens(phase)}</div>
    </div>
  );
}

// A gate between two attempts: a short dashed red segment with the wait before the next attempt.
function GateSegment({ gate }: { gate: GateWait }) {
  const wait = formatDurationMs(gate.waitMs);
  return (
    <div className="flex w-[84px] flex-none flex-col gap-1.5" title={`gate after attempt ${gate.attempt} · ${wait} wait · position approximate`}>
      <div className="h-1 rounded-sm bg-[repeating-linear-gradient(90deg,#da3633_0_4px,transparent_4px_8px)]" />
      <div className="flex items-center gap-1 text-xs whitespace-nowrap text-red">
        <ActionIcon icon={TriangleAlert} size={11} />
        gate
      </div>
      <div className="font-mono text-xs whitespace-nowrap text-dim">{`${wait} wait`}</div>
    </div>
  );
}

// The phases on one line, the past gates side by side at their approximate place.
function Track({ phases, gates, runElapsedMs }: { phases: TimelinePhase[]; gates: GateWait[]; runElapsedMs: number | null }) {
  const at = gates.length ? gatePosition(phases) : -1;
  const gateSegments = gates.map((gate) => <GateSegment key={`gate-${gate.index}`} gate={gate} />);
  return (
    <div className="flex items-start gap-1.5 overflow-x-auto pb-1">
      {phases.map((phase, index) => (
        <Fragment key={phase.number}>
          {index === at && gateSegments}
          <PhaseSegment phase={phase} time={phaseTime(phase, runElapsedMs)} />
        </Fragment>
      ))}
      {at === phases.length && gateSegments}
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

// The pipeline card: the job's totals, then one segment per phase of the tier's track and the gates between attempts.
export function PhaseTimeline({ job, row, baseline, tier, timeline, reason, runElapsedMs }: PhaseTimelineProps) {
  const known = timeline !== null && timeline.track !== null;
  return (
    <section aria-label="phases" className="flex flex-col gap-3 rounded-lg border border-line bg-surface px-4 py-3.5">
      <TrackHeader job={job} timeline={timeline} reason={reason} />
      {timeline === null ? (
        <TrackSkeleton />
      ) : (
        <>
          <TotalsStrip job={job} row={row} baseline={baseline} tier={tier} timeline={timeline} />
          {known && <Track phases={timeline.phases} gates={gateWaits(job.attempts_log)} runElapsedMs={runElapsedMs} />}
        </>
      )}
    </section>
  );
}
