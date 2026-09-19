import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { UserError } from "../config/errors.mjs";
import { requireOrg } from "../config/orgs.mjs";
import { dbPath } from "../config/paths.mjs";
import { projectByName, resolveProject } from "../config/projects.mjs";
import { loadConfig } from "../config/store.mjs";
import { paddedNumber, parseDecisionFile, pointerLine, renderDecisionFile, slugOf, stampPointer } from "../memory/decision-file.mjs";
import { DECISION_STATUSES, decisionView, renderDecisionText } from "../memory/decisions.mjs";
import { sqliteToIso } from "../memory/schema.mjs";
import { SCOPE_CONFLICT, ownerLabel, ownerOf, ownerRef } from "../memory/scope.mjs";
import { callerJobId } from "../queue/retry.mjs";
import { openStore, openStoreReadOnly } from "../store/open.mjs";
import { checkArgs, parseCommand } from "./args.mjs";

const USAGE = {
  list: "nightshift decision list [--project <name> | --org <name>] [--status <status>] [--json]",
  show: "nightshift decision show <number> [--project <name> | --org <name>]",
  export: "nightshift decision export <number> [--project <name> | --org <name>] [--dir <path>] [--force]",
  import:
    "nightshift decision import <file.md> [--project <name> | --org <name>] [--status <status>] [--superseded-by <n>] [--supersedes <n,...>] [--unrelated <n,...>]",
};

const OWNER_OPTIONS = {
  project: { type: "string" },
  org: { type: "string" },
};

const EXPORT_OPTIONS = {
  ...OWNER_OPTIONS,
  dir: { type: "string" },
  force: { type: "boolean" },
};

const IMPORT_OPTIONS = {
  ...OWNER_OPTIONS,
  status: { type: "string" },
  "superseded-by": { type: "string" },
  supersedes: { type: "string" },
  unrelated: { type: "string" },
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
export async function readOnlyQuery(ctx, query, empty) {
  const path = dbPath(ctx.env);
  if (!existsSync(path)) return empty;
  let store = null;
  try {
    store = openStoreReadOnly(ctx.env);
    await store.migrateIfOutdated();
    return await query(store);
  } catch (err) {
    if (err instanceof UserError) throw err;
    throw new UserError(`cannot read the memory database at ${path}: ${err?.message ?? String(err)}`);
  } finally {
    await store?.close();
  }
}

// Requires a status of the decision enum, naming every accepted value.
function requireStatusOption(status) {
  if (status === undefined || DECISION_STATUSES.includes(status)) return status;
  throw new UserError(`invalid \`--status\`: \`${status}\`; expected one of ${DECISION_STATUSES.join("|")}`);
}

// Requires the positional `<number>` to be a positive integer, so a typo never reads as decision #NaN.
function requireNumber(raw, usage = USAGE.show) {
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new UserError(`\`<number>\` expects a positive integer, got \`${raw}\`; usage: ${usage}`);
  }
  return parsed;
}

// Requires a flag to carry one positive integer decision number.
function requireNumberFlag(flag, raw) {
  const text = String(raw).trim();
  if (/^[1-9]\d*$/.test(text)) return Number(text);
  throw new UserError(`\`--${flag}\` expects a positive integer decision number, got \`${raw}\``);
}

// Decision numbers of a comma-separated flag; an absent flag names none.
function numberListFlag(flag, raw) {
  if (raw === undefined) return [];
  const parts = String(raw).split(",").map((part) => part.trim()).filter(Boolean);
  if (!parts.length) throw new UserError(`\`--${flag}\` expects decision numbers like \`3,7\`, got \`${raw}\``);
  return parts.map((part) => requireNumberFlag(flag, part));
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
  const rows = await readOnlyQuery(ctx, (store) => store.decisions.listDecisions({ ...owner, status }), []);
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
  const row = await readOnlyQuery(ctx, (store) => store.decisions.getDecisionByNumber({ ...ownerRef(target), number }), null);
  if (!row) throw new UserError(`unknown decision #${number} for ${target.label}`);
  ctx.out(renderDecisionText(row));
  ctx.out(`${target.scope}: ${ownerOf(target)} · updated: ${sqliteToIso(row.updated_at)}`);
}

// Label of the decision that replaced a row, or null when nothing did.
function successorLabel(row) {
  return row.superseded_by_number ? ownerLabel({ ...row, number: row.superseded_by_number }) : null;
}

// Path `export` writes a decision to: `--dir`, or the decisions folder under `docs` of the current directory.
function exportPath(row, values, ctx) {
  const cwd = ctx.cwd ?? process.cwd();
  const dir = values.dir === undefined ? join(cwd, "docs", "decisions") : resolve(cwd, values.dir);
  return join(dir, `${paddedNumber(row.number)}-${slugOf(row.title)}.md`);
}

// Writes an exported file, refusing to replace an existing one unless forced.
function writeExportedFile(path, text, force) {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text, { flag: force ? "w" : "wx" });
  } catch (err) {
    if (err?.code === "EEXIST") throw new UserError(`${path} already exists; pass --force to overwrite it`);
    throw new UserError(`cannot write ${path}: ${err?.message ?? String(err)}`);
  }
}

