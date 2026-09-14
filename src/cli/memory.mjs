import { UserError } from "../config/errors.mjs";
import { openStore } from "../store/open.mjs";
import { checkArgs, parseCommand } from "./args.mjs";

const COLUMNS = ["lessons", "memory", "index", "libs", "runs"];
const MIN_NAME_WIDTH = 24;
const COUNT_WIDTH = 9;
const EMPTY_ROW = { project: null, lessons: 0, memory: 0, index: 0, libs: 0, runs: 0 };

// Width of the project column: the longest name plus one space, never below the historical 24.
export function nameWidth(rows) {
  return Math.max(MIN_NAME_WIDTH, ...rows.map((row) => (row.project ?? "(global)").length + 1));
}

// Header of the table of `memory stats`.
function header(width) {
  return ["project".padEnd(width), ...COLUMNS.map((name) => name.padStart(COUNT_WIDTH))].join("");
}

// One line of the table of `memory stats`.
function formatRow(row, width) {
  const name = row.project ?? "(global)";
  return [name.padEnd(width), ...COLUMNS.map((key) => String(row[key] ?? 0).padStart(COUNT_WIDTH))].join("");
}

// Runs `nightshift memory stats`, which never fails on an empty or missing database.
async function runStats(argv, ctx) {
  const { values, positionals } = parseCommand(argv, { json: { type: "boolean" } });
  checkArgs(positionals, { max: 0, usage: "nightshift memory stats [--json]" });
  const projects = await openStore(ctx.env).lessons.memoryStats();
  if (values.json) {
    ctx.out(JSON.stringify({ projects }));
    return;
  }
  const rows = projects.length ? projects : [EMPTY_ROW];
  const width = nameWidth(rows);
  ctx.out(header(width));
  for (const row of rows) ctx.out(formatRow(row, width));
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
