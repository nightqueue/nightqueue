import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { UserError } from "../config/errors.mjs";
import { requireOrg } from "../config/orgs.mjs";
import { dbPath } from "../config/paths.mjs";
import { paddedNumber, parseDecisionFile, pointerLine, renderDecisionFile, slugOf, stampPointer } from "../memory/decision-file.mjs";
import { DECISION_STATUSES, decisionView, renderDecisionText } from "../memory/decisions.mjs";
import { sqliteToIso } from "../memory/schema.mjs";
import { parseRef } from "../memory/refs.mjs";
import { SCOPE_CONFLICT, decisionRef, orgTargetOf, ownerNames, ownerOf, ownerRef, ownerValues, projectTargetOf, rowOwner, targetDecisionRef } from "../memory/scope.mjs";
import { callerJobId } from "../queue/retry.mjs";
import { openRegistryReader, openStore, openStoreReadOnly } from "../store/open.mjs";
import { checkArgs, parseCommand } from "./args.mjs";

export const USAGE = {
  list: "nightqueue decision list [--project <name> | --org <name>] [--status <status>] [--json]",
  show: "nightqueue decision show <number|ref> [--project <name> | --org <name>]",
  export: "nightqueue decision export <number|ref> [--project <name> | --org <name>] [--dir <path>] [--force]",
  import:
    "nightqueue decision import <file.md> [--project <name> | --org <name>] [--status <status>] [--superseded-by <n|ref>] [--supersedes <n|ref,...>] [--unrelated <n|ref,...>]",
  update:
    "nightqueue decision update <number|ref> --status accepted|rejected|superseded [--superseded-by <n|ref>] [--project <name> | --org <name>]",
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

const UPDATE_OPTIONS = {
  ...OWNER_OPTIONS,
  status: { type: "string" },
  "superseded-by": { type: "string" },
};

const UPDATABLE_STATUSES = ["accepted", "rejected", "superseded"];

const READ_OPTIONS = {
  project: { type: "string" },
  org: { type: "string" },
  status: { type: "string" },
  json: { type: "boolean" },
};

const NUMBER_WIDTH = 16;
const STATUS_WIDTH = 12;
const DATE_WIDTH = 12;

// Target of a registered project, with the label every message of these commands names it by.
function projectTarget(project) {
  return { ...projectTargetOf(project), label: `\`${project.name}\`` };
}

// Owner a read-only command runs against: `--org`, the `--project` NAME, or the project of the current directory.
export async function resolveReadTarget(values, ctx) {
  if (values.project !== undefined && values.org !== undefined) throw new UserError(SCOPE_CONFLICT);
  const store = await openRegistryReader(ctx.env);
  if (values.org !== undefined) {
    const org = await requireOrg(store, values.org);
    return { ...orgTargetOf(org), label: `org \`${org.name}\`` };
  }
  if (values.project !== undefined) {
    const named = store ? await store.projects.byName(values.project) : null;
    if (named) return projectTarget(named);
    throw new UserError(`unknown project \`${values.project}\`; run \`nightqueue project list\``);
  }
  const cwd = ctx.cwd ?? process.cwd();
  const resolved = store ? await store.projects.at(cwd) : null;
  if (resolved) return projectTarget(resolved);
  throw new UserError(`no project registered for ${cwd}; run \`nightqueue init\` here, or pass --project <name>`);
}

// Reads the database on a connection that can never write a decision nor an issue; a home with no database yet reads as an empty one, and one written by an older build is refused with the `nightqueue update` message.
export async function readOnlyQuery(ctx, query, empty) {
  const path = dbPath(ctx.env);
  if (!existsSync(path)) return empty;
  let store = null;
  try {
    store = openStoreReadOnly(ctx.env);
    await store.requireCurrentSchema();
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

// Requires a flag to carry one decision number or decision ref, kept as text for the owner to resolve.
function requireDecisionFlag(flag, raw) {
  const text = String(raw).trim();
  if (/^[1-9]\d*$/.test(text) || parseRef(text)?.kind === "decision") return text;
  throw new UserError(`\`--${flag}\` expects a decision number or ref (\`3\`, \`D-3\`, \`<KEY>/D-3\`), got \`${raw}\``);
}

// Decision numbers or refs of a comma-separated flag; an absent flag names none.
function decisionListFlag(flag, raw) {
  if (raw === undefined) return [];
  const parts = String(raw).split(",").map((part) => part.trim()).filter(Boolean);
  if (!parts.length) throw new UserError(`\`--${flag}\` expects decision numbers or refs like \`3,D-7\`, got \`${raw}\``);
  return parts.map((part) => requireDecisionFlag(flag, part));
}

// Where a positional decision lives: a plain number or `D-<n>` in the owner of the flags (or of the cwd), `<KEY>/D-<n>` in its key's owner.
async function decisionAddress(raw, values, ctx, usage) {
  const ref = parseRef(raw);
  const flagged = values.project !== undefined || values.org !== undefined;
  if (ref?.kind === "decision" && ref.key !== null) {
    return { qualified: true, raw: String(raw).trim(), target: flagged ? await resolveReadTarget(values, ctx) : null };
  }
  const number = ref?.kind === "decision" ? ref.number : requireNumber(raw, usage);
  return { qualified: false, number, target: await resolveReadTarget(values, ctx) };
}

// The owner a decision row is shown under, with the label every message of these commands names it by.
function rowTargetOf(row) {
  const owner = rowOwner(row);
  const label = owner.scope === "org" ? `org \`${owner.org}\`` : `\`${owner.project ?? "global"}\``;
  return { ...owner, label };
}

// Tells whether two targets name the same owner.
function sameTarget(a, b) {
  return ownerValues(a).every((value, index) => value === ownerValues(b)[index]);
}

// The refusal of a decision an address names but the database does not hold.
function unknownDecision(address) {
  if (address.qualified) return new UserError(`unknown decision \`${address.raw}\``);
  return new UserError(`unknown decision ${targetDecisionRef(address.target, address.number)} for ${address.target.label}`);
}

// The decision row an address names and the owner it is shown under; a qualified ref beside a flag naming another owner is refused.
async function findDecision(store, address) {
  if (!address.qualified) {
    const row = await store.decisions.getDecisionByNumber({ ...ownerRef(address.target), number: address.number });
    if (!row) throw unknownDecision(address);
    return { row, target: address.target };
  }
  const row = await store.decisions.decisionOfRef(address.raw);
  const target = rowTargetOf(row);
  if (address.target !== null && !sameTarget(address.target, target)) {
    throw new UserError(`\`${address.raw}\` is a decision of ${target.label}, not of ${address.target.label}; drop --project/--org`);
  }
  return { row, target };
}

// Reads the decision a positional names on a read-only connection; a home with no database names none.
async function readDecision(ctx, address) {
  const found = await readOnlyQuery(ctx, (store) => findDecision(store, address), null);
  if (!found) throw unknownDecision(address);
  return found;
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
    cell(row.ref, NUMBER_WIDTH),
    cell(row.status, STATUS_WIDTH),
    cell(shortDate(row.updated_at), DATE_WIDTH),
    String(row.title ?? "").replace(/\s+/g, " ").trim(),
  ].join("");
}

// Runs `nightqueue decision list`, which reads the database and never writes to it.
async function runList(argv, ctx) {
  const { values, positionals } = parseCommand(argv, READ_OPTIONS);
  checkArgs(positionals, { max: 0, usage: USAGE.list });
  const target = await resolveReadTarget(values, ctx);
  const owner = ownerRef(target);
  const status = requireStatusOption(values.status);
  const rows = await readOnlyQuery(ctx, (store) => store.decisions.listDecisions({ ...owner, status }), []);
  const decisions = rows.map(decisionView);
  if (values.json) {
    ctx.out(JSON.stringify({ ...ownerNames(target), decisions }));
    return;
  }
  if (!decisions.length) {
    ctx.out(`no decisions for ${target.label}`);
    return;
  }
  ctx.out(header());
  for (const row of decisions) ctx.out(formatRow(row));
}

// Prints a decision row in full, the way `show` and `update` both answer it.
function printDecision(ctx, target, row) {
  ctx.out(renderDecisionText(row));
  ctx.out(`${target.scope}: ${ownerOf(target)} · updated: ${sqliteToIso(row.updated_at)}`);
}

// Runs `nightqueue decision show <number>`, printing the decision in full and untruncated.
async function runShow(argv, ctx) {
  const { values, positionals } = parseCommand(argv, { project: { type: "string" }, org: { type: "string" } });
  checkArgs(positionals, { min: 1, max: 1, usage: USAGE.show });
  const { row, target } = await readDecision(ctx, await decisionAddress(positionals[0], values, ctx, USAGE.show));
  printDecision(ctx, target, row);
}

// Label of the decision that replaced a row, or null when nothing did.
function successorLabel(row) {
  return row.superseded_by_number ? decisionRef({ ...row, number: row.superseded_by_number }) : null;
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

// Runs `nightqueue decision export <number>`, which writes one markdown file and never the database.
async function runExport(argv, ctx) {
  const { values, positionals } = parseCommand(argv, EXPORT_OPTIONS);
  checkArgs(positionals, { min: 1, max: 1, usage: USAGE.export });
  const { row } = await readDecision(ctx, await decisionAddress(positionals[0], values, ctx, USAGE.export));
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
  const successorFlag = values["superseded-by"] === undefined ? null : requireDecisionFlag("superseded-by", values["superseded-by"]);
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
  if ((pointer.qualifier !== null) !== (target.scope === "org")) return;
  const row = await store.decisions.getDecisionByNumber({ ...ownerRef(target), number: pointer.number });
  if (row) throw new UserError(`already imported as ${decisionRef(row)} (${row.title}); nothing imported`);
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
  const label = saved.ref;
  const owner = ownerOf(saved);
  try {
    const text = readFileSync(path, "utf8");
    const stamped = stampPointer(text, label, owner);
    if (stamped !== text) writeFileSync(path, stamped);
  } catch (err) {
    ctx.err(`warning: ${path} was not stamped (${err?.message ?? String(err)}); add this line under its title by hand: ${pointerLine(label, owner)}`);
  }
}

// Runs `nightqueue decision import <file.md>`, the one deliberate decision write of the terminal, reviewed like `decision_save`.
async function runImport(argv, ctx) {
  const { values, positionals } = parseCommand(argv, IMPORT_OPTIONS);
  checkArgs(positionals, { min: 1, max: 1, usage: USAGE.import });
  const target = await resolveReadTarget(values, ctx);
  const path = resolve(ctx.cwd ?? process.cwd(), positionals[0]);
  const parsed = parseDecisionFile(readImportedFile(path), path);
  const { status, supersededBy: successor } = importStatus(values, parsed);
  const supersedesFlag = decisionListFlag("supersedes", values.supersedes);
  const unrelatedFlag = decisionListFlag("unrelated", values.unrelated);
  const store = openStore(ctx.env);
  const owner = ownerRef(target);
  const [supersededBy] = successor === null ? [null] : await store.decisions.ownDecisionNumbers([successor], owner);
  const supersedes = await store.decisions.ownDecisionNumbers(supersedesFlag, owner);
  const unrelated = await store.decisions.ownDecisionNumbers(unrelatedFlag, owner);
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
  ctx.out(`imported as ${saved.ref}`);
  stampImportedFile(ctx, path, saved);
}

// Requires `--status`/`--superseded-by` to agree: `superseded` needs a successor, no other status names one.
function requireUpdateTransition(values) {
  const status = values.status;
  if (status === undefined || !UPDATABLE_STATUSES.includes(status)) {
    throw new UserError(`invalid \`--status\`: \`${status}\`; expected one of ${UPDATABLE_STATUSES.join("|")}`);
  }
  const successorFlag = values["superseded-by"];
  if (status !== "superseded" && successorFlag !== undefined) {
    throw new UserError(`\`--superseded-by\` makes the decision \`superseded\`; it conflicts with \`--status ${status}\``);
  }
  if (status === "superseded" && successorFlag === undefined) {
    throw new UserError("a `superseded` decision needs the decision that replaced it: pass --superseded-by <number>");
  }
  return { status, successor: successorFlag === undefined ? null : requireDecisionFlag("superseded-by", successorFlag) };
}

// The id of the successor row `--superseded-by` names: a number of the updated decision's owner, or a ref read in that owner's context.
async function resolveSuccessorId(store, target, successor) {
  if (successor === null) return null;
  if (parseRef(successor)?.kind === "decision") {
    return await store.decisions.decisionIdOfRef(successor, { projectId: target.scope === "project" ? target.projectId : null });
  }
  const number = Number(successor);
  const row = await store.decisions.getDecisionByNumber({ ...ownerRef(target), number });
  if (!row) throw new UserError(`unknown decision ${targetDecisionRef(target, number)} for ${target.label}`);
  return row.id;
}

// Runs `nightqueue decision update <number>`, the terminal's way to accept, reject or supersede a decision, same as `decision_update`.
async function runUpdate(argv, ctx) {
  const { values, positionals } = parseCommand(argv, UPDATE_OPTIONS);
  checkArgs(positionals, { min: 1, max: 1, usage: USAGE.update });
  const address = await decisionAddress(positionals[0], values, ctx, USAGE.update);
  const { status, successor } = requireUpdateTransition(values);
  const store = openStore(ctx.env);
  const { row, target } = await findDecision(store, address);
  const superseded_by = await resolveSuccessorId(store, target, successor);
  const updated = await store.decisions.updateDecision(row.id, { status, superseded_by });
  printDecision(ctx, target, updated);
}

const SUBCOMMANDS = new Map([
  ["list", runList],
  ["show", runShow],
  ["export", runExport],
  ["import", runImport],
  ["update", runUpdate],
]);

export const SUBCOMMAND_NAMES = Object.freeze([...SUBCOMMANDS.keys()]);

// Dispatches the subcommands of `nightqueue decision`.
export async function run(argv, ctx) {
  const [sub, ...rest] = argv;
  const handler = SUBCOMMANDS.get(sub);
  if (!handler) {
    throw new UserError(`unknown decision subcommand \`${sub ?? ""}\`; use: ${[...SUBCOMMANDS.keys()].join(", ")}`);
  }
  await handler(rest, ctx);
}
