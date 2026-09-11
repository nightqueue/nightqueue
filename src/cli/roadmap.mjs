import { emptyRoadmap, listRoadmap } from "../memory/roadmap.mjs";
import { checkArgs, parseCommand } from "./args.mjs";
import { readOnlyQuery, resolveReadProject } from "./decision.mjs";

const USAGE = "nightshift roadmap [--project <name>] [--json]";

// Collapses the whitespace of operator free text, so a multi-line title never breaks the listing.
function oneLine(text) {
  return String(text ?? "").replace(/\s+/g, " ").trim();
}

// Lines of one roadmap item: the intent first, its links indented under it.
function itemLines(item) {
  const lines = [`  ${item.position}. ${oneLine(item.title)}  [${item.status}]`];
  if (item.decision_number !== null) lines.push(`     decision #${item.decision_number}`);
  if (item.job_id !== null) lines.push(`     job #${item.job_id} (${item.job_status ?? "unknown"})`);
  return lines;
}

// Lines of one horizon: its name and its items, or `(empty)` when nothing is planned there.
function horizonLines(group) {
  if (!group.items.length) return [`${group.horizon}:`, "  (empty)"];
  return [`${group.horizon}:`, ...group.items.flatMap(itemLines)];
}

// Runs `nightshift roadmap`, which reads the database and never writes to it.
export async function run(argv, ctx) {
  const { values, positionals } = parseCommand(argv, { project: { type: "string" }, json: { type: "boolean" } });
  checkArgs(positionals, { max: 0, usage: USAGE });
  const project = resolveReadProject(values, ctx);
  const roadmap = readOnlyQuery(ctx, (db) => listRoadmap(project, ctx.env, db), emptyRoadmap(project));
  if (values.json) {
    ctx.out(JSON.stringify(roadmap));
    return;
  }
  for (const group of roadmap.horizons) for (const line of horizonLines(group)) ctx.out(line);
}
