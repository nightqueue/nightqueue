import { emptyRoadmap, listRoadmap } from "../memory/roadmap.mjs";
import { ownerPrefix, ownerRef } from "../memory/scope.mjs";
import { checkArgs, parseCommand } from "./args.mjs";
import { readOnlyQuery, resolveReadTarget } from "./decision.mjs";

const USAGE = "nightshift roadmap [--project <name> | --org <name>] [--json]";

// Collapses the whitespace of operator free text, so a multi-line title never breaks the listing.
function oneLine(text) {
  return String(text ?? "").replace(/\s+/g, " ").trim();
}

// Lines of one roadmap item: the intent first, its links indented under it.
function itemLines(item) {
  const lines = [`  ${ownerPrefix(item)}${item.position}. ${oneLine(item.title)}  [${item.status}]`];
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
  const { values, positionals } = parseCommand(argv, {
    project: { type: "string" },
    org: { type: "string" },
    json: { type: "boolean" },
  });
  checkArgs(positionals, { max: 0, usage: USAGE });
  const owner = ownerRef(resolveReadTarget(values, ctx));
  const roadmap = readOnlyQuery(ctx, (db) => listRoadmap(owner, ctx.env, db), emptyRoadmap(owner));
  if (values.json) {
    ctx.out(JSON.stringify(roadmap));
    return;
  }
  for (const group of roadmap.horizons) for (const line of horizonLines(group)) ctx.out(line);
}
