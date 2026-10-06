import { attemptsLabel, compactCount, formatDurationMs, hhmmssUtc, usdLabel } from "../../lib/format";
import type { AttemptRow, JobDetail } from "../../lib/types";
import { useNow } from "../../lib/useNow";
import { Card } from "./Card";

// The outcome of one attempt: `running` while open, its exit reason in parentheses when it has one.
function outcomeLabel(row: AttemptRow): string {
  if (row.finished_at === null) return "running";
  const outcome = row.outcome ?? "ended";
  return row.exit_reason ? `${outcome} (${row.exit_reason})` : outcome;
}

// The duration of one attempt, ticking from its start while it is open.
function AttemptDuration({ row }: { row: AttemptRow }) {
  const now = useNow();
  if (row.finished_at !== null) return <>{formatDurationMs(row.duration_s === null ? null : row.duration_s * 1000)}</>;
  const started = row.started_at ? Date.parse(row.started_at) : Number.NaN;
  return <span className="text-accent">{formatDurationMs(Number.isFinite(started) ? now - started : null)}</span>;
}

// A small mark beside an attempt: `fresh` after a --fresh retry, `backfilled` for history rebuilt by the v23 migration.
function AttemptBadge({ children }: { children: string }) {
  return <span className="rounded-full border border-line px-1.5 text-xs text-dim">{children}</span>;
}

// One attempt: ordinal, start, duration, outcome and spawns, then its tokens and cost and its marks.
function AttemptLine({ row }: { row: AttemptRow }) {
  return (
    <li className="flex flex-col gap-0.5 font-mono text-sm">
      <div className="flex flex-wrap items-center gap-x-2">
        <span>{`#${row.attempt}`}</span>
        <span className="text-muted">{`${hhmmssUtc(row.started_at)} UTC`}</span>
        <AttemptDuration row={row} />
        <span>{outcomeLabel(row)}</span>
        {row.spawns > 1 && <span className="text-muted">{`${row.spawns} spawns`}</span>}
      </div>
      <div className="flex flex-wrap items-center gap-x-2 text-xs text-muted">
        <span>{`in ${compactCount(row.tokens_in)} · out ${compactCount(row.tokens_out)} · ${usdLabel(row.cost_usd)}`}</span>
        {row.fresh && <AttemptBadge>fresh</AttemptBadge>}
        {row.backfilled && <AttemptBadge>backfilled</AttemptBadge>}
      </div>
    </li>
  );
}

// The attempts card: one line per claim of the job; nothing for a job that never ran.
export function AttemptsCard({ job }: { job: JobDetail }) {
  const rows = Array.isArray(job.attempts_log) ? job.attempts_log : [];
  if (rows.length === 0) return null;
  return (
    <Card label="attempts" title="Attempts" aside={attemptsLabel(rows.length)}>
      <ol className="m-0 flex list-none flex-col gap-2 p-0">
        {rows.map((row) => (
          <AttemptLine key={row.attempt} row={row} />
        ))}
      </ol>
    </Card>
  );
}
