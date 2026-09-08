import { UserError } from "../config/errors.mjs";
import { memoryStats } from "../memory/lessons.mjs";
import { checkArgs, parseCommand } from "./args.mjs";

const COLUMNS = ["lessons", "memory", "index", "libs", "runs"];
const NAME_WIDTH = 24;
const COUNT_WIDTH = 9;
const EMPTY_ROW = { project: null, lessons: 0, memory: 0, index: 0, libs: 0, runs: 0 };

// Header of the table of `memory stats`.
function header() {
  return ["project".padEnd(NAME_WIDTH), ...COLUMNS.map((name) => name.padStart(COUNT_WIDTH))].join("");
}

// One line of the table of `memory stats`.
function formatRow(row) {
  const name = row.project ?? "(global)";
  return [name.padEnd(NAME_WIDTH), ...COLUMNS.map((key) => String(row[key] ?? 0).padStart(COUNT_WIDTH))].join("");
}

// Runs `nightshift memory stats`, which never fails on an empty or missing database.
async function runStats(argv, ctx) {
  const { values, positionals } = parseCommand(argv, { json: { type: "boolean" } });
  checkArgs(positionals, { max: 0, usage: "nightshift memory stats [--json]" });
  const projects = memoryStats(ctx.env);
  if (values.json) {
    ctx.out(JSON.stringify({ projects }));
    return;
  }
  ctx.out(header());
  for (const row of projects.length ? projects : [EMPTY_ROW]) ctx.out(formatRow(row));
}

const SUBCOMMANDS = new Map([["stats", runStats]]);

// Dispatches the subcommands of `nightshift memory`.
export async function run(argv, ctx) {
  const [sub, ...rest] = argv;
  const handler = SUBCOMMANDS.get(sub);
  if (!handler) {
    throw new UserError(`unknown memory subcommand \`${sub ?? ""}\`; use: ${[...SUBCOMMANDS.keys()].join(", ")}`);
  }
  await handler(rest, ctx);
}
