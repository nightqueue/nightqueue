import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { APPROVE_NOTE, errorText, retryJob, sessionCommand } from "../../lib/actions";
import { copyText } from "../../lib/clipboard";
import { hhmmUtc } from "../../lib/format";
import { jobKey, noticeOf } from "../../lib/job";
import { jobRef } from "../../lib/queue";
import { showToast } from "../../lib/toast";
import type { JobDetail } from "../../lib/types";
import { Button, FIELD_CLASS } from "../ui";
import { CardTitle } from "./Card";
import { Markdown } from "./Markdown";

interface GateCardProps {
  job: JobDetail;
  runnersOnline: number | null;
  gatePhase: number | null;
}

// The retry of a gated job as a mutation: the detail is re-read once it is sent back, a failure is an error toast.
function useGateRetry(job: JobDetail, runnersOnline: number | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (note: string) => retryJob({ job, note, runnersOnline: runnersOnline ?? 0 }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: jobKey(jobRef(job.id)) }),
    onError: (err: unknown) => showToast(errorText(err), "error"),
  });
}

// The left half: the gate's notice rendered as safe markdown.
function GateNotice({ job }: { job: JobDetail }) {
  const notice = noticeOf(job);
  return (
    <div className="flex min-w-0 flex-col gap-2.5 border-b border-line px-5 py-4 lg:border-r lg:border-b-0">
      <div className="flex flex-wrap items-center gap-2.5">
        <span className="text-lg text-red" aria-hidden="true">
          ⚠
        </span>
        <CardTitle className="text-red">{job.blocked_code ? "Blocked before the run" : "Requires user confirmation"}</CardTitle>
        <span className="text-sm text-muted">{`notice_md · written ${hhmmUtc(job.finished_at)} UTC`}</span>
      </div>
      {notice ? <Markdown source={notice} className="max-h-[420px] overflow-auto pr-2" /> : <p className="m-0 text-[13px] text-muted">The gate left no notice — read the raw log.</p>}
    </div>
  );
}

// The `Resume in terminal` button: copies the session command it shows.
function ResumeInTerminal({ job }: { job: JobDetail }) {
  const command = sessionCommand(job);
  return (
    <Button variant="ghost" className="self-start" onClick={() => void copyText(command, "the session command")}>
      Resume in terminal <span className="ml-1.5 hidden font-mono text-xs text-dim sm:inline">{command}</span>
    </Button>
  );
}

// The right half: the answer box and its buttons; a preflight block retries with no note.
function GateAnswer({ job, runnersOnline, gatePhase }: GateCardProps) {
  const [note, setNote] = useState("");
  const retry = useGateRetry(job, runnersOnline);
  const waiting = retry.isPending || runnersOnline === null;
  const blocked = Boolean(job.blocked_code);
  const resumes = gatePhase === null ? "the run resumes with the plan it kept" : `the run resumes from phase ${gatePhase} with the plan it kept`;
  return (
    <div className="flex min-w-0 flex-col gap-2.5 px-5 py-4">
      <CardTitle>Answer and retry</CardTitle>
      {blocked ? (
        <p className="m-0 text-sm text-muted">{`A preflight block (${job.blocked_code}): fix its cause, then retry with no note.`}</p>
      ) : (
        <>
          <label htmlFor="gate-answer" className="text-sm text-muted">{`Your answer goes to the retry as the operator's note; ${resumes}.`}</label>
          <textarea id="gate-answer" rows={9} className={`${FIELD_CLASS} w-full resize-y px-2.5 py-2 text-[13px]`} value={note} onChange={(event) => setNote(event.target.value)} />
        </>
      )}
      <div className="flex flex-wrap gap-2">
        {blocked ? (
          <Button variant="primary" disabled={waiting} onClick={() => retry.mutate("")}>
            {retry.isPending ? "Retrying…" : "Retry"}
          </Button>
        ) : (
          <>
            <Button variant="primary" disabled={waiting || note.trim() === ""} onClick={() => retry.mutate(note)}>
              {retry.isPending ? "Retrying…" : "Retry with this answer"}
            </Button>
            <Button disabled={waiting} onClick={() => retry.mutate(APPROVE_NOTE)}>
              Approve as recommended
            </Button>
          </>
        )}
      </div>
      <ResumeInTerminal job={job} />
      <p className="m-0 mt-auto text-xs text-dim">queue_retry {"{ job_id, note }"} · a preflight block (blocked_code) retries with no note after the cause is fixed</p>
    </div>
  );
}

// The gate card above the columns: the notice on the left, the answer box on the right.
export function GateCard(props: GateCardProps) {
  return (
    <section aria-label="gate" className="grid overflow-hidden rounded-lg border border-gate-line bg-surface lg:grid-cols-[minmax(0,1fr)_420px]">
      <GateNotice job={props.job} />
      <GateAnswer {...props} />
    </section>
  );
}
