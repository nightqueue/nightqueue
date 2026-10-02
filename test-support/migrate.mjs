import { preVersionBackupPath } from "../src/config/paths.mjs";
import { DB_USER_VERSION, migrateHomeDatabase, openDb } from "../src/memory/db.mjs";

let sequence = 0;

// The backup path a test migration writes to: beside the real `pre-v<N>` name, named by process and sequence, since racing test processes hold no home lock.
function testBackupPath(env) {
  sequence += 1;
  return `${preVersionBackupPath(env, DB_USER_VERSION)}.test-${process.pid}-${sequence}`;
}

// Migrates an older test home the way `nightqueue update --schema-only` does (backup first, then the migration), and answers its writable connection; on a current home it is `openDb`.
export function migrateTestHome(env = process.env) {
  migrateHomeDatabase(env, { backupPath: testBackupPath(env) });
  return openDb(env);
}
