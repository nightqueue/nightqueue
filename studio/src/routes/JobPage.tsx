import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { CancelJobDialog } from "../components/CancelJobDialog";
import { CloseJobDialog } from "../components/CloseJobDialog";
import { RetryDialog } from "../components/RetryDialog";
import { AttemptsCard } from "../components/job/AttemptsCard";
import { FilesCard } from "../components/job/FilesCard";
import { GateCard } from "../components/job/GateCard";
import { Breadcrumb, type CloseState, type HeaderStatusActions, JobHeader } from "../components/job/JobHeader";
import { JobSkeleton } from "../components/job/JobSkeleton";
import { LiveLog } from "../components/job/LiveLog";
import { MemoryCard } from "../components/job/MemoryCard";
import { NoteCard } from "../components/job/NoteCard";
import { NoticeCard } from "../components/job/NoticeCard";
import { PhaseTimeline } from "../components/job/PhaseTimeline";
import { PrCard } from "../components/job/PrCard";
import { RunCard } from "../components/job/RunCard";
import { closeJob, closesWithoutConfirm, errorText, runJob } from "../lib/actions";
import { type JobStreamState, useJobStream } from "../lib/events";
import { isoMs } from "../lib/format";
import { useJobDetail, useQueueRowOf } from "../lib/job";
import { jobRef } from "../lib/queue";
import type { Job, JobDetail } from "../lib/types";
import { useAction } from "../lib/useAction";
import { useNow } from "../lib/useNow";

// What the screen says when the job cannot be read.
function JobUnavailable({ jobRefText, reason }: { jobRefText: string; reason: string }) {
  return (
    <section className="rounded-lg border border-line bg-surface px-4 py-6 text-muted">
      <p className="m-0">{`${jobRefText} cannot be read: ${reason}`}</p>
      <Link to="/">Back to the queue</Link>
    </section>
  );
}

// The phase track with the job's totals, ticking the running phase from the start of the current attempt.
function LiveTimeline({ job, row, stream, reason }: { job: JobDetail; row: Job | undefined; stream: JobStreamState; reason: string | null }) {
  const now = useNow();
  const started = isoMs(job.attempt_started_at ?? job.started_at);
  const runElapsedMs = job.status === "running" && started !== null ? now - started : null;
  return <PhaseTimeline job={job} row={row} baseline={stream.meta?.baseline} tier={stream.meta?.tier ?? job.tier} timeline={stream.timeline} reason={reason} runElapsedMs={runElapsedMs} />;
}

// The right column: notice (unless the gate card shows it), pull request, attempts, note, files, memory and run paths.
function SideCards({ job, stream }: { job: JobDetail; stream: JobStreamState }) {
  return (
    <div className="flex min-w-0 flex-col gap-4">
      {job.status !== "gate" && <NoticeCard job={job} />}
      <PrCard job={job} />
      <AttemptsCard job={job} />
      <NoteCard note={job.operator_note} />
      <FilesCard job={job} running={job.status === "running"} />
      <MemoryCard job={job} running={job.status === "running"} />
      <RunCard job={job} meta={stream.meta} />
    </div>
  );
}

const byJob = (job: JobDetail) => String(job.id);

// The header's close: one click on a merged pull request, a confirm before merging any other, the row's progress while closing.
function useCloseState(job: JobDetail, row: Job | undefined): { close: CloseState; confirming: boolean; endConfirm: () => void } {
  const [confirming, setConfirming] = useState(false);
  const closeMerged = useAction(closeJob, byJob);
  const onClose = () => (closesWithoutConfirm(job) ? closeMerged(job) : setConfirming(true));
  const close: CloseState = { closing: row?.studio.closing === true, closingText: row?.studio.reason ?? null, onClose };
  return { close, confirming, endConfirm: () => setConfirming(false) };
}

// The loaded job screen: header, track, the gate card when gated, then the log beside the cards.
function JobScreen({ job, row, runnersOnline }: { job: JobDetail; row: Job | undefined; runnersOnline: number | null }) {
  const [cancelling, setCancelling] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const { close, confirming, endConfirm } = useCloseState(job, row);
  const onRun = useAction(runJob, byJob);
  const actions: HeaderStatusActions = { close, onRun: () => onRun(job), onRetry: () => setRetrying(true), retryReady: row !== undefined && runnersOnline !== null };
  const stream = useJobStream(jobRef(job.id));
  const gatePhase = stream.timeline?.phases.find((phase) => phase.state === "gate")?.number ?? null;
  const reason = row?.studio.reason ?? null;
  return (
    <>
      <Breadcrumb jobRefText={jobRef(job.id)} />
      <JobHeader job={job} statusLabel={row?.studio.status_label || job.status} closeState={row?.studio.close_state ?? null} runTier={stream.meta?.tier ?? null} actions={actions} onCancel={() => setCancelling(true)} />
      <LiveTimeline job={job} row={row} stream={stream} reason={reason} />
      {job.status === "gate" && <GateCard job={job} runnersOnline={runnersOnline} gatePhase={gatePhase} />}
      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
        <LiveLog stream={stream} job={job} jobRef={jobRef(job.id)} />
        <SideCards job={job} stream={stream} />
      </div>
      {cancelling && <CancelJobDialog job={job} onClose={() => setCancelling(false)} />}
      {retrying && row && runnersOnline !== null && <RetryDialog job={row} runnersOnline={runnersOnline} onClose={() => setRetrying(false)} />}
      {confirming && <CloseJobDialog job={job} onClose={endConfirm} />}
    </>
  );
}

// The Job screen: one job's detail from `queue_status`, its live stream from `/events?job=`, refreshed as its queue row moves.
export function JobPage({ jobRef: ref }: { jobRef: string }) {
  const detail = useJobDetail(ref);
  const { row, runnersOnline } = useQueueRowOf(ref);
  if (detail.isPending) return <JobSkeleton />;
  if (detail.isError) return <JobUnavailable jobRefText={ref} reason={errorText(detail.error)} />;
  return <JobScreen key={detail.data.id} job={detail.data} row={row} runnersOnline={runnersOnline} />;
}
