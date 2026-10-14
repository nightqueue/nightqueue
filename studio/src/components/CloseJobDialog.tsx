import { closeJob } from "../lib/actions";
import { jobRef } from "../lib/queue";
import type { Job } from "../lib/types";
import { ConfirmDialog } from "./ConfirmDialog";

// The confirm before `queue_close`: the close pipeline merges a pull request not merged yet, or closes a job resolved without change with nothing merged.
export function CloseJobDialog({ job, onClose }: { job: Pick<Job, "id" | "resolution">; onClose: () => void }) {
  const ref = jobRef(job.id);
  const noChange = job.resolution === "no-change";
  return (
    <ConfirmDialog title={`Close ${ref}`} confirmLabel={noChange ? "Close without change" : "Close and merge"} onConfirm={() => closeJob(job)} onClose={onClose}>
      {noChange
        ? `Nothing is merged: ${ref} closes as resolved without a code change, and its origins and log destination are told so with the run's conclusion. It runs detached; the row follows it.`
        : `The close pipeline merges the pull request of ${ref} and closes the job. It runs detached; the row follows it.`}
    </ConfirmDialog>
  );
}
