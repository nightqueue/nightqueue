export type JobStatus = "pending" | "running" | "done" | "gate" | "failed" | "cancelled" | "closed";

export interface LiveBlock {
  source: string;
  attempt: number | null;
  agent: string | null;
  model: string | null;
  phase: number | null;
  phases: number | null;
  intent: string | null;
  last: { kind: string; text: string; at: string | null } | null;
  lane_opened_at: string | null;
  quiet_s: number | null;
  truncated: boolean;
  tokens: { in: number; out: number; cache_read: number; cache_creation: number } | null;
  tokens_estimated: boolean | null;
}

export interface StudioCells {
  status_label: string;
  closing: boolean;
  reason: string | null;
  tokens_label: string;
  glyph: string | null;
  item_ref: string | null;
}

export interface Job {
  id: number;
  project: string;
  project_id: string;
  status: JobStatus;
  priority: number;
  tier: string | null;
  attempts: number;
  max_attempts: number;
  timeout_s: number;
  slug: string | null;
  branch: string | null;
  pr_url: string | null;
  pr_state?: string | null;
  worker: string | null;
  operator_note: string | null;
  blocked_code: string | null;
  notice_md: string | null;
  title: string | null;
  created_at: string | null;
  started_at: string | null;
  finished_at: string | null;
  lease_until: string | null;
  live: LiveBlock | null;
  studio: StudioCells;
}

export interface JobDetail extends Omit<Job, "studio"> {
  session_id: string | null;
  item_ref: string | null;
  run_notice?: string | null;
  tokens_in: number | null;
  tokens_out: number | null;
  cache_read: number | null;
  cache_creation: number | null;
  cost_usd: number | null;
  bash_timeouts: number | null;
  baseline_ctx: number | null;
  orch_turns: number | null;
  orch_ctx_last: number | null;
}

export interface IssueSummary {
  ref: string;
  title: string;
  decision_ref: string | null;
}

export interface Runner {
  running: boolean;
  pid: number;
  mode: string | null;
  jobId: number | null;
  intervalS: number | null;
  startedAt: string | null;
  logPath: string | null;
  runtimeDir: string | null;
  window: { from: string; until: string } | null;
  job_id: number | null;
}

export interface QueueSnapshot {
  runners: Runner[];
  runnersOnline: number;
  advisories: string[];
  jobs: Job[];
  counts: Record<JobStatus, number>;
  suggestions: string[];
  hint: string;
  queue_paused: boolean;
  warning?: string | null;
}

export interface QueuePatch {
  set: Partial<QueueSnapshot>;
  jobs?: { upsert: Job[]; remove: number[]; order: number[] };
}

export interface NarrationEvent {
  kind: string;
  glyph: string;
  clock: string;
  text: string;
  dim: string;
  indent: boolean;
  lane: string | null;
  tool: string | null;
  agent: string | null;
  phase: number | null;
  model: string | null;
  durationMs: number | null;
  elapsedMs: number | null;
  file: string | null;
}

export interface TimelinePhase {
  number: number;
  name: string;
  model: string | null;
  state: "done" | "now" | "gate" | "pending" | "skip";
  offsetMs: number | null;
  durationMs: number | null;
}

export interface Timeline {
  track: string | null;
  phases: TimelinePhase[];
}

export interface JobMeta {
  run_dir: string | null;
  state_json: string | null;
  log_path: string;
  artifacts: string[];
  files: string[] | null;
  baseline: { n: number; turns: number | null; ctx: number | null; cost: number | null } | null;
}

export interface StudioInfo {
  version: string;
  runtime: string | null;
  mcp: string;
  queue_paused: boolean;
}

export interface Project {
  id: string;
  name: string;
  key: string | null;
  path: string | null;
  org: string | null;
  exists: boolean;
}

export type RunnerChoice =
  | { mode: "drain" }
  | { mode: "loop"; intervalS: number }
  | { mode: "once"; jobId: number }
  | { mode: "window"; from: string; until: string };

export interface QueueFilters {
  status: JobStatus | "all";
  projectId: string;
  search: string;
}
