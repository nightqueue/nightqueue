import type { Job, JobStatus } from "../lib/types";

const STATUS_STYLE: Record<JobStatus, { icon: string; color: string }> = {
  running: { icon: "●", color: "text-accent" },
  done: { icon: "✓", color: "text-green" },
  gate: { icon: "⚑", color: "text-amber" },
  failed: { icon: "✗", color: "text-red" },
  cancelled: { icon: "⊘", color: "text-dim" },
  pending: { icon: "○", color: "text-muted" },
  closed: { icon: "■", color: "text-closed" },
};

const CLOSING_STYLE = { icon: "◐", color: "text-closed" };

// The pulsing accent dot of a running job.
function LiveDot() {
  return <span className="inline-block size-[9px] animate-pulse-live rounded-full bg-accent shadow-[0_0_0_3px_#1b2a21]" aria-hidden="true" />;
}

// The style of a job: failed for a failed close, closing for a stalled one or a live close, the job status's otherwise.
function styleOf(job: Job) {
  const closeState = job.studio.close_state;
  if (closeState === "failed") return STATUS_STYLE.failed;
  if (closeState === "stalled" || closeState === "closing") return CLOSING_STYLE;
  return STATUS_STYLE[job.status] ?? STATUS_STYLE.pending;
}

// The STATUS cell: the CLI's icon and colour for the status, and the runtime's own status label.
export function StatusCell({ job }: { job: Job }) {
  const label = job.studio.status_label || job.status;
  const style = styleOf(job);
  return (
    <span className={`inline-flex max-w-full items-center gap-1.5 overflow-hidden text-ellipsis text-[13px] font-medium whitespace-nowrap ${style.color}`}>
      {job.status === "running" && !job.studio.closing ? <LiveDot /> : <span aria-hidden="true">{style.icon}</span>}
      {label}
    </span>
  );
}
