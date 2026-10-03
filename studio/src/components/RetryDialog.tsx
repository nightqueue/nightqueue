import { useState } from "react";
import { retryJob, retryNeedsNote } from "../lib/actions";
import { jobRef } from "../lib/queue";
import type { Job } from "../lib/types";
import { useSubmit } from "../lib/useSubmit";
import { Modal } from "./Modal";
import { Button, FIELD_CLASS } from "./ui";

interface RetryDialogProps {
  job: Job;
  runnersOnline: number;
  onClose: () => void;
}

// What the retry dialog says about the note, by the job's state.
function noteHint(job: Job): string {
  if (retryNeedsNote(job)) return "Required: the note reaches the run as the answer to its gate.";
  if (job.blocked_code) return "A preflight block retries with no note once its cause is fixed.";
  return "Optional: the note reaches the run's next prompt.";
}

// The `queue_retry` dialog: a note (required for a gate the preflight did not block), then the retry.
export function RetryDialog({ job, runnersOnline, onClose }: RetryDialogProps) {
  const [note, setNote] = useState("");
  const submit = useSubmit(() => retryJob({ job, note, runnersOnline }), onClose);
  const missingNote = retryNeedsNote(job) && note.trim() === "";
  return (
    <Modal
      title={`Retry ${jobRef(job.id)}`}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={missingNote || submit.isPending} onClick={() => submit.mutate(undefined)}>
            {submit.isPending ? "Retrying…" : "Retry"}
          </Button>
        </>
      }
    >
      <label htmlFor="retry-note" className="text-sm text-muted">
        Note <span className="text-dim">— {noteHint(job)}</span>
      </label>
      <textarea id="retry-note" rows={4} className={`${FIELD_CLASS} w-full resize-y px-2.5 py-2`} value={note} onChange={(event) => setNote(event.target.value)} />
      <p className="m-0 text-sm text-dim">
        {runnersOnline === 0 ? "0 runners online — the retry starts a once runner for this job." : "A live runner claims the job once it is pending."}
      </p>
    </Modal>
  );
}
