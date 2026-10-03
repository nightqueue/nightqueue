import { Link } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import { errorText } from "../lib/actions";
import { useProjects } from "../lib/api";
import { filterIssues, ISSUE_STATUS_ORDER, issueCounts, issueRowAction, type IssueStatusFilter, shownJobRef, shownStatus, useProjectIssues } from "../lib/issues";
import { ALL_PROJECTS } from "../lib/queue";
import type { IssueItem } from "../lib/types";
import { Button, Chip } from "./ui";

interface IssuesSectionProps {
  projectId: string;
  onQueue: (issue: { ref: string; project: string }) => void;
}

type QueueIssue = (ref: string) => void;

const COLUMNS: { label: string; width?: string }[] = [
  { label: "REF", width: "w-[96px]" },
  { label: "TITLE" },
  { label: "TYPE", width: "w-[110px]" },
  { label: "PRIO", width: "w-[64px]" },
  { label: "STATUS", width: "w-[110px]" },
  { label: "JOB", width: "w-[130px]" },
];

const SKELETON_ROWS = [0, 1, 2];

// The frame of the issues section: a heading line over its body.
function SectionFrame({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section aria-label="issues" className="overflow-hidden rounded-lg border border-line bg-surface">
      <h2 className="m-0 border-b border-line px-3 py-2.5 text-sm font-medium text-muted">{title}</h2>
      {children}
    </section>
  );
}

// A one-line message inside the section: empty, idle or failed.
function SectionNote({ children, tone = "text-muted" }: { children: ReactNode; tone?: string }) {
  return <p className={`m-0 px-3 py-6 text-center ${tone}`}>{children}</p>;
}

// The loading state: the pills line and three rows shaped like the final ones.
function IssuesSkeleton() {
  return (
    <div className="flex flex-col gap-3 p-3" aria-label="loading issues">
      <div className="h-7 w-2/3 animate-pulse rounded-md bg-row-line" />
      {SKELETON_ROWS.map((row) => (
        <div key={row} className="flex items-center gap-3">
          <div className="h-4 w-16 animate-pulse rounded bg-row-line" />
          <div className="h-4 grow animate-pulse rounded bg-row-line" />
          <div className="h-4 w-20 animate-pulse rounded bg-row-line" />
        </div>
      ))}
    </div>
  );
}

// The status pills: `All N` then one pill per issue status with its count.
function IssuePills({ items, filter, onFilter }: { items: IssueItem[]; filter: IssueStatusFilter; onFilter: (next: IssueStatusFilter) => void }) {
  const counts = issueCounts(items);
  return (
    <div className="flex flex-wrap items-center gap-2 px-3 py-2.5">
      <Chip on={filter === "all"} onClick={() => onFilter("all")}>
        All {items.length}
      </Chip>
      {ISSUE_STATUS_ORDER.map((status) => (
        <Chip key={status} on={filter === status} onClick={() => onFilter(status)}>
          {status} {counts[status]}
        </Chip>
      ))}
    </div>
  );
}

// The action of a row: `Queue as job` for an item not started, else its linked job (or `—`).
function IssueAction({ item, onQueue }: { item: IssueItem; onQueue: QueueIssue }) {
  if (issueRowAction(item) === "queue") {
    return (
      <Button size="sm" onClick={() => onQueue(item.ref)}>
        Queue as job
      </Button>
    );
  }
  const ref = shownJobRef(item);
  if (!ref) return <span className="text-dim">—</span>;
  return (
    <Link to="/jobs/$ref" params={{ ref }} className="font-mono whitespace-nowrap">
      {ref}
    </Link>
  );
}

// The type and priority of an item, as one dim label.
function typeLabel(item: IssueItem): string {
  return [item.type, item.priority === null ? null : `p${item.priority}`].filter(Boolean).join(" · ");
}

// One table cell of the issues table.
function Cell({ className = "", children }: { className?: string; children: ReactNode }) {
  return <td className={`border-b border-row-line px-3 py-2.5 align-middle ${className}`}>{children}</td>;
}

