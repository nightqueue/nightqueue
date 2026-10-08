import { elapsedClock, formatDurationMs } from "./format.ts";
import type { AttemptRow, PhaseAttempt, TimelinePhase } from "./types";

export interface CaptionClocks {
  runElapsedMs: number | null;
  clockMs: number | null;
}

// The time a phase has spent so far: its summed duration, plus the part still open while it runs.
export function spentMs(phase: TimelinePhase, runElapsedMs: number | null): number | null {
  if (phase.state !== "now" || phase.liveSinceMs === null || runElapsedMs === null) return phase.durationMs;
  return (phase.durationMs ?? 0) + Math.max(0, runElapsedMs - phase.liveSinceMs);
}

// The time caption of one phase: `start · duration` with its attempts past one, `start · gate at mm:ss` where the gate stopped it, `—` before it ran.
export function phaseCaption(phase: TimelinePhase, { runElapsedMs, clockMs }: CaptionClocks): string {
  if (phase.state === "pending" || phase.state === "skip") return "—";
  const start = elapsedClock(phase.startMs ?? null);
  if (phase.state === "gate") return `${start} · gate at ${elapsedClock(clockMs)}`;
  const caption = `${start} · ${formatDurationMs(spentMs(phase, runElapsedMs))}`;
  return phase.attempts > 1 ? `${caption} · ${phase.attempts} att.` : caption;
}

// The outcome an attempt ended at, shown only on the phase it stopped in and only when it did not end done.
function stoppedOutcome(entry: PhaseAttempt, rows: AttemptRow[]): string {
  if (!entry.last) return "";
  const row = rows.find((candidate) => candidate?.attempt === entry.attempt);
  if (!row?.finished_at || !row.outcome || row.outcome === "done") return "";
  return ` → ${row.outcome}`;
}

// The hover of one phase: the time it spent in each attempt, with the outcome of the attempts that stopped in it.
export function phaseAttemptsTitle(phase: TimelinePhase, attemptsLog: AttemptRow[] | null | undefined): string {
  const rows = Array.isArray(attemptsLog) ? attemptsLog : [];
  const entries = Array.isArray(phase.byAttempt) ? phase.byAttempt : [];
  return entries.map((entry) => `attempt ${entry.attempt}: ${formatDurationMs(entry.durationMs)}${stoppedOutcome(entry, rows)}`).join(" · ");
}
