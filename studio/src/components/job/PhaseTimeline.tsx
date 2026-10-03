import { formatDurationMs } from "../../lib/format";
import { withoutHeadingMarker } from "../../lib/markdown";
import type { JobStatus, Timeline, TimelinePhase } from "../../lib/types";
import { CardTitle } from "./Card";

const LANE_PHASES = new Set([1, 2, 3, 4, 5, 6]);

const BAR_STYLE: Record<TimelinePhase["state"], string> = {
  done: "bg-green",
  now: "bg-accent",
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

interface PhaseTimelineProps {
  timeline: Timeline | null;
  status: JobStatus;
  reason: string | null;
  runElapsedMs: number | null;
}

// The time a phase has spent so far: its summed duration, plus the part still open while it runs.
function spentMs(phase: TimelinePhase, runElapsedMs: number | null): number | null {
  if (phase.state !== "now" || phase.liveSinceMs === null || runElapsedMs === null) return phase.durationMs;
  return (phase.durationMs ?? 0) + Math.max(0, runElapsedMs - phase.liveSinceMs);
}

// The caption of one phase: its duration and estimated tokens, `gate` where the gate stopped it, `—` before it ran.
function phaseTime(phase: TimelinePhase, runElapsedMs: number | null): string {
  if (phase.state === "pending" || phase.state === "skip") return "—";
  const parts = [formatDurationMs(spentMs(phase, runElapsedMs)), phase.tokens_label];
  return phase.state === "gate" ? [...parts, "gate"].join(" · ") : parts.join(" · ");
}

// The right side of the card's title: where the run stands, or where the gate stopped it.
function Progress({ timeline, status, reason }: Pick<PhaseTimelineProps, "status" | "reason"> & { timeline: Timeline }) {
  const lanes = timeline.phases.filter((phase) => LANE_PHASES.has(phase.number));
  const agents = `${lanes.filter((phase) => phase.state === "done").length} of ${lanes.length} agents done`;
  const stopped = timeline.phases.find((phase) => phase.state === "gate");
  const caption = reason ? withoutHeadingMarker(reason) : "";
  if (status === "gate" && stopped) return <span className="text-red">{`stopped at phase ${stopped.number}${caption ? ` — ${caption}` : ""}`}</span>;
  const current = timeline.phases.find((phase) => phase.state === "now");
  const last = timeline.phases[timeline.phases.length - 1];
  return <span>{current && last ? `phase ${current.number} of ${last.number} · ${agents}` : agents}</span>;
}

// One segment of the track: its bar, name and model, and its time caption.
function PhaseSegment({ phase, time }: { phase: TimelinePhase; time: string }) {
  const label = phase.model ? `${phase.number} ${phase.name} · ${phase.model}` : `${phase.number} ${phase.name}`;
  return (
    <div className="flex min-w-[96px] flex-1 flex-col gap-1.5">
      <div className={`h-1 rounded-sm ${BAR_STYLE[phase.state]}`} />
      <div className={`truncate text-sm ${NAME_STYLE[phase.state]}`} title={label}>
        {label}
      </div>
      <div className={`text-xs whitespace-nowrap ${TIME_STYLE[phase.state]}`}>{time}</div>
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
        </div>
      ))}
    </div>
  );
}

// The pipeline card: one segment per phase of the tier's track, from the narrated lane events of every attempt.
export function PhaseTimeline({ timeline, status, reason, runElapsedMs }: PhaseTimelineProps) {
  const known = timeline !== null && timeline.track !== null;
  return (
    <section aria-label="phases" className="flex flex-col gap-2.5 rounded-lg border border-line bg-surface px-4 py-3.5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted">
        <CardTitle>{known ? `Pipeline · ${timeline.track} track` : "Pipeline"}</CardTitle>
        <span className="ml-auto">{timeline === null ? "" : known ? <Progress timeline={timeline} status={status} reason={reason} /> : "track unknown"}</span>
      </div>
      {timeline === null ? (
        <TrackSkeleton />
      ) : (
        known && (
          <div className="flex gap-1.5 overflow-x-auto pb-1">
            {timeline.phases.map((phase) => (
              <PhaseSegment key={phase.number} phase={phase} time={phaseTime(phase, runElapsedMs)} />
            ))}
          </div>
        )
      )}
    </section>
  );
}
