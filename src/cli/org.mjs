import { existsSync } from "node:fs";
import { UserError } from "../config/errors.mjs";
import { addOrg, listOrgs, removeOrg, renameOrg } from "../config/orgs.mjs";
import { dbPath } from "../config/paths.mjs";
import { loadConfig } from "../config/store.mjs";
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

// Runs `org rename`: the rows move first and the config write is the commit point, so a failed database write leaves the old name working end to end.
async function runRename(argv, ctx) {
  const { positionals } = parseCommand(argv);
  checkArgs(positionals, { min: 2, usage: "nightshift org rename <old> <new>" });
  const [oldName, newName] = positionals;
  const config = renameOrg(loadConfig(ctx.env, { warn: ctx.err }), oldName, newName);
  renameOrgRows(ctx.env, oldName, newName);
  ctx.saveConfig(config, ctx.env);
  ctx.out(`renamed org \`${oldName}\` to \`${newName}\``);
}

// Runs `org remove`.
async function runRemove(argv, ctx) {
  const { positionals } = parseCommand(argv);
  checkArgs(positionals, { min: 1, usage: "nightshift org remove <name>" });
  const name = positionals[0];
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
