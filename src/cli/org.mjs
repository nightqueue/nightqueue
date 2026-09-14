import { existsSync, readFileSync, rmSync } from "node:fs";
import { UserError } from "../config/errors.mjs";
import { addOrg, getOrg, listOrgs, removeOrg, renameOrg } from "../config/orgs.mjs";
import { dbPath, orgRenamePendingPath } from "../config/paths.mjs";
import { ensureHome, loadConfig, writeFileAtomic } from "../config/store.mjs";
import { openDb, withWriteRetry } from "../memory/db.mjs";
import { checkArgs, parseCommand } from "./args.mjs";

// The two tables that own rows by org name, which a rename must follow and a removal must never orphan.
const ORG_TABLES = ["decisions", "roadmap_items"];

// Undoes a failed transaction without ever masking the error that caused it.
function rollbackQuietly(db) {
  try {
    db.exec("ROLLBACK");
  } catch {
    return;
  }
}

// Rewrites the org of every decision and roadmap item a rename moves, both tables in one transaction; a home with no database has none.
function renameOrgRows(env, oldName, newName) {
  if (!existsSync(dbPath(env))) return;
  const db = openDb(env);
  const statements = ORG_TABLES.map((table) => db.prepare(`UPDATE ${table} SET org = ? WHERE scope = 'org' AND org = ?`));
  withWriteRetry(() => {
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const statement of statements) statement.run(newName, oldName);
      db.exec("COMMIT");
    } catch (err) {
      rollbackQuietly(db);
      throw err;
    }
  });
}

// The rename in flight, or null: `{ from, to, at }`, kept only between the first store change and the last.
export function readPendingRename(env) {
  const path = orgRenamePendingPath(env);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (typeof parsed?.from === "string" && typeof parsed?.to === "string") return { from: parsed.from, to: parsed.to, at: parsed.at ?? null };
  } catch {
    // An unreadable record is still a record: the rename it belongs to is not over.
  }
  return { from: null, to: null, at: null };
}

function writePendingRename(env, from, to) {
  ensureHome(env);
  writeFileAtomic(orgRenamePendingPath(env), `${JSON.stringify({ from, to, at: new Date().toISOString() })}\n`);
}

function clearPendingRename(env) {
  rmSync(orgRenamePendingPath(env), { force: true });
}

// Org rows whose org the config no longer knows, per name: the rows a half-done rename or a hand-edited config left behind.
export function orphanOrgRows(env, config, db = null) {
  if (!existsSync(dbPath(env))) return [];
  const connection = db ?? openDb(env);
  const counts = new Map();
  for (const table of ORG_TABLES) {
    const rows = connection.prepare(`SELECT org, COUNT(*) AS total FROM ${table} WHERE scope = 'org' GROUP BY org`).all();
    for (const row of rows) {
      if (getOrg(config, row.org)) continue;
      counts.set(row.org, (counts.get(row.org) ?? 0) + row.total);
    }
  }
  return [...counts].map(([org, total]) => ({ org, total })).sort((a, b) => a.org.localeCompare(b.org));
}

// How many decisions and roadmap items an org still owns, per table and only where there is any.
function orgRowCounts(env, name) {
  if (!existsSync(dbPath(env))) return [];
  const db = openDb(env);
  return ORG_TABLES.map((table) => ({
    table,
    total: db.prepare(`SELECT COUNT(*) AS total FROM ${table} WHERE scope = 'org' AND org = ?`).get(name).total,
  })).filter((entry) => entry.total > 0);
}

// Formats the connection slots of an org for the text output.
function formatSlots(connections) {
  return Object.entries(connections)
    .map(([type, name]) => `${type}=${name ?? "-"}`)
    .join(" ");
}

// Formats one line of `org list`.
function formatOrg(org) {
  const marker = org.isDefault ? "*" : " ";
  return `${marker} ${org.name}  ${org.displayName}  ${formatSlots(org.connections)}  projects=${org.projects}`;
}

// Runs `org add`.
async function runAdd(argv, ctx) {
  const { values, positionals } = parseCommand(argv, { "display-name": { type: "string" } });
  checkArgs(positionals, { min: 1, usage: 'nightshift org add <name> [--display-name "..."]' });
  const name = positionals[0];
  const config = addOrg(loadConfig(ctx.env, { warn: ctx.err }), name, { displayName: values["display-name"] });
  ctx.saveConfig(config, ctx.env);
  ctx.out(`created org \`${name}\` (${config.orgs[name].displayName})`);
}

// Runs `org list`.
async function runList(argv, ctx) {
  const { values, positionals } = parseCommand(argv, { json: { type: "boolean" } });
  checkArgs(positionals, { max: 0, usage: "nightshift org list [--json]" });
  const config = loadConfig(ctx.env, { warn: ctx.err });
  const orgs = listOrgs(config);
  if (values.json) {
    ctx.out(JSON.stringify({ defaultOrg: config.defaultOrg, orgs }));
    return;
  }
  for (const org of orgs) ctx.out(formatOrg(org));
}

// Refuses to touch the orgs while a rename is still in flight: `org repair` settles it first.
function refuseWhilePending(env) {
  const pending = readPendingRename(env);
  if (!pending) return;
  const which = pending.from ? `from \`${pending.from}\` to \`${pending.to}\`` : "of unknown names";
  throw new UserError(`an org rename ${which} was interrupted; run \`nightshift org repair\` before changing the orgs`);
}

