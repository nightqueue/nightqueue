import { existsSync } from "node:fs";
import { UserError } from "../config/errors.mjs";
import { requireOrg } from "../config/orgs.mjs";
import { dbPath } from "../config/paths.mjs";
import { projectByName, resolveProject } from "../config/projects.mjs";
import { loadConfig } from "../config/store.mjs";
import { migrateIfOutdated, openDbReadOnly, sqliteToIso } from "../memory/db.mjs";
import { DECISION_STATUSES, decisionView, getDecisionByNumber, listDecisions, renderDecisionText } from "../memory/decisions.mjs";
import { SCOPE_CONFLICT, ownerLabel, ownerOf, ownerRef } from "../memory/scope.mjs";
import { checkArgs, parseCommand } from "./args.mjs";

const USAGE = {
  list: "nightshift decision list [--project <name> | --org <name>] [--status <status>] [--json]",
  show: "nightshift decision show <number> [--project <name> | --org <name>]",
};

const READ_OPTIONS = {
  project: { type: "string" },
  org: { type: "string" },
  status: { type: "string" },
  json: { type: "boolean" },
};

const NUMBER_WIDTH = 16;
const STATUS_WIDTH = 12;
const DATE_WIDTH = 12;

// Owner triple of a registered project, with the label every message of these commands names it by.
function projectTarget(project) {
  return { scope: "project", project: project.name, org: project.org ?? null, label: `\`${project.name}\`` };
}

// Owner a read-only command runs against: `--org`, the `--project` NAME, or the project of the current directory.
export function resolveReadTarget(values, ctx) {
  const config = loadConfig(ctx.env, { warn: ctx.err });
  if (values.project !== undefined && values.org !== undefined) throw new UserError(SCOPE_CONFLICT);
  if (values.org !== undefined) {
    requireOrg(config, values.org);
    return { scope: "org", project: null, org: values.org, label: `org \`${values.org}\`` };
  }
  if (values.project !== undefined) {
    const named = projectByName(config, values.project);
    if (named) return projectTarget(named);
    throw new UserError(`unknown project \`${values.project}\`; run \`nightshift project list\``);
  }
  const cwd = ctx.cwd ?? process.cwd();
  const resolved = resolveProject(config, { cwd });
  if (resolved) return projectTarget(resolved);
  throw new UserError(`no project registered for ${cwd}; run \`nightshift init\` here, or pass --project <name>`);
}

// Reads the database on a connection that can never write a decision nor a roadmap item; a home with no database yet reads as an empty one, and one written by an older build is brought to this schema first.
export function readOnlyQuery(ctx, query, empty) {
  const path = dbPath(ctx.env);
  if (!existsSync(path)) return empty;
  let db = null;
  try {
    migrateIfOutdated(ctx.env);
    db = openDbReadOnly(ctx.env);
    return query(db);
  } catch (err) {
    if (err instanceof UserError) throw err;
    throw new UserError(`cannot read the memory database at ${path}: ${err?.message ?? String(err)}`);
  } finally {
    db?.close();
  }
}

// Requires a status of the decision enum, naming every accepted value.
function requireStatusOption(status) {
  if (status === undefined || DECISION_STATUSES.includes(status)) return status;
  throw new UserError(`invalid \`--status\`: \`${status}\`; expected one of ${DECISION_STATUSES.join("|")}`);
}

// Requires the positional `<number>` to be a positive integer, so a typo never reads as decision #NaN.
function requireNumber(raw) {
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new UserError(`\`<number>\` expects a positive integer, got \`${raw}\`; usage: ${USAGE.show}`);
  }
  return parsed;
}

// Date part of an ISO timestamp, the only precision the table has room for.
function shortDate(iso) {
  return typeof iso === "string" ? iso.slice(0, 10) : "-";
}

// One cell of the table: padded to its width, and never glued to the next one when the value is wider.
function cell(text, width) {
  return text.length < width ? text.padEnd(width) : `${text} `;
}

// Header of the table of `decision list`.
function header() {
  return [cell("NUMBER", NUMBER_WIDTH), cell("STATUS", STATUS_WIDTH), cell("UPDATED", DATE_WIDTH), "TITLE"].join("");
}

// One line of the table of `decision list`.
function formatRow(row) {
  return [
    cell(ownerLabel(row), NUMBER_WIDTH),
    cell(row.status, STATUS_WIDTH),
    cell(shortDate(row.updated_at), DATE_WIDTH),
    String(row.title ?? "").replace(/\s+/g, " ").trim(),
  ].join("");
}

// Runs `nightshift decision list`, which reads the database and never writes to it.
async function runList(argv, ctx) {
  const { values, positionals } = parseCommand(argv, READ_OPTIONS);
  checkArgs(positionals, { max: 0, usage: USAGE.list });
  const target = resolveReadTarget(values, ctx);
  const owner = ownerRef(target);
  const status = requireStatusOption(values.status);
  const rows = readOnlyQuery(ctx, (db) => listDecisions({ ...owner, status }, ctx.env, db), []);
  const decisions = rows.map(decisionView);
  if (values.json) {
    ctx.out(JSON.stringify({ ...owner, decisions }));
    return;
  }
  if (!decisions.length) {
    ctx.out(`no decisions for ${target.label}`);
    return;
  }
  ctx.out(header());
  for (const row of decisions) ctx.out(formatRow(row));
}

// Runs `nightshift decision show <number>`, printing the decision in full and untruncated.
async function runShow(argv, ctx) {
  const { values, positionals } = parseCommand(argv, { project: { type: "string" }, org: { type: "string" } });
  checkArgs(positionals, { min: 1, max: 1, usage: USAGE.show });
  const target = resolveReadTarget(values, ctx);
  const number = requireNumber(positionals[0]);
  const row = readOnlyQuery(ctx, (db) => getDecisionByNumber({ ...ownerRef(target), number }, ctx.env, db), null);
  if (!row) throw new UserError(`unknown decision #${number} for ${target.label}`);
  ctx.out(renderDecisionText(row));
  ctx.out(`${target.scope}: ${ownerOf(target)} · updated: ${sqliteToIso(row.updated_at)}`);
}

const SUBCOMMANDS = new Map([
  ["list", runList],
  ["show", runShow],
]);

// Dispatches the subcommands of `nightshift decision`.
export async function run(argv, ctx) {
  const [sub, ...rest] = argv;
  const handler = SUBCOMMANDS.get(sub);
  if (!handler) {
    throw new UserError(`unknown decision subcommand \`${sub ?? ""}\`; use: ${[...SUBCOMMANDS.keys()].join(", ")}`);
  }
  await handler(rest, ctx);
}
