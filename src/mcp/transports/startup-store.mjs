import { StoreUnavailableError, storeWarningLine } from "../../config/errors.mjs";
import { openStoreReadOnly } from "../../store/open.mjs";

// Checks the home database's schema before the server connects, warning on one stderr line instead of dying when it is older or unavailable; it never migrates.
export async function checkSchemaOrWarn(env, writeErr = (line) => process.stderr.write(`${line}\n`)) {
  try {
    await openStoreReadOnly(env).requireCurrentSchema();
  } catch (err) {
    if (!(err instanceof StoreUnavailableError)) throw err;
    writeErr(storeWarningLine(err));
  }
}
