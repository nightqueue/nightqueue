import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { CancelJobDialog } from "../components/CancelJobDialog";
import { CostCard } from "../components/job/CostCard";
import { FilesCard } from "../components/job/FilesCard";
import { GateCard } from "../components/job/GateCard";
import { Breadcrumb, JobHeader } from "../components/job/JobHeader";
import { JobSkeleton } from "../components/job/JobSkeleton";
import { LiveLog } from "../components/job/LiveLog";
import { NoteCard } from "../components/job/NoteCard";
import { NoticeCard } from "../components/job/NoticeCard";
import { PhaseTimeline } from "../components/job/PhaseTimeline";
import { PrCard } from "../components/job/PrCard";
import { RunCard } from "../components/job/RunCard";
import { errorText } from "../lib/actions";
import { type JobStreamState, useJobStream } from "../lib/events";
import { isoMs } from "../lib/format";
import { lastElapsed, useIssueSummary, useJobDetail, useQueueRowOf } from "../lib/job";
import { jobRef } from "../lib/queue";
import type { Job, JobDetail } from "../lib/types";
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

// The phase track, ticking the running phase from the job's start.
function LiveTimeline({ job, stream, reason }: { job: JobDetail; stream: JobStreamState; reason: string | null }) {
  const now = useNow();
  const started = isoMs(job.started_at);
  const runElapsedMs = job.status === "running" && started !== null ? now - started : null;
  return <PhaseTimeline timeline={stream.timeline} status={job.status} reason={reason} runElapsedMs={runElapsedMs} lastEventMs={lastElapsed(stream.events)} />;
}

// The right column: notice (unless the gate card shows it), pull request, cost, note, files and run paths.
function SideCards({ job, stream }: { job: JobDetail; stream: JobStreamState }) {
  return (
    <div className="flex min-w-0 flex-col gap-4">
      {job.status !== "gate" && <NoticeCard job={job} />}
      <PrCard job={job} />
      <CostCard job={job} baseline={stream.meta?.baseline} />
      <NoteCard note={job.operator_note} />
      <FilesCard files={stream.files} />
      <RunCard job={job} meta={stream.meta} />
    </div>
  );
}

// The loaded job screen: header, track, the gate card when gated, then the log beside the cards.
function JobScreen({ job, row, runnersOnline }: { job: JobDetail; row: Job | undefined; runnersOnline: number | null }) {
  const [cancelling, setCancelling] = useState(false);
  const stream = useJobStream(jobRef(job.id), job.started_at ?? "never-started");
  const issue = useIssueSummary(job.item_ref);
  const gatePhase = stream.timeline?.phases.find((phase) => phase.state === "gate")?.number ?? null;
  const reason = row?.studio.reason ?? null;
  return (
    <>
      <Breadcrumb jobRefText={jobRef(job.id)} />
      <JobHeader job={job} statusLabel={row?.studio.status_label || job.status} issue={issue.data} onCancel={() => setCancelling(true)} />
      <LiveTimeline job={job} stream={stream} reason={reason} />
      {job.status === "gate" && <GateCard job={job} runnersOnline={runnersOnline} gatePhase={gatePhase} />}
      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
        <LiveLog stream={stream} running={job.status === "running"} attempt={job.attempts} />
        <SideCards job={job} stream={stream} />
      </div>
      {cancelling && <CancelJobDialog job={job} onClose={() => setCancelling(false)} />}
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
