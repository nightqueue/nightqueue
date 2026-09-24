export const ROADMAP_STATUSES = Object.freeze(["backlog", "todo", "in_progress", "in_review", "done", "cancelled"]);
export const OPEN_STATUSES = Object.freeze(["backlog", "todo", "in_progress", "in_review"]);
export const CLOSED_STATUSES = Object.freeze(["done", "cancelled"]);
export const MANUAL_STATUSES = Object.freeze(ROADMAP_STATUSES.filter((status) => status !== "in_progress"));
export const LIVE_JOB_STATUSES = Object.freeze(["pending", "running", "gate"]);
export const HORIZON_REMOVED =
  "`horizon` was removed in schema v17: use `priority` (1-9, 1 first, like a job's) and `position`";
export const ROADMAP_TYPES = Object.freeze(["bug", "feature", "improvement", "chore", "incident"]);
export const DEFAULT_ROADMAP_TYPE = "improvement";
export const TIER_BY_TYPE = Object.freeze({ bug: "simple", feature: "complex", improvement: "simple", chore: "trivial", incident: "simple" });
export const COMMIT_TYPE_BY_TYPE = Object.freeze({
  bug: "fix",
  incident: "fix",
  feature: "feat",
  improvement: "refactor or perf",
  chore: "chore",
});
export const COMMENT_KINDS = Object.freeze(["note", "queued", "pr", "gate", "merged", "failed", "reopened", "closed"]);
export const OPERATOR_AUTHOR = "operator";
export const REOPENED_STATUSES = Object.freeze(["in_review", "done"]);

export const STATUS_ASSIGNMENT =
  "status = ?, closed_at = CASE WHEN ? = 'done' THEN COALESCE(closed_at, datetime('now')) ELSE NULL END";

const RETRY_SOURCES =Object.freeze(["failed", "cancelled", "gate"]);
const DIRECT_EVENTS = Object.freeze(["running", "gate", "done", "failed", "cancelled", "closed"]);
const NO_TRANSITION = Object.freeze({ status: null, kind: null });
const CLOSE_SOURCE = "done";

// What each job event does to the roadmap item linked to the job: the status it lands on and the comment kind it leaves.
export const JOB_TO_ROADMAP = Object.freeze({
  queued: Object.freeze({ status: "in_progress", kind: "queued" }),
  retried: Object.freeze({ status: "in_progress", kind: "queued" }),
  pending: Object.freeze({ status: "in_progress", kind: null }),
  running: Object.freeze({ status: "in_progress", kind: null }),
  gate: Object.freeze({ status: "in_progress", kind: "gate" }),
  done: Object.freeze({ status: "in_review", kind: "pr" }),
  failed: Object.freeze({ status: "todo", kind: "failed" }),
  cancelled: Object.freeze({ status: "todo", kind: "failed" }),
  closed: Object.freeze({ status: "done", kind: "closed" }),
});

// Reads one field of a job's `result` JSON, or null when the text is absent, malformed or not an object.
export function resultField(result, key) {
  if (typeof result !== "string" || result.trim() === "") return null;
  try {
    const parsed = JSON.parse(result);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed[key] ?? null) : null;
  } catch {
    return null;
  }
}

// The `JOB_TO_ROADMAP` event a job row stands for; job 67's gate answer A ("a closed job maps to done only when it delivered") is now enforced by main's CLOSED_REQUIRES_MERGE schema invariant.
export function jobEvent(job, seenStatus = null) {
  const status = job?.status ?? null;
  if (status === "pending") return RETRY_SOURCES.includes(seenStatus) ? "retried" : "pending";
  return DIRECT_EVENTS.includes(status) ? status : null;
}

// The status and comment kind a linked item takes from its job's current row; nulls mean the item stays as it is.
export function roadmapTransition(job, seenStatus = null) {
  return JOB_TO_ROADMAP[jobEvent(job, seenStatus)] ?? NO_TRANSITION;
}

// The `done` a close writer (settleClose, cancelOnClosedPr) always moved the job out of, when a follow that saw an earlier status missed it; null otherwise.
export function missedCloseSource(job, seenStatus = null) {
  if (seenStatus === null || seenStatus === CLOSE_SOURCE || seenStatus === job?.status) return null;
  if (job?.status === "closed") return CLOSE_SOURCE;
  if (job?.status === "cancelled" && resultField(job.result, "cancelledFrom") === CLOSE_SOURCE) return CLOSE_SOURCE;
  return null;
}

