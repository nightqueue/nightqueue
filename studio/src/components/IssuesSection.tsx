import { Link } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import { errorText } from "../lib/actions";
import { useProjects } from "../lib/api";
import { filterIssues, ISSUE_STATUS_ORDER, issueCounts, issueRowAction, type IssueStatusFilter, shownJobRef, shownStatus, useAllProjectsIssues, useProjectIssues } from "../lib/issues";
import { ALL_PROJECTS } from "../lib/queue";
import type { IssueItem } from "../lib/types";
import { AddIssueDrawer } from "./AddIssueDrawer";
import { TerminalLaunchButton } from "./TerminalLaunchButton";
import { ProjectSelect, SearchBox } from "./Toolbar";
import { Button, Chip } from "./ui";

interface IssuesSectionProps {
  projectId: string;
  onQueue: (issue: { ref: string; project: string }) => void;
}

type QueueIssue = (ref: string, project?: string) => void;

interface IssueRowsProps {
  items: IssueItem[];
  onQueue: QueueIssue;
  showProject: boolean;
  project: string | null;
}

interface IssueFilters {
  projectId: string;
  search: string;
  status: IssueStatusFilter;
}

const COLUMNS: { label: string; width?: string }[] = [
  { label: "REF", width: "w-[96px]" },
  { label: "PROJECT", width: "w-[170px]" },
  { label: "TITLE" },
  { label: "TYPE", width: "w-[110px]" },
  { label: "PRIO", width: "w-[64px]" },
  { label: "STATUS", width: "w-[110px]" },
  { label: "JOB", width: "w-[130px]" },
  { label: "TERMINAL", width: "w-[110px]" },
];

const SKELETON_ROWS = [0, 1, 2];

// The frame of the issues section: a heading line, the toolbar, then its body.
function SectionFrame({ title, toolbar, children }: { title: string; toolbar: ReactNode; children: ReactNode }) {
  return (
    <section aria-label="issues" className="overflow-hidden rounded-lg border border-line bg-surface">
      <h2 className="m-0 border-b border-line px-3 py-2.5 text-sm font-medium text-muted">{title}</h2>
      <div className="border-b border-line px-3 py-2.5">{toolbar}</div>
      {children}
    </section>
  );
}

// A one-line message inside the section: empty, idle or failed.
function SectionNote({ children, tone = "text-muted" }: { children: ReactNode; tone?: string }) {
  return <p className={`m-0 px-3 py-6 text-center ${tone}`}>{children}</p>;
}

