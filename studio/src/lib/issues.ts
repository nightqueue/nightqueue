import { useQuery } from "@tanstack/react-query";
import type { Project } from "./types";
import { callTool } from "./mcp";
import type { IssueItem, IssueStatus } from "./types";

export const ISSUE_STATUS_ORDER: IssueStatus[] = ["backlog", "todo", "in_progress", "in_review", "done", "cancelled"];

export type IssueStatusFilter = IssueStatus | "all";

const QUEUEABLE_STATUSES: IssueStatus[] = ["backlog", "todo"];

// Tells whether one listing entry has the fields a row needs.
function isIssueItem(item: unknown): item is IssueItem {
  const entry = item as Partial<IssueItem> | null;
  return typeof entry?.ref === "string" && typeof entry?.title === "string" && typeof entry?.status === "string";
}

// The items of an `issue_get` listing, keeping only the well-formed ones.
function itemsOf(answer: { items?: unknown } | null): IssueItem[] {
  return Array.isArray(answer?.items) ? answer.items.filter(isIssueItem) : [];
}

// The issues a project sees (its own and its org's), read once a project is chosen.
export function useProjectIssues(project: string | null) {
  return useQuery({
    queryKey: ["issues", project],
    queryFn: async () => itemsOf(await callTool<{ items?: unknown }>("issue_get", { project })),
    enabled: project !== null,
    staleTime: 10_000,
  });
}

// The issues of every registered project at once, each item tagged with its project; an org item is listed once, under the first project that sees it.
export function useAllProjectsIssues(projects: Project[] | undefined) {
  const names = (projects ?? []).map((project) => project.name);
  return useQuery({
    queryKey: ["issues", "all", names],
    queryFn: async () => {
      const listings = await Promise.all(names.map(async (project) => ({ project, items: itemsOf(await callTool<{ items?: unknown }>("issue_get", { project })) })));
      const seen = new Set<string>();
      const merged: IssueItem[] = [];
      for (const { project, items } of listings) {
        for (const item of items) {
          if (item.scope === "org") {
            if (seen.has(item.ref)) continue;
            seen.add(item.ref);
          }
          merged.push({ ...item, project });
        }
      }
      return merged;
    },
    enabled: names.length > 0,
    staleTime: 10_000,
  });
}

// The status shown for an item: an org item's own project row, else the item's status.
export function shownStatus(item: IssueItem): IssueStatus {
  return item.project_status ?? item.status;
}

// The job linked to an item: an org item's own project row job, else the item's job.
export function shownJobRef(item: IssueItem): string | null {
  return item.project_job_ref ?? item.job_ref ?? null;
}

// What a row offers: queueing an open item not yet started, else a link to its job (in progress, in review or closed).
export function issueRowAction(item: IssueItem): "link" | "queue" {
  return QUEUEABLE_STATUSES.includes(shownStatus(item)) ? "queue" : "link";
}

// The count of items per shown status.
export function issueCounts(items: IssueItem[]): Record<IssueStatus, number> {
  const counts = Object.fromEntries(ISSUE_STATUS_ORDER.map((status) => [status, 0])) as Record<IssueStatus, number>;
  for (const item of items) counts[shownStatus(item)] = (counts[shownStatus(item)] ?? 0) + 1;
  return counts;
}

// Splits the items into the open ones and the done or cancelled ones, each keeping its order.
export function splitClosedIssues(items: IssueItem[]): { open: IssueItem[]; closed: IssueItem[] } {
  const isClosed = (item: IssueItem) => shownStatus(item) === "done" || shownStatus(item) === "cancelled";
  return { open: items.filter((item) => !isClosed(item)), closed: items.filter(isClosed) };
}

const DONE_GROUP_KEY = "nightqueue.issues.doneGroupOpen";

// Reads whether the `Done` group was left expanded in this session; a blocked storage reads as collapsed.
export function readDoneGroupOpen(): boolean {
  try {
    return window.sessionStorage.getItem(DONE_GROUP_KEY) === "1";
  } catch {
    return false;
  }
}

// Remembers for the session whether the `Done` group is expanded; a blocked storage is ignored.
export function writeDoneGroupOpen(open: boolean): void {
  try {
    window.sessionStorage.setItem(DONE_GROUP_KEY, open ? "1" : "0");
  } catch {
    return;
  }
}

// The items whose shown status passes the pill filter.
export function filterIssues(items: IssueItem[], filter: IssueStatusFilter): IssueItem[] {
  return filter === "all" ? items : items.filter((item) => shownStatus(item) === filter);
}
