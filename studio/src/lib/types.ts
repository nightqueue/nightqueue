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

export type CloseState = "closing" | "stalled" | "failed" | "closed";

export interface StudioCells {
  status_label: string;
  close_state: CloseState | null;
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
  attempt_started_at?: string | null;
  finished_at: string | null;
  lease_until: string | null;
  attempts_log?: AttemptRow[] | null;
  active_s?: number | null;
  wall_s?: number | null;
  live: LiveBlock | null;
  studio: StudioCells;
}

export type AttemptOutcome = "gate" | "done" | "failed" | "cancelled" | "released" | "timed_out" | "lost";

export interface AttemptRow {
  attempt: number;
  worker: string | null;
  session_id: string | null;
  started_at: string | null;
  finished_at: string | null;
  duration_s: number | null;
  outcome: AttemptOutcome | null;
  exit_reason: string | null;
  spawns: number;
  tokens_in: number | null;
  tokens_out: number | null;
  cache_read: number | null;
  cache_creation: number | null;
  cost_usd: number | null;
  fresh: boolean;
  backfilled: boolean;
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

export type IssueStatus = "backlog" | "todo" | "in_progress" | "in_review" | "done" | "cancelled";

export interface IssueItem {
  ref: string;
  title: string;
  type: string | null;
  priority: number | null;
  status: IssueStatus;
  scope: "project" | "org";
  job_ref: string | null;
  project_status?: IssueStatus | null;
  project_job_ref?: string | null;
  project?: string;
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
  laneId: string | null;
  body: string | null;
  body_truncated: boolean;
  body_offset: number | null;
  at: string | null;
  artifact: string | null;
  title: string | null;
  bytes: number | null;
}

export interface ArtifactEntry {
  name: string;
  bytes: number;
  title: string | null;
  mtime: string;
}

export interface TimelinePhase {
  number: number;
  name: string;
  model: string | null;
  state: "done" | "now" | "gate" | "pending" | "skip";
  durationMs: number | null;
  liveSinceMs: number | null;
  tokens: number;
  tokens_label: string;
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
  tier: string | null;
  baseline:{ n: number; turns: number | null; ctx: number | null; cost: number | null } | null;
}

export interface DiffstatFile {
  path: string;
  added: number | null;
  deleted: number | null;
  untracked?: boolean;
  kind?: DiffKind | null;
  from?: string;
}

export type DiffKind = "new" | "mod" | "del" | "ren";

export interface Diffstat {
  source: "worktree" | "recorded" | "none";
  base: string | null;
  files: DiffstatFile[];
  totals: { added: number; deleted: number } | null;
  note: string | null;
}

export interface RecallHit {
  ref: string | null;
  title: string | null;
  score: number | null;
  via?: string;
  text?: string;
}

export type RecallKind = "decision" | "lesson" | "index" | "memory";

export interface Recall {
  id: string | null;
  tool: "lesson_recall" | "memory_recall" | "decision_recall" | "index_recall";
  kind: RecallKind;
  query: string | null;
  agent: string;
  phase: number | null;
  attempt: number;
  at_s: number | null;
  pending: boolean;
  error: string | null;
  hits: RecallHit[];
  applied: string[];
}

export interface RecallsAnswer {
  recalls: Recall[];
  applied_total: number;
  embedding: { model: string; threshold: number } | null;
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

export type TerminalKind = "session" | "operator";

export interface TerminalExit {
  code: number | null;
  signal: number | string | null;
}

export interface TerminalInfo {
  id: string;
  kind: TerminalKind;
  label: string;
  job_ref: string | null;
  project: string | null;
  cwd: string;
  note: string | null;
  created_at: string;
  attached: boolean;
  exited: false | TerminalExit;
  instruction: null | "given";
}

export interface TerminalsAnswer {
  available: boolean;
  reason: string | null;
  cap: number;
  instruction_max: number;
  terminals: TerminalInfo[];
}

export interface TerminalCreated {
  terminal: TerminalInfo;
  reused: boolean;
}

export type TerminalRequest = { kind: "session"; job: string; instruction?: string } | { kind: "operator"; project?: string; instruction?: string };

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
