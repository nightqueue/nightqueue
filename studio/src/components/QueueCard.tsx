import type { Job } from "../lib/types";
import { DurationCell, JobActions, JobRefLink, type RowContext, TitleLast, TokensCell } from "./JobCells";
import { PrBadge } from "./PrBadge";
import { StatusCell } from "./StatusCell";

// One job as a stacked block for narrow screens: ref, status and duration; the two TITLE/LAST lines; project, tokens, PR and actions.
function QueueCard({ job, context }: { job: Job; context: RowContext }) {
  const running = job.status === "running";
  return (
    <li className={`flex min-w-0 flex-col gap-2 border-b border-row-line px-3 py-3 ${running ? "border-y border-y-run-line bg-run-bg shadow-[inset_3px_0_0_var(--color-accent)]" : ""}`}>
      <div className="flex items-center gap-3">
        <JobRefLink job={job} />
        <StatusCell job={job} />
        <span className="ml-auto">
          <DurationCell job={job} />
        </span>
      </div>
      <TitleLast job={job} runnersOnline={context.runnersOnline} />
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted">
        <span className="min-w-0 truncate">{job.project}</span>
        <TokensCell job={job} />
        <PrBadge url={job.pr_url} state={job.pr_state} />
        <span className="ml-auto">
          <JobActions job={job} actions={context.actions} />
        </span>
      </div>
    </li>
  );
}

// The queue as stacked cards, for screens too narrow for the table.
export function QueueCards({ jobs, context }: { jobs: Job[]; context: RowContext }) {
  return (
    <ul className="m-0 list-none p-0">
      {jobs.map((job) => (
        <QueueCard key={job.id} job={job} context={context} />
      ))}
    </ul>
  );
}