// Runs `org rename` in three steps with the intent recorded first: the rows move, then the config write commits the new
// name, then the record goes. A crash anywhere leaves a record that `org repair` settles in the direction the config says;
// a database write that fails leaves nothing changed, so the record goes at once.
async function runRename(argv, ctx) {
  const { positionals } = parseCommand(argv);
  checkArgs(positionals, { min: 2, usage: "nightshift org rename <old> <new>" });
  const [oldName, newName] = positionals;
  refuseWhilePending(ctx.env);
  const config = renameOrg(loadConfig(ctx.env, { warn: ctx.err }), oldName, newName);
  writePendingRename(ctx.env, oldName, newName);
  try {
    renameOrgRows(ctx.env, oldName, newName);
  } catch (err) {
    clearPendingRename(ctx.env);
    throw err;
  }
  ctx.saveConfig(config, ctx.env);
  clearPendingRename(ctx.env);
  ctx.out(`renamed org \`${oldName}\` to \`${newName}\``);
}

// Settles a rename in flight: the config is the commit point, so rows follow the name it holds - forward when the new name
// is there, back when only the old one is. Idempotent: rows already where they belong are simply not matched.
function settlePendingRename(ctx, pending) {
  const config = loadConfig(ctx.env, { warn: ctx.err });
  if (pending.from === null) {
    throw new UserError(`the rename record at ${orgRenamePendingPath(ctx.env)} is unreadable; fix or remove it by hand, then run \`nightshift org repair\` again`);
  }
  if (getOrg(config, pending.to)) {
    renameOrgRows(ctx.env, pending.from, pending.to);
    clearPendingRename(ctx.env);
    return `finished the rename of org \`${pending.from}\` to \`${pending.to}\``;
  }
  if (getOrg(config, pending.from)) {
    renameOrgRows(ctx.env, pending.to, pending.from);
    clearPendingRename(ctx.env);
    return `rolled back the rename of org \`${pending.from}\` to \`${pending.to}\`; the org is still \`${pending.from}\``;
  }
  throw new UserError(`neither \`${pending.from}\` nor \`${pending.to}\` exists in the config; add one of them back with \`nightshift org add\`, then run \`nightshift org repair\` again`);
}

// Moves every orphan org row under one existing org, the only repair that needs the operator to name a destination.
function adoptOrphans(ctx, orphans, target) {
  const config = loadConfig(ctx.env, { warn: ctx.err });
  if (!getOrg(config, target)) throw new UserError(`unknown org \`${target}\`; create it first with \`nightshift org add ${target}\``);
  for (const orphan of orphans) renameOrgRows(ctx.env, orphan.org, target);
  return `moved ${orphans.map((o) => `${o.total} row(s) of \`${o.org}\``).join(", ")} to org \`${target}\``;
}

// Runs `org repair`: settles an interrupted rename by itself, and moves orphan rows only where `--to` says.
async function runRepair(argv, ctx) {
  const { values, positionals } = parseCommand(argv, { to: { type: "string" } });
  checkArgs(positionals, { max: 0, usage: "nightshift org repair [--to <org>]" });
  const pending = readPendingRename(ctx.env);
  if (pending) ctx.out(settlePendingRename(ctx, pending));
  const orphans = orphanOrgRows(ctx.env, loadConfig(ctx.env, { warn: ctx.err }));
  if (!orphans.length) {
    if (!pending) ctx.out("nothing to repair: every org row has its org");
    return;
  }
  if (typeof values.to !== "string" || !values.to) {
    const detail = orphans.map((o) => `${o.total} row(s) point to unknown org \`${o.org}\``).join("; ");
    throw new UserError(`${detail}; move them with \`nightshift org repair --to <org>\` or recreate the org with \`nightshift org add <name>\``);
  }
  ctx.out(adoptOrphans(ctx, orphans, values.to));
}

// Runs `org remove`.
async function runRemove(argv, ctx) {
  const { positionals } = parseCommand(argv);
  checkArgs(positionals, { min: 1, usage: "nightshift org remove <name>" });
  const name = positionals[0];
  refuseWhilePending(ctx.env);
  const config = removeOrg(loadConfig(ctx.env, { warn: ctx.err }), name);
  const owned = orgRowCounts(ctx.env, name);
  if (owned.length) {
    const detail = owned.map((entry) => `${entry.total} ${entry.table.replace("_", " ")}`).join(", ");
    throw new UserError(`cannot remove org \`${name}\`: it still owns ${detail}; move or drop them first`);
  }
  ctx.saveConfig(config, ctx.env);
  ctx.out(`removed org \`${name}\``);
}

const SUBCOMMANDS = new Map([
  ["add", runAdd],
  ["list", runList],
  ["rename", runRename],
  ["remove", runRemove],
  ["repair", runRepair],
]);

// Dispatches the subcommands of `nightshift org`.
export async function run(argv, ctx) {
  const [sub, ...rest] = argv;
  const handler = SUBCOMMANDS.get(sub);
  if (!handler) {
    throw new UserError(`unknown org subcommand \`${sub ?? ""}\`; use: ${[...SUBCOMMANDS.keys()].join(", ")}`);
  }
  await handler(rest, ctx);
}
