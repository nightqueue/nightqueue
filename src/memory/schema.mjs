export const DB_USER_VERSION = 8;

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
