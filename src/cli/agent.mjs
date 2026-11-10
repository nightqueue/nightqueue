import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { UserError } from "../config/errors.mjs";
import { builtinAgents, userAgents, writeAgentSkeleton } from "../sessions/agents.mjs";
import { checkArgs, parseCommand } from "./args.mjs";

const USAGE = "nightqueue agent list [--json] | new <name> | show <name>";
const DESCRIPTION_CHARS = 100;

// The first characters of a description, on one line.
function shortDescription(text) {
  const line = String(text ?? "").replace(/\s+/g, " ").trim();
  return line.length > DESCRIPTION_CHARS ? `${line.slice(0, DESCRIPTION_CHARS - 1)}…` : line;
}

// Every agent a chat can run as, built-in first, plus the problem of each user file that is not valid.
function allAgents(env) {
  const { agents, invalid } = userAgents(env);
  return { agents: [...builtinAgents(), ...agents], invalid };
}

// Prints the built-in and user agents, warning about each user file that is not valid.
function listCommand(rest, ctx) {
  const { values, positionals } = parseCommand(rest, { json: { type: "boolean" } });
  checkArgs(positionals, { max: 0, usage: USAGE });
  const { agents, invalid } = allAgents(ctx.env);
  for (const entry of invalid) ctx.err(`nightqueue agent: warning: ${entry.error}`);
  const views = agents.map(({ name, description, source, path }) => ({ name, source, description, path }));
  if (values.json) return ctx.out(JSON.stringify(views, null, 2));
  for (const view of views) ctx.out(`${view.name} · ${view.source === "builtin" ? "built-in" : "user"} · ${shortDescription(view.description)}`);
}

// Writes the skeleton of a new user agent and says how to use it.
function newCommand(rest, ctx) {
  const [name] = checkArgs(parseCommand(rest).positionals, { min: 1, usage: USAGE });
  const path = writeAgentSkeleton(name, ctx.env);
  ctx.out(`created ${path}; edit it, then run \`nightqueue chat ${name}\``);
}

// Prints one agent's source, path and file.
function showCommand(rest, ctx) {
  const [name] = checkArgs(parseCommand(rest).positionals, { min: 1, usage: USAGE });
  const { agents, invalid } = allAgents(ctx.env);
  const agent = agents.find((entry) => entry.name === name);
  if (!agent) {
    const broken = invalid.find((entry) => basename(entry.path, ".md") === name);
    throw new UserError(broken ? `agent \`${name}\` is invalid: ${broken.error}` : `unknown agent \`${name}\`; run \`nightqueue agent list\` to see them`);
  }
  ctx.out(`${agent.name} · ${agent.source === "builtin" ? "built-in" : "user"} · ${agent.path}`);
  ctx.out(readFileSync(agent.path, "utf8"));
}

const SUBCOMMANDS = new Map([
  ["list", listCommand],
  ["new", newCommand],
  ["show", showCommand],
]);

// Dispatches `nightqueue agent list|new|show`.
export function run(argv, ctx) {
  const [sub, ...rest] = argv;
  const handler = SUBCOMMANDS.get(sub);
  if (!handler) throw new UserError(`unknown agent subcommand \`${sub ?? ""}\`; usage: ${USAGE}`);
  return handler(rest, ctx) ?? 0;
}
