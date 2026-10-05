import { Link } from "@tanstack/react-router";
import { canCancel, hasLog, hasSession, rawLogUrl, sessionCommand } from "../../lib/actions";
import { copyText } from "../../lib/clipboard";
import { durationLabel, hhmmssUtc, hhmmUtc, isoMs, timeoutLabel } from "../../lib/format";
import { jobRef, jobTitle } from "../../lib/queue";
import { sessionBlockReason } from "../../lib/terminals";
import type { IssueSummary, JobDetail, JobStatus } from "../../lib/types";
import { useNow } from "../../lib/useNow";
import { NO_PR_TOOLTIP } from "../JobCells";
import { TerminalLaunchButton } from "../TerminalLaunchButton";
import { Button } from "../ui";

const PILL_STYLE: Record<JobStatus, string> = {
  running: "bg-[#1b2a21] text-accent",
  gate: "bg-[#4a1b1b] text-red",
  failed: "bg-[#4a1b1b] text-red",
  done: "bg-[#16261d] text-green",
  closed: "bg-[#231c36] text-closed",
  cancelled: "bg-row-line text-dim",
  pending: "bg-row-line text-muted",
};

interface JobHeaderProps {
  job: JobDetail;
  statusLabel: string;
  issue: IssueSummary | undefined;
  runTier: string | null;
  actions: HeaderStatusActions;
  onCancel: () => void;
}

export interface HeaderStatusActions {
  close: CloseState;
  onRun: () => void;
  onRetry: () => void;
  retryReady: boolean;
}

export interface CloseState {
  closing: boolean;
  closingText: string | null;
  onClose: () => void;
}

// The breadcrumb above the header: back to the queue, then the job's ref.
export function Breadcrumb({ jobRefText }: { jobRefText: string }) {
  return (
    <nav aria-label="breadcrumb" className="text-sm text-muted">
      <Link to="/">Queue</Link> / <span className="font-mono">{jobRefText}</span>
    </nav>
  );
}

// The status pill of the header, coloured by status.
function StatusPill({ status, label }: { status: JobStatus; label: string }) {
  return <span className={`inline-block rounded-full px-2 py-0.5 text-sm leading-[18px] font-medium ${PILL_STYLE[status] ?? PILL_STYLE.pending}`}>{label}</span>;
}

// A static caption chip of the header (tier, priority, attempt).
function HeaderChip({ children }: { children: string }) {
  return <span className="inline-flex min-h-7 items-center rounded-full border border-line px-2.5 text-sm text-muted">{children}</span>;
}

// The second line: project, the issue it came from, its decision and the branch.
function OriginLine({ job, issue }: { job: JobDetail; issue: IssueSummary | undefined }) {
  const item = job.item_ref ? [job.item_ref, issue?.title].filter(Boolean).join(" ") : null;
  const parts = [job.project, item, issue?.decision_ref ?? null, job.branch ? `branch ${job.branch}` : null].filter((part): part is string => Boolean(part));
  return <div className="font-mono text-sm break-words text-muted">{parts.join(" · ")}</div>;
}

// The third line while the job runs: start, ticking elapsed of the timeout, lease, worker and session.
function RunningLine({ job }: { job: JobDetail }) {
  const now = useNow();
  const parts = [
    job.lease_until ? `lease until ${hhmmUtc(job.lease_until)}` : null,
    job.worker ? `worker ${job.worker}` : null,
    job.session_id ? `session ${job.session_id.slice(0, 8)}…` : null,
  ].filter(Boolean);
  return (
    <>
      started {hhmmssUtc(job.started_at)} UTC · elapsed <span className="text-accent">{durationLabel(job.started_at, null, now)}</span> of {timeoutLabel(job.timeout_s)}
      {parts.map((part) => ` · ${part}`).join("")}
    </>
  );
}

// The third line once the job stopped: where and when it stopped, and after how long.
function StoppedLine({ job }: { job: JobDetail }) {
  const after = durationLabel(job.started_at, job.finished_at, isoMs(job.finished_at) ?? Date.now());
  const where = job.status === "gate" ? "stopped at the gate" : job.status === "failed" ? "failed" : "finished";
  const session = job.session_id ? ` · session ${job.session_id.slice(0, 8)}…` : "";
  return <>{`started ${hhmmssUtc(job.started_at)} UTC · ${where} ${hhmmssUtc(job.finished_at)} after ${after}${session}`}</>;
}

