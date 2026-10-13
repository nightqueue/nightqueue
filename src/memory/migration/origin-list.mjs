import { inTransaction } from "../tx.mjs";

const PENDING = `origin IS NOT NULL AND (typeof(origin) <> 'text'
  OR COALESCE(CASE WHEN json_valid(origin) THEN json_type(origin) END, '') <> 'array')`;

const KIND = "trim(json_extract(origin, '$.kind'))";
const REF = "trim(json_extract(origin, '$.ref'))";

const AS_LIST = `CASE WHEN typeof(origin) = 'text' AND json_valid(origin) THEN
    CASE WHEN json_type(origin) = 'object' THEN
      CASE WHEN json_type(origin, '$.kind') = 'text' AND json_type(origin, '$.ref') = 'text' THEN
        CASE WHEN ${KIND} <> '' AND ${REF} <> '' THEN json_array(json_object('kind', ${KIND}, 'ref', ${REF})) END
      END
    END
  END`;

// Rewrites every stored single origin as a one-element list and anything unreadable as none, behind a read that finds nothing once done.
export function migrateOriginLists(db) {
  if (!db.prepare(`SELECT 1 FROM jobs WHERE ${PENDING} LIMIT 1`).get()) return;
  inTransaction(db, () => db.prepare(`UPDATE jobs SET origin = ${AS_LIST} WHERE ${PENDING}`).run());
}