// Runs `nightshift decision export <number>`, which writes one markdown file and never the database.
async function runExport(argv, ctx) {
  const { values, positionals } = parseCommand(argv, EXPORT_OPTIONS);
  checkArgs(positionals, { min: 1, max: 1, usage: USAGE.export });
  const target = resolveReadTarget(values, ctx);
  const number = requireNumber(positionals[0], USAGE.export);
  const row = await readOnlyQuery(ctx, (store) => store.decisions.getDecisionByNumber({ ...ownerRef(target), number }), null);
  if (!row) throw new UserError(`unknown decision #${number} for ${target.label}`);
  const path = exportPath(row, values, ctx);
  writeExportedFile(path, renderDecisionFile(row, { successorLabel: successorLabel(row) }), values.force === true);
  ctx.out(path);
}

// Text of the file to import, or a clear refusal naming it.
function readImportedFile(path) {
  try {
    return readFileSync(path, "utf8");
  } catch (err) {
    throw new UserError(`cannot read ${path}: ${err?.message ?? String(err)}`);
  }
}

// Status and successor of an imported row: `--superseded-by` implies `superseded`, `--status` wins over the file's `Status:`.
function importStatus(values, parsed) {
  const flagged = requireStatusOption(values.status);
  const successorFlag = values["superseded-by"] === undefined ? null : requireNumberFlag("superseded-by", values["superseded-by"]);
  if (successorFlag !== null && flagged !== undefined && flagged !== "superseded") {
    throw new UserError(`\`--superseded-by\` makes the decision \`superseded\`; it conflicts with \`--status ${flagged}\``);
  }
  const status = successorFlag !== null ? "superseded" : (flagged ?? parsed.status);
  if (!status) {
    throw new UserError(`the file has no \`Status:\` line naming one of ${DECISION_STATUSES.join("|")}; pass --status <status>`);
  }
  if (status !== "superseded") return { status, supersededBy: null };
  const supersededBy = successorFlag ?? parsed.successor?.number ?? null;
  if (supersededBy === null) {
    throw new UserError("a `superseded` decision needs the decision that replaced it: pass --superseded-by <number>");
  }
  return { status, supersededBy };
}

// Refuses a file whose pointer already names an existing row of this owner, so a re-run imports nothing twice.
async function refuseAlreadyImported(store, target, pointer) {
  if (!pointer || pointer.owner !== ownerOf(target)) return;
  if (pointer.label !== ownerLabel({ ...target, number: pointer.number })) return;
  const row = await store.decisions.getDecisionByNumber({ ...ownerRef(target), number: pointer.number });
  if (row) throw new UserError(`already imported as ${ownerLabel(row)} (${row.title}); nothing imported`);
}

// The refusal of an import that overlaps decisions nobody named, listing each one and how to re-run.
function needsReviewMessage(candidates) {
  const lines = (Array.isArray(candidates) ? candidates : []).map((row) => `  ${row.label} ${row.title} (${row.status})`);
  return [
    "the decision overlaps decisions of its owner that the import did not name; nothing imported:",
    ...lines,
    "re-run naming every one: --supersedes <n,...> for the ones it replaces whole, --unrelated <n,...> for the ones it leaves untouched",
  ].join("\n");
}

// Writes the pointer of the imported row into the file; a failure only warns, because the row is already saved.
function stampImportedFile(ctx, path, saved) {
  const label = ownerLabel(saved);
  const owner = ownerOf(saved);
  try {
    const text = readFileSync(path, "utf8");
    const stamped = stampPointer(text, label, owner);
    if (stamped !== text) writeFileSync(path, stamped);
  } catch (err) {
    ctx.err(`warning: ${path} was not stamped (${err?.message ?? String(err)}); add this line under its title by hand: ${pointerLine(label, owner)}`);
  }
}

// Runs `nightshift decision import <file.md>`, the one deliberate decision write of the terminal, reviewed like `decision_save`.
async function runImport(argv, ctx) {
  const { values, positionals } = parseCommand(argv, IMPORT_OPTIONS);
  checkArgs(positionals, { min: 1, max: 1, usage: USAGE.import });
  const target = resolveReadTarget(values, ctx);
  const path = resolve(ctx.cwd ?? process.cwd(), positionals[0]);
  const parsed = parseDecisionFile(readImportedFile(path), path);
  const { status, supersededBy } = importStatus(values, parsed);
  const supersedes = numberListFlag("supersedes", values.supersedes);
  const unrelated = numberListFlag("unrelated", values.unrelated);
  const store = openStore(ctx.env);
  await refuseAlreadyImported(store, target, parsed.pointer);
  const saved = await store.decisions.saveReviewedDecision({
    ...ownerRef(target),
    title: parsed.title,
    context: parsed.context,
    decision: parsed.decision,
    consequences: parsed.consequences,
    status,
    supersededBy,
    supersedes,
    unrelated,
    createdAt: parsed.date,
    jobId: callerJobId(ctx.env),
  });
  if (saved.needsReview) throw new UserError(needsReviewMessage(saved.candidates));
  ctx.out(`imported as ${ownerLabel(saved)}`);
  stampImportedFile(ctx, path, saved);
}

const SUBCOMMANDS = new Map([
  ["list", runList],
  ["show", runShow],
  ["export", runExport],
  ["import", runImport],
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