// The third line of the header, by whether the job ran, runs or waits.
function TimingLine({ job }: { job: JobDetail }) {
  if (job.status === "running") return <RunningLine job={job} />;
  if (!job.started_at) return <>{`queued ${hhmmssUtc(job.created_at)} UTC · waits for a runner`}</>;
  return <StoppedLine job={job} />;
}

// The close slot of a done job: the primary Close job, or the close pipeline's progress while it runs.
function CloseAction({ job, close }: { job: JobDetail; close: CloseState }) {
  if (job.status !== "done") return null;
  if (close.closing) return <span className="inline-flex min-h-9 items-center text-sm text-muted">{close.closingText ?? "closing…"}</span>;
  const noPr = !job.pr_url;
  return (
    <span title={noPr ? NO_PR_TOOLTIP : undefined}>
      <Button variant="primary" disabled={noPr} onClick={close.onClose}>
        Close job
      </Button>
    </span>
  );
}

// The one status action beside Cancel job: Run when pending, Retry when stopped, Close job when done, none while running.
function StatusAction({ job, actions }: { job: JobDetail; actions: HeaderStatusActions }) {
  if (job.status === "pending") {
    return (
      <Button variant="primary" onClick={actions.onRun}>
        Run
      </Button>
    );
  }
  if (job.status === "gate" || job.status === "failed" || job.status === "cancelled") {
    return (
      <Button variant="primary" disabled={!actions.retryReady} onClick={actions.onRetry}>
        Retry
      </Button>
    );
  }
  return <CloseAction job={job} close={actions.close} />;
}

// Resumes the job's session in a studio terminal, disabled with its reason while the status does not allow it.
function ResumeInTerminal({ job }: { job: JobDetail }) {
  return (
    <TerminalLaunchButton variant="run" request={{ kind: "session", job: jobRef(job.id) }} blockedReason={sessionBlockReason(job.status)} title="Resume this job's claude session in a studio terminal">
      Resume in terminal
    </TerminalLaunchButton>
  );
}

// The header actions: raw log, resume in a terminal, copy the session command, close, cancel.
function HeaderActions({ job, actions, onCancel }: { job: JobDetail; actions: HeaderStatusActions; onCancel: () => void }) {
  return (
    <div className="flex shrink-0 flex-wrap gap-2 md:ml-auto">
      {hasLog(job) ? (
        <a href={rawLogUrl(job)} target="_blank" rel="noreferrer" className="inline-flex min-h-9 items-center rounded-md px-3 font-medium text-muted hover:bg-button hover:text-fg">
          Raw log
        </a>
      ) : (
        <Button variant="ghost" disabled>
          Raw log
        </Button>
      )}
      <ResumeInTerminal job={job} />
      <Button disabled={!hasSession(job)} onClick={() => void copyText(sessionCommand(job), "the session command")}>
        Copy session cmd
      </Button>
      <StatusAction job={job} actions={actions} />
      <Button variant="danger" disabled={!canCancel(job)} onClick={onCancel}>
        Cancel job
      </Button>
    </div>
  );
}

// The job header: ref, title, status and chips; origin line; timing line; actions.
export function JobHeader({ job, statusLabel, issue, runTier, actions, onCancel }: JobHeaderProps) {
  const tier = job.tier ?? runTier;
  return (
    <section aria-label="job header" className="flex flex-col gap-4 md:flex-row md:items-start">
      <div className="flex min-w-0 flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-2.5">
          <span className="font-mono text-xl font-medium">{jobRef(job.id)}</span>
          <span className="min-w-0 text-xl font-semibold break-words">{jobTitle(job)}</span>
          <StatusPill status={job.status} label={statusLabel} />
          {tier && <HeaderChip>{tier}</HeaderChip>}
          <HeaderChip>{`p${job.priority}`}</HeaderChip>
          <HeaderChip>{`attempt ${job.attempts} / ${job.max_attempts}`}</HeaderChip>
        </div>
        <OriginLine job={job} issue={issue} />
        <div className="text-sm break-words text-muted">
          <TimingLine job={job} />
        </div>
      </div>
      <HeaderActions job={job} actions={actions} onCancel={onCancel} />
    </section>
  );
}
