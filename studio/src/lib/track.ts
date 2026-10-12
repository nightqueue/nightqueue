import { elapsedClock, formatDurationMs } from "./format.ts";
import { phaseHex, phaseVar } from "./phase-colors.ts";
import type { AttemptRow, PhaseAttempt, TimelinePhase } from "./types";

export interface CaptionClocks {
  runElapsedMs: number | null;
  clockMs: number | null;
  tier?: string | null;
}

export interface TrackCounts {
  running: TimelinePhase[];
  skipped: number;
}

// The time a phase has spent so far: its summed duration, plus the part still open while it runs.
export function spentMs(phase: TimelinePhase, runElapsedMs: number | null): number | null {
  if (phase.state !== "now" || phase.liveSinceMs === null || runElapsedMs === null) return phase.durationMs;
  return (phase.durationMs ?? 0) + Math.max(0, runElapsedMs - phase.liveSinceMs);
}

// The caption of a skipped slot: the tier that routes around it, the agent that skipped it with its reason, or a bare `skipped`.
function skippedCaption(phase: TimelinePhase, tier: string | null): string {
  const record = phase.skipped;
  if (!record) return "skipped";
  if (record.by === "tier") return tier ? `skipped · ${tier} tier` : "skipped · tier";
  return record.reason ? `skipped · ${record.by}: ${record.reason}` : `skipped · ${record.by}`;
}

// The time caption of one phase: `start · duration` with its attempts past one, `start · gate at mm:ss` where the gate stopped it, `—` before it ran, why it was skipped.
export function phaseCaption(phase: TimelinePhase, { runElapsedMs, clockMs, tier = null }: CaptionClocks): string {
  if (phase.state === "skipped") return skippedCaption(phase, tier);
  if (phase.state === "pending") return "—";
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

export interface ShareEntry {
  number: number;
  name: string;
  color: string;
  hex: string;
  percent: string;
  share: number;
  running: boolean;
}

// The slots that run and the count of the skipped ones, so every counter of the track ignores the skipped slots.
export function trackCounts(phases: readonly TimelinePhase[]): TrackCounts {
  const list = Array.isArray(phases) ? phases : [];
  const running = list.filter((phase) => phase.state !== "skipped");
  return { running, skipped: list.length - running.length };
}

// A share of the total as a whole percent; `<1%` for any share above zero and below one percent.
export function sharePercent(share: number): string {
  if (!Number.isFinite(share) || share <= 0) return "0%";
  return share < 0.01 ? "<1%" : `${Math.round(share * 100)}%`;
}

// The phases that spent tokens, in bar order, each with its role colour, share of the total and percent label.
export function shareEntries(phases: readonly TimelinePhase[]): ShareEntry[] {
  const spent = phases.filter((phase) => Number.isFinite(phase.tokens) && phase.tokens > 0);
  const sum = spent.reduce((total, phase) => total + phase.tokens, 0);
  return spent.map((phase) => {
    const share = phase.tokens / sum;
    return { number: phase.number, name: phase.name, color: phaseVar(phase.agent), hex: phaseHex(phase.agent), percent: sharePercent(share), share, running: phase.state === "now" };
  });
}

// The legend of the share bar: the largest shares up to the limit, ties broken by phase order, listed in phase order.
export function legendEntries(entries: readonly ShareEntry[], limit: number): ShareEntry[] {
  const ranked = [...entries].sort((left, right) => right.share - left.share || left.number - right.number);
  return ranked.slice(0, Math.max(0, limit)).sort((left, right) => left.number - right.number);
}
