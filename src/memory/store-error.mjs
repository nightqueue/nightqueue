import { existsSync } from "node:fs";
import { StoreUnavailableError } from "../config/errors.mjs";

const CANTOPEN = "SQLITE_CANTOPEN";

const CODES_BY_PRIMARY = new Map([
  [26, "SQLITE_NOTADB"],
  [11, "SQLITE_CORRUPT"],
  [10, "SQLITE_IOERR"],
  [8, "SQLITE_READONLY"],
  [14, CANTOPEN],
  [13, "SQLITE_FULL"],
  [15, "SQLITE_PROTOCOL"],
]);

const CODES_BY_MESSAGE = [
  [/file is not a database/i, "SQLITE_NOTADB"],
  [/database disk image is malformed/i, "SQLITE_CORRUPT"],
  [/disk I\/O error/i, "SQLITE_IOERR"],
  [/attempt to write a readonly database/i, "SQLITE_READONLY"],
  [/unable to open database file/i, CANTOPEN],
  [/database or disk is full/i, "SQLITE_FULL"],
  [/locking protocol/i, "SQLITE_PROTOCOL"],
];

const NODE_SQLITE_ERROR = "ERR_SQLITE_ERROR";

// The first line of a failure's message, the detail a one-line error carries.
function firstLine(err) {
  return String(err?.message ?? err ?? "").split("\n")[0].trim();
}

// The SQLite code of a node:sqlite failure, by errcode first; the message is read only for a node:sqlite error without one, never for user text.
function sqliteCode(err) {
  if (Number.isInteger(err?.errcode)) return CODES_BY_PRIMARY.get(err.errcode & 0xff) ?? null;
  if (err?.code !== NODE_SQLITE_ERROR) return null;
  const message = firstLine(err);
  return CODES_BY_MESSAGE.find(([pattern]) => pattern.test(message))?.[1] ?? null;
}

// The code of a failure that means the database itself is unusable; CANTOPEN counts only when the file exists, since a home with no database yet is not sick.
function unavailableCode(err, path) {
  const code = sqliteCode(err);
  if (code === CANTOPEN && !(typeof path === "string" && existsSync(path))) return null;
  return code;
}

// Turns a failure that means the home database is unusable into a StoreUnavailableError; any other failure answers null.
export function classifyStoreError(err, { home, path }) {
  if (err instanceof StoreUnavailableError) return err;
  const code = unavailableCode(err, path);
  if (!code) return null;
  const detail = typeof err?.errstr === "string" && err.errstr ? err.errstr : firstLine(err);
  return new StoreUnavailableError({ code, errcode: err?.errcode, detail, home, path });
}
