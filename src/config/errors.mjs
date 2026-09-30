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

// The one warning line a degraded surface (MCP context, SessionStart hook) prints instead of its content.
export function storeWarningLine(err) {
  return `nightqueue memory unavailable (${err?.code ?? "unknown"} at ${err?.home ?? "unknown home"}): run \`${STORE_UNAVAILABLE_HINT}\``;
}
