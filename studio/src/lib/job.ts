import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { useQueueSnapshot } from "./events";
import { callTool } from "./mcp";
import { jobIdOfRef, normalizeSnapshot } from "./queue";
import type { IssueSummary, Job, JobDetail, NarrationEvent } from "./types";

export type LogFilter = "narrated" | "orchestrator" | "lanes" | "tools";

export const LOG_FILTERS: readonly { value: LogFilter; label: string }[] = [
  { value: "narrated", label: "narrated" },
  { value: "orchestrator", label: "orchestrator only" },
  { value: "lanes", label: "lanes" },
  { value: "tools", label: "all tools" },
];

const LANE_KINDS = new Set(["laneOpen", "laneClose", "laneOrphan", "attempt", "resultEnd"]);

const TOOL_KINDS = new Set(["tool", "toolError"]);

const MEMORY_TOOLS = new Set(["lesson_recall", "memory_recall", "decision_recall", "index_recall", "context_for_phase"]);

const RUNNING_REFRESH_MS = 5000;

// The query key of one job's detail.
export function jobKey(ref: string) {
  return ["job", ref] as const;
}

// The job of a `queue_status {job_id}` answer, refusing an answer that carries none.
function detailOf(answer: { job?: unknown } | null): JobDetail {
  const job = answer?.job as JobDetail | undefined;
  if (!job || typeof job !== "object" || typeof job.id !== "number") throw new Error("queue_status answered without the job");
  return job;
}

// One job in full from `queue_status`, refreshed every 5 s while it runs.
export function useJobDetail(ref: string) {
  return useQuery({
    queryKey: jobKey(ref),
    queryFn: async () => detailOf(await callTool<{ job?: unknown }>("queue_status", { job_id: ref })),
    refetchInterval: (query) => (query.state.data?.status === "running" ? RUNNING_REFRESH_MS : false),
    retry: 1,
  });
}

// What of a queue row tells the detail is out of date: status, attempt, notice, PR and close.
function rowSignature(row: Job | undefined): string | null {
  if (!row) return null;
  return [row.status, row.attempts, row.attempt_started_at, row.notice_md, row.pr_url, row.pr_state, row.studio?.closing].join("|");
}

// The live queue row of a job (with its studio cells) and the runners online; refetches the detail whenever that row changes.
export function useQueueRowOf(ref: string): { row: Job | undefined; runnersOnline: number | null } {
  const raw = useQueueSnapshot();
  const queryClient = useQueryClient();
  const id = jobIdOfRef(ref);
  const snapshot = raw ? normalizeSnapshot(raw) : undefined;
  const row = snapshot?.jobs.find((job) => job.id === id);
  const signature = rowSignature(row);
  const seen = useRef<string | null>(null);
  useEffect(() => {
    if (signature === null) return;
    if (seen.current !== null && seen.current !== signature) void queryClient.invalidateQueries({ queryKey: jobKey(ref) });
    seen.current = signature;
  }, [signature, ref, queryClient]);
  return { row, runnersOnline: snapshot ? snapshot.runnersOnline : null };
}

// The issue a job was queued from, for its title and linked decision; read once.
export function useIssueSummary(itemRef: string | null) {
  return useQuery({
    queryKey: ["issue", itemRef],
    queryFn: () => callTool<IssueSummary>("issue_get", { id: itemRef }),
    enabled: itemRef !== null,
    staleTime: Infinity,
    retry: false,
  });
}

// Tells whether a narration event passes one log chip.
function passesFilter(event: NarrationEvent, filter: LogFilter): boolean {
  if (filter === "orchestrator") return !event.indent;
  if (filter === "lanes") return LANE_KINDS.has(event.kind);
  if (filter === "tools") return TOOL_KINDS.has(event.kind);
  return true;
}

// The narration events one log chip keeps, in order.
export function filterNarration(events: NarrationEvent[], filter: LogFilter): NarrationEvent[] {
  return filter === "narrated" ? events : events.filter((event) => passesFilter(event, filter));
}

// The colour class of one narration line, by its kind (and memory recalls by their tool).
export function narrationTone(event: NarrationEvent): string {
  if (event.kind === "tool" && event.tool && MEMORY_TOOLS.has(event.tool)) return "text-log-mem";
  if (event.kind === "laneOpen" || event.kind === "laneClose") return "text-log-lane";
  if (event.kind === "text") return "text-fg";
  if (event.kind === "slug") return "text-accent";
  if (["toolError", "gate", "marker", "laneOrphan", "truncated"].includes(event.kind)) return "text-red";
  if (event.kind === "tool" || event.kind === "quiet") return "text-muted";
  return "text-log";
}

// The notice a job screen shows: the run's own whole notice when it differs from the row's, else the row's.
export function noticeOf(job: Pick<JobDetail, "notice_md" | "run_notice">): string {
  return job.run_notice?.trim() || job.notice_md?.trim() || "";
}