// The issues table for wide screens: ref, title, type, priority, status and the linked job.
function IssuesTable({ items, onQueue }: { items: IssueItem[]; onQueue: QueueIssue }) {
  return (
    <div className="max-h-[480px] overflow-y-auto">
      <table className="w-full table-fixed border-collapse">
        <thead>
          <tr>
            {COLUMNS.map((column) => (
              <th key={column.label} className={`sticky top-0 z-10 border-b border-line bg-surface px-3 py-2 text-left text-sm font-medium text-muted ${column.width ?? ""}`}>
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr key={item.ref}>
              <Cell className="font-mono">{item.ref}</Cell>
              <Cell className="truncate">{item.title}</Cell>
              <Cell>{item.type ?? "-"}</Cell>
              <Cell className="font-mono">{item.priority === null ? "-" : `p${item.priority}`}</Cell>
              <Cell>{shownStatus(item)}</Cell>
              <Cell>
                <IssueAction item={item} onQueue={onQueue} />
              </Cell>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// The issues as stacked cards for narrow screens: ref and status, title, then type and the action.
function IssueCards({ items, onQueue }: { items: IssueItem[]; onQueue: QueueIssue }) {
  return (
    <ul className="m-0 flex list-none flex-col p-0">
      {items.map((item) => (
        <li key={item.ref} className="flex flex-col gap-1.5 border-b border-row-line px-3 py-2.5">
          <div className="flex items-center gap-2">
            <span className="font-mono">{item.ref}</span>
            <span className="ml-auto text-sm text-muted">{shownStatus(item)}</span>
          </div>
          <div className="min-w-0 break-words">{item.title}</div>
          <div className="flex flex-wrap items-center gap-2 text-sm text-dim">
            <span>{typeLabel(item)}</span>
            <span className="ml-auto">
              <IssueAction item={item} onQueue={onQueue} />
            </span>
          </div>
        </li>
      ))}
    </ul>
  );
}

// The pills over the issues, as a table on wide screens and cards on narrow ones.
function IssuesList({ items, onQueue }: { items: IssueItem[]; onQueue: QueueIssue }) {
  const [filter, setFilter] = useState<IssueStatusFilter>("all");
  const shown = filterIssues(items, filter);
  return (
    <>
      <IssuePills items={items} filter={filter} onFilter={setFilter} />
      {shown.length === 0 ? (
        <SectionNote>{items.length === 0 ? "This project has no issue." : "No issue has this status."}</SectionNote>
      ) : (
        <>
          <div className="hidden lg:block">
            <IssuesTable items={shown} onQueue={onQueue} />
          </div>
          <div className="lg:hidden">
            <IssueCards items={shown} onQueue={onQueue} />
          </div>
        </>
      )}
    </>
  );
}

// The issues of one named project, with their loading and failed states.
function ProjectIssues({ project, onQueue }: { project: string; onQueue: IssuesSectionProps["onQueue"] }) {
  const issues = useProjectIssues(project);
  if (issues.isPending) return <IssuesSkeleton />;
  if (issues.isError) return <SectionNote tone="text-red">The issues cannot be read: {errorText(issues.error)}</SectionNote>;
  return <IssuesList key={project} items={issues.data} onQueue={(ref) => onQueue({ ref, project })} />;
}

// The body of the section once the project is resolved from its id: a hint, the projects' loading or failed state, or its issues.
function SectionBody({ projectId, project, projects, onQueue }: IssuesSectionProps & { project: string | null; projects: ReturnType<typeof useProjects> }) {
  if (projectId === ALL_PROJECTS) return <SectionNote>Choose a project to see its issues.</SectionNote>;
  if (project) return <ProjectIssues project={project} onQueue={onQueue} />;
  if (projects.isPending) return <IssuesSkeleton />;
  if (projects.isError) return <SectionNote tone="text-red">The projects cannot be read; reload the page.</SectionNote>;
  return <SectionNote>This project is no longer registered.</SectionNote>;
}

// The Issues section under the jobs: the toolbar's project's issues plus its org's, or a hint while every project is shown.
export function IssuesSection({ projectId, onQueue }: IssuesSectionProps) {
  const projects = useProjects();
  const project = projectId === ALL_PROJECTS ? null : (projects.data?.find((entry) => entry.id === projectId)?.name ?? null);
  return (
    <SectionFrame title={project ? `Issues · ${project}` : "Issues"}>
      <SectionBody projectId={projectId} project={project} projects={projects} onQueue={onQueue} />
    </SectionFrame>
  );
}
