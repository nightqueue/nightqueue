import type { Job } from "../lib/types";
import { StatusIcon, statusVisual } from "./StatusIcon";

// The STATUS cell: the status icon and colour of the job, and the runtime's own status label.
export function StatusCell({ job }: { job: Job }) {
  const label = job.studio.status_label || job.status;
  const { color } = statusVisual(job.status, job.studio.close_state, job.studio.closing);
  return (
    <span className={`inline-flex max-w-full items-center gap-1.5 overflow-hidden text-ellipsis text-[13px] font-medium whitespace-nowrap ${color}`}>
      <StatusIcon status={job.status} closeState={job.studio.close_state} closing={job.studio.closing} />
      {label}
    </span>
  );
}
