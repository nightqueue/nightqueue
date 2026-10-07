import { Link } from "@tanstack/react-router";
import { GitMerge, Play } from "lucide-react";
import { activeMs, formatDurationMs, hhmmUtc } from "../lib/format";
import { jobRef, jobTitle } from "../lib/queue";
import type { Job } from "../lib/types";
import { useNow } from "../lib/useNow";
import { ActionIcon } from "./StatusIcon";
import { Button } from "./ui";

export interface RowActions {
  onRun?: (job: Job) => void;
  onClose?: (job: Job) => void;
  onMenu?: (job: Job, anchor: HTMLElement) => void;
}

export interface RowContext {
  runnersOnline: number;
  actions: RowActions;
}

// The ID cell: the job's ref in mono, linking to its job screen.
export function JobRefLink({ job }: { job: Job }) {
  const ref = jobRef(job.id);
  return (
    <Link to="/jobs/$ref" params={{ ref }} className="font-mono whitespace-nowrap">
      {ref}
    </Link>
  );
}

// A running job's active time, ticking every second in the accent colour.
function TickingDuration({ job }: { job: Job }) {
  const now = useNow(1000);
  return <span className="font-mono text-accent">{formatDurationMs(activeMs(job, now))}</span>;
}

// The DURATION cell: the active time of every attempt, ticking while running, a dim `-` before the first attempt.
export function DurationCell({ job }: { job: Job }) {
  if (job.status === "running") return <TickingDuration job={job} />;
  const label = formatDurationMs(activeMs(job, Date.now()));
  return <span className={`font-mono ${label === "-" ? "text-dim" : ""}`}>{label}</span>;
}

// Picks the TOKENS colour: dim without a label, accent while the job runs, plain otherwise.
function tokensTone(job: Job, label: string): string {
  if (label === "-") return "text-dim";
  return job.status === "running" ? "text-accent" : "";
}

// The TOKENS cell: the runtime's token label in mono, live-coloured while running, dim when there is none yet.
export function TokensCell({ job }: { job: Job }) {
  const label = job.studio.tokens_label || "-";
  return <span className={`font-mono ${tokensTone(job, label)}`}>{label}</span>;
}

// The narrated last action of a running job, the tool call after the last ` — ` dimmed.
function LastAction({ text }: { text: string }) {
  const cut = text.lastIndexOf(" — ");
  if (cut < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, cut)} — <span className="text-dim">{text.slice(cut + 3)}</span>
    </>
  );
}

// The two TITLE/LAST lines of a running job: phase counter, glyph, agent and intent, then the last action.
function RunningLines({ job }: { job: Job }) {
  const live = job.live;
  if (!live) return <TwoLines first={jobTitle(job)} second="starting — no narration yet" />;
  const counter = live.phase !== null && live.phases !== null ? `${live.phase}/${live.phases}` : null;
  return (
    <div className="min-w-0">
      <div className="flex min-w-0 items-center gap-2 whitespace-nowrap">
        {counter && <span className="shrink-0 font-mono text-accent">{counter}</span>}
        <span className="min-w-0 truncate">
          {job.studio.glyph} <span className="text-accent">{live.agent ?? "orchestrator"}</span>
          {live.intent ? ` — ${live.intent}` : ""}
        </span>
      </div>
      <div className="mt-1 truncate font-mono text-sm text-muted">{live.last?.text ? <LastAction text={live.last.text} /> : "-"}</div>
    </div>
  );
}

// Why a pending job has not started yet: its own blocked reason, else what the runners are doing.
function pendingTail(job: Job, runnersOnline: number): string {
  if (job.studio.reason) return job.studio.reason;
  if (runnersOnline === 0) return "waits for a runner — ▶ Run starts a once runner for this job";
  return `${runnersOnline} runner${runnersOnline === 1 ? "" : "s"} busy — picked up when one frees`;
}

// The second line of a pending job: item, priority, tier, queue time and why it waits.
function pendingDetail(job: Job, runnersOnline: number): string {
  const parts = [job.studio.item_ref, `p${job.priority}`, job.tier, `queued ${hhmmUtc(job.created_at)} UTC`, pendingTail(job, runnersOnline)];
  return parts.filter(Boolean).join(" · ");
}

// A title line and an optional muted second line, each cut with an ellipsis.
function TwoLines({ first, second }: { first: string; second: string | null }) {
  return (
    <div className="min-w-0">
      <div className="truncate">{first}</div>
      {second && <div className="mt-0.5 truncate text-sm text-muted">{second}</div>}
    </div>
  );
}

// The TITLE/LAST cell by status: live lines while running, why it waits when pending, the CLI's last reason otherwise.
export function TitleLast({ job, runnersOnline }: { job: Job; runnersOnline: number }) {
  if (job.status === "running") return <RunningLines job={job} />;
  if (job.status === "pending") return <TwoLines first={jobTitle(job)} second={pendingDetail(job, runnersOnline)} />;
  return <TwoLines first={jobTitle(job)} second={job.studio.reason} />;
}

export const NO_PR_TOOLTIP ="no pull request — nothing to close";

// Tells whether a job shows the inline Close: done, and no close already running.
function closable(job: Job): boolean {
  return job.status === "done" && !job.studio.closing;
}

// The inline Close of a done row, disabled with a tooltip when the job has no pull request.
function InlineClose({ job, onClose }: { job: Job; onClose?: (job: Job) => void }) {
  const noPr = !job.pr_url;
  return (
    <span title={noPr ? NO_PR_TOOLTIP : undefined}>
      <Button size="sm" aria-label={`close ${jobRef(job.id)}`} disabled={noPr || !onClose} onClick={() => onClose?.(job)}>
        <ActionIcon icon={GitMerge} />
        Close
      </Button>
    </span>
  );
}

// The actions cell: inline Run on pending rows, inline Close on done rows, and the ⋯ menu.
export function JobActions({ job, actions }: { job: Job; actions: RowActions }) {
  const ref = jobRef(job.id);
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap">
      {job.status === "pending" && (
        <Button variant="run" size="sm" aria-label={`start a runner for ${ref}`} disabled={!actions.onRun} onClick={() => actions.onRun?.(job)}>
          <ActionIcon icon={Play} />
          Run
        </Button>
      )}
      {closable(job) && <InlineClose job={job} onClose={actions.onClose} />}
      <Button variant="ghost" size="sm" aria-label={`actions for ${ref}`} disabled={!actions.onMenu} onClick={(event) => actions.onMenu?.(job, event.currentTarget)}>
        ⋯
      </Button>
    </span>
  );
}
