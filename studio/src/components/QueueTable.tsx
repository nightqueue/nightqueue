import type { ReactNode } from "react";
import type { Job } from "../lib/types";
import { DurationCell, JobActions, JobRefLink, type RowContext, TitleLast, TokensCell } from "./JobCells";
import { PrBadge } from "./PrBadge";
import { StatusCell } from "./StatusCell";

const COLUMNS: { label: string; width?: string; right?: boolean }[] = [
  { label: "ID", width: "w-[72px]" },
  { label: "STATUS", width: "w-[118px]" },
  { label: "DURATION", width: "w-[88px]" },
  { label: "TOKENS", width: "w-[96px]", right: true },
  { label: "PROJECT", width: "w-[170px]" },
  { label: "TITLE/LAST" },
  { label: "PR", width: "w-[120px]" },
  { label: "", width: "w-[130px]" },
];

const RUN_CELL = "bg-run-bg border-y border-y-run-line";

// One table cell, vertically centred, with the running-row emphasis when asked.
function Cell({ running, className = "", children }: { running: boolean; className?: string; children: ReactNode }) {
  return <td className={`border-b border-row-line px-3 py-2.5 align-middle ${running ? RUN_CELL : ""} ${className}`}>{children}</td>;
}

// One row of the queue table, in the CLI's column order.
function QueueRow({ job, context }: { job: Job; context: RowContext }) {
  const running = job.status === "running";
  return (
    <tr>
      <Cell running={running} className={running ? "shadow-[inset_3px_0_0_var(--color-accent)]" : ""}>
        <JobRefLink job={job} />
      </Cell>
      <Cell running={running}>
        <StatusCell job={job} />
      </Cell>
      <Cell running={running}>
        <DurationCell job={job} />
      </Cell>
      <Cell running={running} className="text-right">
        <TokensCell job={job} />
      </Cell>
      <Cell running={running} className="truncate">
        {job.project}
      </Cell>
      <Cell running={running}>
        <TitleLast job={job} runnersOnline={context.runnersOnline} />
      </Cell>
      <Cell running={running}>
        <PrBadge url={job.pr_url} state={job.pr_state} />
      </Cell>
      <Cell running={running}>
        <JobActions job={job} actions={context.actions} />
      </Cell>
    </tr>
  );
}

// The queue table for wide screens: the CLI's columns, one row per job.
export function QueueTable({ jobs, context }: { jobs: Job[]; context: RowContext }) {
  return (
    <table className="w-full table-fixed border-collapse">
      <thead>
        <tr>
          {COLUMNS.map((column, index) => (
            <th key={index} className={`border-b border-line px-3 py-2 text-sm font-medium text-muted ${column.width ?? ""} ${column.right ? "text-right" : "text-left"}`}>
              {column.label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {jobs.map((job) => (
          <QueueRow key={job.id} job={job} context={context} />
        ))}
      </tbody>
    </table>
  );
}
