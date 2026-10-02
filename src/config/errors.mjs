// Expected CLI usage error: the only signal that turns into exit code 1.
export class UserError extends Error {
  constructor(message) {
    super(message);
    this.name = "UserError";
  }
}

export const STORE_UNAVAILABLE_HINT = "nightqueue doctor --fix";

// The home database cannot be read or written at all (not a database, corrupt, I/O error, read-only): one line, with the fix.
export class StoreUnavailableError extends UserError {
  constructor({ code, errcode = null, detail, home, path }) {
    super(`the nightqueue database at ${path} is unavailable (${code}: ${detail}); run \`${STORE_UNAVAILABLE_HINT}\``);
    this.name = "StoreUnavailableError";
    this.code = code;
    this.errcode = Number.isInteger(errcode) ? errcode : null;
    this.detail = detail;
    this.home = home;
    this.path = path;
    this.hint = STORE_UNAVAILABLE_HINT;
  }
}

export const SCHEMA_UPDATE_HINT = "nightqueue update";

// The phrase every refusal of an older database carries, naming both versions and the one command that migrates it.
export function schemaOutdatedPhrase(fileVersion, codeVersion) {
  return `database at v${fileVersion}, this nightqueue expects v${codeVersion}: run \`${SCHEMA_UPDATE_HINT}\``;
}

// The home database is at an older schema than this build: nothing opens it until `nightqueue update` migrates it.
export class SchemaOutdatedError extends StoreUnavailableError {
  constructor({ fileVersion, codeVersion, home, path }) {
    const detail = schemaOutdatedPhrase(fileVersion, codeVersion);
    super({ code: "SCHEMA_OUTDATED", detail, home, path });
    this.message = `${detail} (${path}); when the installed nightqueue is already current, a second \`${SCHEMA_UPDATE_HINT}\` finishes the migration`;
    this.name = "SchemaOutdatedError";
    this.hint = SCHEMA_UPDATE_HINT;
    this.fileVersion = fileVersion;
    this.codeVersion = codeVersion;
  }
}

// Tells whether a failure is a store outage that may heal by waiting or queuing: an unavailable store, never an older schema, which only `nightqueue update` heals.
export function isStoreOutage(err) {
  return err instanceof StoreUnavailableError && !(err instanceof SchemaOutdatedError);
}

// The one warning line a degraded surface (MCP context, SessionStart hook) prints instead of its content.
export function storeWarningLine(err) {
  const where = `${err?.code ?? "unknown"} at ${err?.home ?? "unknown home"}`;
  if (err instanceof SchemaOutdatedError) return `nightqueue memory unavailable (${where}): ${err.detail}`;
  return `nightqueue memory unavailable (${where}): run \`${err?.hint ?? STORE_UNAVAILABLE_HINT}\``;
}
