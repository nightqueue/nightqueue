import { addColumnIfMissing, dropColumnIfPresent, hasColumn } from "./columns.mjs";
import { CLOSED_REQUIRES_MERGE, RESULT_OBJECT_BASE } from "./schema.mjs";

const LEGACY_COLUMNS = ["ship_status", "ship", "ship_worker", "ship_lease_until"];
const ENDED_STATUSES = "status IN ('closed', 'merged')";
const HAS_PR = "(pr_url IS NOT NULL AND trim(pr_url) <> '')";
const MERGE_RECORDED = "(CASE WHEN json_valid(close) THEN json_extract(close, '$.data.merged') END) IS 1";
const CLOSE_OBJECT = `COALESCE(CASE WHEN json_valid(close) THEN CASE WHEN json_type(close) = 'object' THEN close END END, '{}')`;
const NOT_AN_OBJECT = `CASE WHEN close IS NOT NULL AND ${CLOSE_OBJECT} = '{}' AND close <> '{}' THEN close END`;

// A member of the close object as a JSON object: the one already there, or an empty one when it is missing or not an object.
function objectMember(member) {
  return `json(CASE WHEN json_type(${CLOSE_OBJECT}, '$.${member}') = 'object' THEN json_extract(${CLOSE_OBJECT}, '$.${member}') ELSE '{}' END)`;
}

const SYNTHETIC_MERGE = `json_set(${CLOSE_OBJECT},
  '$.steps', ${objectMember("steps")},
  '$.data', ${objectMember("data")},
  '$.steps.merge', json_object('status', 'skipped', 'note', 'merged outside a close', 'at', strftime('%Y-%m-%dT%H:%M:%SZ', finished_at)),
  '$.data.merged', json('true'),
  '$.data.mergedBy', 'operator',
  '$.migrated', json_object('from', close_status, 'previous', ${NOT_AN_OBJECT}))`;

const NOTICE_LINE = "(CASE WHEN json_valid(close) THEN CASE WHEN json_type(close, '$.data.noticeLine') = 'text' THEN json_extract(close, '$.data.noticeLine') END END)";

// Tells whether any column of the retired pipeline is still on the jobs table.
function hasLegacyColumns(db) {
  return LEGACY_COLUMNS.some((column) => hasColumn(db, "jobs", column));
}

// Tells whether the jobs table still needs the close migration: a guard column missing, a legacy column left, or a retired `merged` row.
export function closeMigrationPending(db) {
  if (!hasColumn(db, "jobs", "close_worker") || hasLegacyColumns(db)) return true;
  return Boolean(db.prepare("SELECT 1 FROM jobs WHERE status = 'merged' LIMIT 1").get());
}

// Copies the checklist, the lease and the state of every row the retired pipeline touched into the close columns.
function copyLegacyColumns(db) {
  if (!hasColumn(db, "jobs", "ship_status")) return;
  db.exec(`UPDATE jobs
      SET close = COALESCE(ship, close),
          close_lease_until = ship_lease_until,
          close_status = CASE ship_status WHEN 'shipping' THEN 'closing' WHEN 'failed' THEN 'failed' ELSE NULL END
    WHERE ship_status IS NOT NULL OR ship IS NOT NULL`);
}

// Turns an ended row with no pull request into a cancelled one, keeping its previous status and note in `result`.
function cancelEndedWithoutPr(db) {
  db.exec(`UPDATE jobs
      SET result = json_set(${RESULT_OBJECT_BASE}, '$.cancelledFrom', status, '$.migratedOperatorNote', operator_note),
          status = 'cancelled',
          operator_note = 'migrated: closed without a pull request',
          close_status = NULL,
          close_lease_until = NULL,
          finished_at = COALESCE(finished_at, datetime('now'))
    WHERE ${ENDED_STATUSES} AND NOT ${HAS_PR}`);
}

// Settles an ended row whose checklist already records the merge as closed, with no close in flight.
function closeRecordedMerges(db) {
  db.exec(`UPDATE jobs SET status = 'closed', close_status = NULL, close_lease_until = NULL
    WHERE ${ENDED_STATUSES} AND ${HAS_PR} AND ${MERGE_RECORDED}
      AND (status <> 'closed' OR close_status IS NOT NULL OR close_lease_until IS NOT NULL)`);
}

// Gives an ended row with a pull request but no recorded merge the synthetic merge record, extending the checklist it had.
function recordMergesOutsideAClose(db) {
  db.exec(`UPDATE jobs
      SET close = ${SYNTHETIC_MERGE},
          status = 'closed',
          close_status = NULL,
          close_lease_until = NULL
    WHERE ${ENDED_STATUSES} AND ${HAS_PR} AND NOT (${MERGE_RECORDED})`);
}

// Rewrites the notice line a settled close appended under the retired wording, only where the notice holds it exactly.
function rewriteNoticeLines(db) {
  if (!hasColumn(db, "jobs", "ship_status")) return;
  db.exec(`UPDATE jobs
      SET notice_md = replace(notice_md, ${NOTICE_LINE}, 'Closed: ' || substr(${NOTICE_LINE}, 10))
    WHERE substr(${NOTICE_LINE}, 1, 9) = 'Shipped: ' AND instr(notice_md, ${NOTICE_LINE}) > 0`);
}

// Copies the worker token of a close still in flight into the close columns, and none onto a row the migration finalized.
function copyLegacyWorker(db) {
  if (!hasColumn(db, "jobs", "ship_worker")) return;
  db.exec("UPDATE jobs SET close_worker = ship_worker WHERE ship_worker IS NOT NULL AND close_status = 'closing'");
}

// Brings the jobs table to the close columns and the closed invariant; it must run inside one immediate transaction.
export function migrateCloseColumns(db) {
  addColumnIfMissing(db, "jobs", "close_status", "TEXT CHECK(close_status IN ('closing','failed'))");
  addColumnIfMissing(db, "jobs", "close", "TEXT");
  addColumnIfMissing(db, "jobs", "close_lease_until", "TEXT");
  copyLegacyColumns(db);
  cancelEndedWithoutPr(db);
  closeRecordedMerges(db);
  recordMergesOutsideAClose(db);
  rewriteNoticeLines(db);
  addColumnIfMissing(db, "jobs", "close_worker", `TEXT ${CLOSED_REQUIRES_MERGE}`);
  copyLegacyWorker(db);
  for (const column of LEGACY_COLUMNS) dropColumnIfPresent(db, "jobs", column);
}
