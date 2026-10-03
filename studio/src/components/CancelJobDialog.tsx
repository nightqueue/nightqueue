import { cancelJob } from "../lib/actions";
import { jobRef } from "../lib/queue";
import type { Job } from "../lib/types";
import { ConfirmDialog } from "./ConfirmDialog";

// The confirm before `queue_cancel`: a running job also stops its runner.
export function CancelJobDialog({ job, onClose }: { job: Pick<Job, "id" | "status">; onClose: () => void }) {
  const ref = jobRef(job.id);
  const running = job.status === "running";
  return (
    <ConfirmDialog title={`Cancel ${ref}`} confirmLabel={running ? "Cancel and stop runner" : "Cancel job"} onConfirm={() => cancelJob(job)} onClose={onClose}>
      {running ? `${ref} is running: its runner is stopped and the job is cancelled in one step.` : `${ref} is cancelled; a done or failed job also releases its worktree.`}
    </ConfirmDialog>
  );
}