// Follows a job row onto one linked item or project row, first replaying the `done` a close writer left when that follow was
// missed, so the thread keeps its `pr` step; true when the target's status moved.
export function followThroughCloseSource({ target, job, apply }) {
  const source = missedCloseSource(job, target.job_status_seen);
  if (source === null) return apply(target, job);
  apply(target, { ...job, status: source });
  apply({ ...target, status: JOB_TO_ROADMAP[source].status, job_status_seen: source }, job);
  return roadmapTransition(job, source).status !== target.status;
}

// The author a job signs its comments with.
export function jobAuthor(jobId) {
  return `job:${jobId}`;
}

// Tells whether a text names a valid comment author: the operator or one job.
export function isCommentAuthor(author) {
  return author === OPERATOR_AUTHOR || (typeof author === "string" && /^job:[1-9]\d*$/.test(author));
}

// Tells whether a manual move from one status to another goes back from review or done, the move that reopens an item.
export function isReopening(from, to) {
  return REOPENED_STATUSES.includes(from) && ROADMAP_STATUSES.indexOf(to) < ROADMAP_STATUSES.indexOf(from);
}

// The file references a comment carries, each `{path}`, from whatever list the job's result recorded.
export function fileRefs(files) {
  if (!Array.isArray(files)) return [];
  return files.filter((path) => typeof path === "string" && path.trim() !== "").map((path) => ({ path: path.trim() }));
}

// A first line followed by a free-text note, when there is one.
function withNote(line, note) {
  const text = typeof note === "string" ? note.trim() : "";
  return text ? `${line}\n\n${text}` : line;
}

const COMMENT_BODIES = Object.freeze({
  queued: (job) => `queued as job #${job.id}`,
  retried: (job) => withNote(`re-queued by retry of job #${job.id}`, job.operator_note),
  gate: (job) => withNote(`job #${job.id} stopped at a gate`, job.notice_md),
  done: (job) => withNote(job.pr_url ? `job #${job.id} done: ${job.pr_url}` : `job #${job.id} done without a pull request`, job.notice_md),
  failed: (job) => withNote(`job #${job.id} failed`, job.notice_md),
  cancelled: (job) => withNote(`job #${job.id} cancelled`, job.operator_note),
  closed: (job) => `job #${job.id} closed`,
});

// The comment a job event leaves on its linked item, or null when the event leaves none.
export function commentFor(job, event, refs) {
  const kind = JOB_TO_ROADMAP[event]?.kind ?? null;
  const body = COMMENT_BODIES[event];
  if (kind === null || !body) return null;
  return { kind, author: jobAuthor(job.id), body: body(job, refs), refs };
}

// The status an org item takes from its per-project rows: null without rows, `in_progress` while any row is, `done` once
// every row is done or cancelled, otherwise the lowest open status among them.
export function deriveOrgStatus(statuses) {
  const list = Array.isArray(statuses) ? statuses.filter((status) => ROADMAP_STATUSES.includes(status)) : [];
  if (!list.length) return null;
  if (list.includes("in_progress")) return "in_progress";
  if (list.every((status) => CLOSED_STATUSES.includes(status))) return "done";
  return OPEN_STATUSES.find((status) => list.includes(status)) ?? null;
}

// Tells whether an org item's persisted status agrees with the derived one: equal, or both closed (a hand-cancelled item derives `done`).
export function orgStatusAgrees(persisted, derived) {
  if (derived === null || persisted === derived) return true;
  return CLOSED_STATUSES.includes(persisted) && CLOSED_STATUSES.includes(derived);
}

// SQL literal list of a set of statuses, for a CHECK or an IN clause built from the constants above.
export function sqlList(values) {
  return values.map((value) => `'${value}'`).join(", ");
}

// SQL expression ranking a status column in workflow order, the order every listing groups by.
export function statusRankSql(column) {
  return `CASE ${column} ${ROADMAP_STATUSES.map((status, rank) => `WHEN '${status}' THEN ${rank}`).join(" ")} ELSE ${ROADMAP_STATUSES.length} END`;
}

// SQL expression mapping a legacy row (`status`, `horizon`) of alias `r` to its v17 status.
export function legacyStatusSql(alias = "r") {
  return `CASE ${alias}.status
    WHEN 'open' THEN CASE WHEN ${alias}.horizon = 'now' THEN 'todo' ELSE 'backlog' END
    WHEN 'queued' THEN 'in_progress'
    WHEN 'done' THEN 'done'
    WHEN 'dropped' THEN 'cancelled'
    ELSE 'backlog' END`;
}
