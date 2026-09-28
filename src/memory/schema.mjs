export const DB_USER_VERSION = 18;

export const LEASE_GRACE_S = 60;

// Predicate of an active job for one alias: running under a lease still inside the grace window of its owner.
export function activeFor(alias) {
  return `${alias}.status = 'running' AND ${alias}.lease_until IS NOT NULL
      AND datetime(${alias}.lease_until) > datetime('now', '-${LEASE_GRACE_S} seconds')`;
}

// A job is active while it is running under a lease inside the grace window: the ceiling counts these.
export const ACTIVE_JOB_PREDICATE = activeFor("slot");

// The invariant of a closed job: it carries a pull request and a close checklist recording the merge, with no close in flight.
export const CLOSED_REQUIRES_MERGE = `CHECK (status <> 'closed' OR (pr_url IS NOT NULL AND trim(pr_url) <> '' AND close_status IS NULL
  AND (CASE WHEN json_valid(close) THEN json_extract(close, '$.data.merged') END) IS 1))`;

// The `result` a cancel or a retry grafts its own field onto: the JSON object already there, or a new one keeping what was.
export const RESULT_OBJECT_BASE = `CASE
              WHEN result IS NULL THEN '{}'
              WHEN json_valid(result) AND json_type(result) = 'object' THEN result
              ELSE json_object('previousResult', result) END`;

// Timestamp of SQLite ("YYYY-MM-DD HH:MM:SS", UTC) as ISO 8601.
export function sqliteToIso(ts) {
  return ts ? `${String(ts).replace(" ", "T")}Z` : null;
}

const ZONELESS_TIMESTAMP = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2}(?:\.\d+)?)$/;

// Milliseconds of a timestamp, reading a zone-less one as UTC: every timestamp this database stores is UTC, while `Date.parse` would take it as local time.
function timestampMs(value) {
  const text = typeof value === "string" ? value.trim() : "";
  const zoneless = ZONELESS_TIMESTAMP.exec(text);
  return Date.parse(zoneless ? `${zoneless[1]}T${zoneless[2]}Z` : text);
}

// Instant (Date, ISO 8601 text or a zone-less timestamp read as UTC) in the shape SQLite writes it ("YYYY-MM-DD HH:MM:SS", UTC); anything unusable is null.
export function isoToSqlite(value) {
  const ms = value instanceof Date ? value.getTime() : timestampMs(value);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString().replace("T", " ").replace(/\.\d+Z$/, "");
}
