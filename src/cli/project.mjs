import { UserError } from "../config/errors.mjs";
import { addProject, listProjects, moveProject, removeProject } from "../config/projects.mjs";
import { loadConfig } from "../config/store.mjs";
import { checkArgs, parseCommand } from "./args.mjs";

// Registers a git repository as a project of an org, reports what happened and returns the entry it landed on.
export function registerProject(ctx, { path, name, org } = {}) {
  const config = loadConfig(ctx.env, { warn: ctx.err });
  const result = addProject(config, { path, name, org });
  const project = result.project;
  if (result.status === "unchanged") {
    ctx.out(`project \`${project.name}\` already registered -> ${project.path} (org \`${project.org}\`)`);
    return project;
  }
  ctx.saveConfig(result.config, ctx.env);
  ctx.out(`registered project \`${project.name}\` -> ${project.path} (org \`${project.org}\`)`);
  return project;
}

// Registers a git repository as a project of an org, from the arguments of a command.
export async function addFromArgs(argv, ctx, usage) {
  const { values, positionals } = parseCommand(argv, { org: { type: "string" }, name: { type: "string" } });
  checkArgs(positionals, { max: 1, usage });
  registerProject(ctx, { path: positionals[0] ?? ".", name: values.name, org: values.org });
}

// Runs `project add`.
async function runAdd(argv, ctx) {
  await addFromArgs(argv, ctx, "shift project add <path> [--org <name>] [--name <name>]");
}

// Runs `project list`.
async function runList(argv, ctx) {
  const { values, positionals } = parseCommand(argv, { json: { type: "boolean" } });
  checkArgs(positionals, { max: 0, usage: "shift project list [--json]" });
  const projects = listProjects(loadConfig(ctx.env, { warn: ctx.err }));
  if (values.json) {
    ctx.out(JSON.stringify({ projects }));
    return;
  }
  if (projects.length === 0) {
    ctx.out("no projects registered");
    return;
  }
  for (const project of projects) {
    ctx.out(`${project.name}  ${project.path}  ${project.org}  ${project.exists ? "ok" : "missing"}`);
  }
}

// Runs `project remove`.
async function runRemove(argv, ctx) {
  const { positionals } = parseCommand(argv);
  checkArgs(positionals, { min: 1, usage: "shift project remove <name>" });
  const name = positionals[0];
  ctx.saveConfig(removeProject(loadConfig(ctx.env, { warn: ctx.err }), name), ctx.env);
  ctx.out(`removed project \`${name}\``);
}

// Runs `project move`.
async function runMove(argv, ctx) {
  const { positionals } = parseCommand(argv);
  checkArgs(positionals, { min: 2, usage: "shift project move <name> <org>" });
  const [name, org] = positionals;
  const result = moveProject(loadConfig(ctx.env, { warn: ctx.err }), name, org);
  if (result.status === "unchanged") {
    ctx.out(`project \`${name}\` is already in org \`${org}\``);
    return;
  }
  ctx.saveConfig(result.config, ctx.env);
  ctx.out(`moved project \`${name}\` to org \`${org}\``);
}

const SUBCOMMANDS = new Map([
  ["add", runAdd],
  ["list", runList],
  ["remove", runRemove],
  ["move", runMove],
]);

// Dispatches the subcommands of `shift project`.
export async function run(argv, ctx) {
  const [sub, ...rest] = argv;
  const handler = SUBCOMMANDS.get(sub);
  if (!handler) {
    throw new UserError(`unknown project subcommand \`${sub ?? ""}\`; use: ${[...SUBCOMMANDS.keys()].join(", ")}`);
  }
  await handler(rest, ctx);
}
