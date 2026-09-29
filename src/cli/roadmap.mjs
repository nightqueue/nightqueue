import { UserError } from "../config/errors.mjs";
import { emptyRoadmap } from "../memory/roadmap.mjs";
import { ROADMAP_STATUSES } from "../memory/roadmap-workflow.mjs";
import { jobRef } from "../memory/refs.mjs";
import { ownerNames, ownerRef } from "../memory/scope.mjs";
import { checkArgs, parseCommand } from "./args.mjs";
import { readOnlyQuery, resolveReadTarget } from "./decision.mjs";

const USAGE = {
  list: "nightqueue roadmap [--project <name> | --org <name>] [--status <s>]... [--priority <n>]... [--type <t>]... [--json]",
  show: "nightqueue roadmap show <ref> [--json]",
};

// Collapses the whitespace of operator free text, so a multi-line title never breaks the listing.
function oneLine(text) {
  return String(text ?? "").replace(/\s+/g, " ").trim();
}

// One project row of an org item: the project, its status and the job that holds it.
function projectRowLine(row) {
  const job = row.job_id === null ? "" : ` ${jobRef(row.job_id)} (${row.job_status ?? "unknown"})`;
  return `     ${row.project}: ${row.status}${job}`;
}

// The matrix lines of an org item read by its org: one line per project row, or a note when no project was queued yet.
function matrixLines(item) {
  if (!Array.isArray(item.projects)) return [];
  return item.projects.length ? item.projects.map(projectRowLine) : ["     (not queued for any project)"];
}

// What a project listing shows beside an org item: the status of that project's own row.
function projectStatusMark(item) {
  return item.project_status ? ` (${item.project_status})` : "";
}

// Lines of one roadmap item: its priority and reference first, its links and project rows indented under it.
function itemLines(item) {
  const lines = [`  p${item.priority} ${item.ref} ${oneLine(item.title)}${projectStatusMark(item)}`];
  if (item.decision_number !== null) lines.push(`     decision ${item.decision_ref}`);
  if (item.job_id !== null) lines.push(`     ${jobRef(item.job_id)} (${item.job_status ?? "unknown"})`);
  return [...lines, ...matrixLines(item)];
}

// Lines of the whole listing, one heading per status that holds items, in workflow order.
function statusLines(items) {
  if (!items.length) return ["(empty)"];
  return ROADMAP_STATUSES.flatMap((status) => {
    const group = items.filter((item) => item.status === status);
    return group.length ? [`${status}:`, ...group.flatMap(itemLines)] : [];
  });
}

// The `--priority` values as integers, refusing a word that is not one.
function priorityFilter(values) {
  if (!values) return undefined;
  return values.map((value) => {
    const number = Number(value);
    if (!Number.isInteger(number)) throw new UserError(`invalid \`--priority\` \`${value}\`; expected an integer 1-9; usage: ${USAGE.list}`);
    return number;
  });
}

// The author of a comment as printed: `J-<id>` for a job, the stored value otherwise.
function authorLabel(author) {
  const job = /^job:(\d+)$/.exec(String(author ?? ""));
  return job ? jobRef(job[1]) : author;
}

// Lines of one comment: who wrote it, when and what kind, then its body indented.
function commentLines(comment) {
  const body = String(comment.body ?? "")
    .split("\n")
    .map((line) => `    ${line}`);
  return [`  ${comment.created_at ?? "?"} ${authorLabel(comment.author)} ${comment.kind}${comment.project ? ` (${comment.project})` : ""}`, ...body];
}

// Lines of one item read in full: its header, its text and its comment thread.
function detailLines(item) {
  const lines = [`${item.ref} [${item.type}] ${item.status} p${item.priority}`, item.title];
  if (item.detail) lines.push("", item.detail);
  if (item.decision_number !== null) lines.push("", `decision ${item.decision_ref}`);
  if (item.job_id !== null) lines.push(`${jobRef(item.job_id)} (${item.job_status ?? "unknown"})`);
  if (Array.isArray(item.projects)) lines.push("", "projects:", ...matrixLines(item).map((line) => line.slice(3)));
  lines.push("", "comments:");
  return item.comments.length ? [...lines, ...item.comments.flatMap(commentLines)] : [...lines, "  (none)"];
}

// Runs `nightqueue roadmap show <ref>`, which reads one item and its thread and never writes.
async function runShow(argv, ctx) {
  const { values, positionals } = parseCommand(argv, { json: { type: "boolean" } });
  checkArgs(positionals, { min: 1, max: 1, usage: USAGE.show });
  const ref = positionals[0];
  const item = await readOnlyQuery(ctx, async (store) => store.roadmap.getRoadmapItemDetail(await store.roadmap.itemIdOfRef(ref)), null);
  if (item === null) throw new UserError(`unknown roadmap item \`${ref}\``);
  if (values.json) {
    ctx.out(JSON.stringify(item));
    return;
  }
  for (const line of detailLines(item)) ctx.out(line);
}

// Runs `nightqueue roadmap`, which reads the database and never writes to it; `show <ref>` reads one item in full.
export async function run(argv, ctx) {
  if (argv[0] === "show") return await runShow(argv.slice(1), ctx);
  const { values, positionals } = parseCommand(argv, {
    project: { type: "string" },
    org: { type: "string" },
    status: { type: "string", multiple: true },
    priority: { type: "string", multiple: true },
    type: { type: "string", multiple: true },
    json: { type: "boolean" },
  });
  checkArgs(positionals, { max: 0, usage: USAGE.list });
  const target = await resolveReadTarget(values, ctx);
  const filters = { status: values.status, priority: priorityFilter(values.priority), type: values.type };
  const roadmap = await readOnlyQuery(
    ctx,
    (store) => store.roadmap.listRoadmap(ownerRef(target), filters),
    emptyRoadmap(ownerNames(target)),
  );
  if (values.json) {
    ctx.out(JSON.stringify(roadmap));
    return;
  }
  for (const line of statusLines(roadmap.items)) ctx.out(line);
}
