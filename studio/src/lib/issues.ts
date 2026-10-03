import { useQuery } from "@tanstack/react-query";
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

// The items whose shown status passes the pill filter.
export function filterIssues(items: IssueItem[], filter: IssueStatusFilter): IssueItem[] {
  return filter === "all" ? items : items.filter((item) => shownStatus(item) === filter);
}
