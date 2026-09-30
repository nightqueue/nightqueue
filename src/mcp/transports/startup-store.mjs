import { StoreUnavailableError, storeWarningLine } from "../../config/errors.mjs";
import { openStoreReadOnly } from "../../store/open.mjs";

// Migrates the home database before the server connects, warning on one stderr line instead of dying when it is unavailable.
export async function migrateOrWarn(env, writeErr = (line) => process.stderr.write(`${line}\n`)) {
  try {
    await openStoreReadOnly(env).migrateIfOutdated();
  } catch (err) {
    if (!(err instanceof StoreUnavailableError)) throw err;
    writeErr(storeWarningLine(err));
  }
}