// The loading state: three rows shaped like the final ones.
function IssuesSkeleton() {
  return (
    <div className="flex flex-col gap-3 p-3" aria-label="loading issues">
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

// The status pills: `All N` then one pill per issue status with its count over the items the project and search left.
function IssuePills({ items, filter, onFilter }: { items: IssueItem[]; filter: IssueStatusFilter; onFilter: (next: IssueStatusFilter) => void }) {
  const counts = issueCounts(items);
  return (
    <>
      <Chip on={filter === "all"} onClick={() => onFilter("all")}>
        All {items.length}
      </Chip>
      {ISSUE_STATUS_ORDER.map((status) => (
        <Chip key={status} on={filter === status} onClick={() => onFilter(status)}>
          {status} {counts[status]}
        </Chip>
      ))}
    </>
  );
}

// Why the toolbar's `Open operator` cannot open the selected project's operator, null when it can.
function toolbarOperatorBlock(filters: IssueFilters, project: string | null): string | null {
  if (filters.projectId === ALL_PROJECTS) return "pick a project first";
  return project ? null : "this project is no longer registered";
}

// The toolbar of the section, shaped like the queue's: project and search over the status pills, `Open operator` and `+ Add issue` at the height of both rows.
function IssuesToolbar({ items, filters, project, onFilters, onAdd }: { items: IssueItem[]; filters: IssueFilters; project: string | null; onFilters: (next: IssueFilters) => void; onAdd: () => void }) {
  return (
    <div className="flex items-stretch gap-2">
      <div className="flex min-w-0 grow flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <ProjectSelect id="issues-project" value={filters.projectId} onChange={(projectId) => onFilters({ ...filters, projectId })} />
          <SearchBox id="issues-search" label="Search issues" placeholder="search ref, title, project…" value={filters.search} onChange={(search) => onFilters({ ...filters, search })} />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <IssuePills items={items} filter={filters.status} onFilter={(status) => onFilters({ ...filters, status })} />
        </div>
      </div>
      <TerminalLaunchButton
        variant="run"
        className="shrink-0 self-stretch"
        request={project ? { kind: "operator", project } : null}
        blockedReason={toolbarOperatorBlock(filters, project)}
        title={project ? `Open the ${project} operator in a terminal` : undefined}
      >
        Open operator
      </TerminalLaunchButton>
      <Button variant="primary" className="shrink-0 self-stretch" onClick={onAdd}>
        + Add issue
      </Button>
    </div>
  );
}

// A row's `Operator`: opens the item's project operator with the instruction to analyse the item.
function IssueOperator({ item, project }: { item: IssueItem; project: string | null }) {
  const target = item.project ?? project;
  return (
    <TerminalLaunchButton
      size="sm"
      request={target ? { kind: "operator", project: target, instruction: `Analyse ${item.ref}: ${item.title}` } : null}
      blockedReason={target ? null : "the item's project is unknown"}
      title={`Open the operator and ask it to analyse ${item.ref}`}
    >
      Operator
    </TerminalLaunchButton>
  );
}

// The action of a row: `Queue as job` for an item not started, else its linked job (or `—`).
function IssueAction({ item, onQueue }: { item: IssueItem; onQueue: QueueIssue }) {
  if (issueRowAction(item) === "queue") {
    return (
      <Button size="sm" onClick={() => onQueue(item.ref, item.project)}>
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

// The issues table for wide screens: ref, project (when every project is shown), title, type, priority, status, the linked job and the Operator.
function IssuesTable({ items, onQueue, showProject, project }: IssueRowsProps) {
  const columns = showProject ? COLUMNS : COLUMNS.filter((column) => column.label !== "PROJECT");
  return (
    <div className="max-h-[480px] overflow-y-auto">
      <table className="w-full table-fixed border-collapse">
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column.label} className={`sticky top-0 z-10 border-b border-line bg-surface px-3 py-2 text-left text-sm font-medium text-muted ${column.width ?? ""}`}>
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr key={`${item.project ?? ""}:${item.ref}`}>
              <Cell className="font-mono whitespace-nowrap">{item.ref}</Cell>
              {showProject && <Cell className="truncate text-muted">{item.project ?? "-"}</Cell>}
              <Cell className="truncate">{item.title}</Cell>
              <Cell>{item.type ?? "-"}</Cell>
              <Cell className="font-mono">{item.priority === null ? "-" : `p${item.priority}`}</Cell>
              <Cell>{shownStatus(item)}</Cell>
              <Cell>
                <IssueAction item={item} onQueue={onQueue} />
              </Cell>
              <Cell>
                <IssueOperator item={item} project={project} />
              </Cell>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// The issues as stacked cards for narrow screens: ref, project and status, title, then type, the Operator and the action.
function IssueCards({ items, onQueue, showProject, project }: IssueRowsProps) {
  return (
    <ul className="m-0 flex list-none flex-col p-0">
      {items.map((item) => (
        <li key={`${item.project ?? ""}:${item.ref}`} className="flex flex-col gap-1.5 border-b border-row-line px-3 py-2.5">
          <div className="flex items-center gap-2">
            <span className="font-mono">{item.ref}</span>
            {showProject && item.project && <span className="truncate text-sm text-muted">{item.project}</span>}
            <span className="ml-auto text-sm text-muted">{shownStatus(item)}</span>
          </div>
          <div className="min-w-0 break-words">{item.title}</div>
          <div className="flex flex-wrap items-center gap-2 text-sm text-dim">
            <span>{typeLabel(item)}</span>
            <span className="ml-auto flex items-center gap-2">
              <IssueOperator item={item} project={project} />
              <IssueAction item={item} onQueue={onQueue} />
            </span>
          </div>
        </li>
      ))}
    </ul>
  );
}

// The items the search box keeps: ref, title or project containing the text, case-insensitively.
function searchIssues(items: IssueItem[], search: string): IssueItem[] {
  const needle = search.trim().toLowerCase();
  if (!needle) return items;
  return items.filter((item) => [item.ref, item.title, item.project ?? ""].some((field) => field.toLowerCase().includes(needle)));
}

// The list as a table on wide screens and cards on narrow ones, or the note that nothing is left to show.
function IssuesList({ items, shown, onQueue, showProject, project }: IssueRowsProps & { shown: IssueItem[] }) {
  if (shown.length === 0) {
    return <SectionNote>{items.length === 0 ? (showProject ? "No project has an issue yet." : "This project has no issue.") : "No issue matches the filters."}</SectionNote>;
  }
  return (
    <>
      <div className="hidden lg:block">
        <IssuesTable items={shown} onQueue={onQueue} showProject={showProject} project={project} />
      </div>
      <div className="lg:hidden">
        <IssueCards items={shown} onQueue={onQueue} showProject={showProject} project={project} />
      </div>
    </>
  );
}

// The issues the toolbar's project selects: every project's when all are shown, else the named project's and its org's.
function useShownIssues(projectId: string, projects: ReturnType<typeof useProjects>) {
  const all = projectId === ALL_PROJECTS;
  const project = all ? null : (projects.data?.find((entry) => entry.id === projectId)?.name ?? null);
  const everyProject = useAllProjectsIssues(all ? projects.data : undefined);
  const oneProject = useProjectIssues(project);
  const query = all ? everyProject : oneProject;
  const pending = projects.isPending || (query.isPending && query.fetchStatus !== "idle");
  return { all, project, pending, error: projects.isError ? "The projects cannot be read; reload the page." : query.isError ? `The issues cannot be read: ${errorText(query.error)}` : null, items: query.data ?? [] };
}

// The Issues section under the jobs: its own project select, search and status pills, every project's issues by default, `Open operator` and `+ Add issue`.
export function IssuesSection({ projectId, onQueue }: IssuesSectionProps) {
  const projects = useProjects();
  const [filters, setFilters] = useState<IssueFilters>({ projectId, search: "", status: "all" });
  const [adding, setAdding] = useState(false);
  const { all, project, pending, error, items } = useShownIssues(filters.projectId, projects);
  const searched = searchIssues(items, filters.search);
  const shown = filterIssues(searched, filters.status);
  const title = all ? "Issues · all projects" : project ? `Issues · ${project}` : "Issues";
  return (
    <>
      <SectionFrame title={title} toolbar={<IssuesToolbar items={searched} filters={filters} project={project} onFilters={setFilters} onAdd={() => setAdding(true)} />}>
        {pending ? (
          <IssuesSkeleton />
        ) : error ? (
          <SectionNote tone="text-red">{error}</SectionNote>
        ) : !all && !project ? (
          <SectionNote>This project is no longer registered.</SectionNote>
        ) : (
          <IssuesList items={items} shown={shown} showProject={all} project={project} onQueue={(ref, itemProject) => onQueue({ ref, project: itemProject ?? project ?? "" })} />
        )}
      </SectionFrame>
      {adding && <AddIssueDrawer onClose={() => setAdding(false)} initialProject={project ?? undefined} />}
    </>
  );
}
