import { closeJob } from "../lib/actions";
import { jobRef } from "../lib/queue";
import type { Job } from "../lib/types";
import { ConfirmDialog } from "./ConfirmDialog";

// The confirm before `queue_close` on a pull request not merged yet: the close pipeline merges it.
export function CloseJobDialog({ job, onClose }: { job: Pick<Job, "id">; onClose: () => void }) {
  const ref = jobRef(job.id);
  return (
    <ConfirmDialog title={`Close ${ref}`} confirmLabel="Close and merge" onConfirm={() => closeJob(job)} onClose={onClose}>
      The close pipeline merges the pull request of {ref} and closes the job. It runs detached; the row follows it.
    </ConfirmDialog>
  );
}
