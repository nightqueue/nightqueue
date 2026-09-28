import { existsSync } from "node:fs";
import { UserError } from "../config/errors.mjs";
import { requireOrg } from "../config/orgs.mjs";
import { registerProject as registerInStore, renameProject, requireGitPath, requireProject } from "../config/projects.mjs";
import { loadConfig } from "../config/store.mjs";
import { openRegistryReader, openStore } from "../store/open.mjs";
import { checkArgs, parseCommand } from "./args.mjs";

// Registers a git repository as a project of an org and answers what happened, printing nothing.
export async function saveProject(ctx, { path, name, org } = {}) {
  return await registerInStore(openStore(ctx.env), loadConfig(ctx.env, { warn: ctx.err }), { path, name, org });
}

// Registers a git repository as a project of an org, reports the one fact that matters and returns the row it landed on.
export async function registerProject(ctx, { path, name, org } = {}) {
  const { project } = await saveProject(ctx, { path, name, org });
  ctx.out(`registered project \`${project.name}\` (${project.path})`);
  return project;
}

// Registers a git repository as a project of an org, from the arguments of a command.
export async function addFromArgs(argv, ctx, usage) {
  const { values, positionals } = parseCommand(argv, { org: { type: "string" }, name: { type: "string" } });
  checkArgs(positionals, { max: 1, usage });
  await registerProject(ctx, { path: positionals[0] ?? ".", name: values.name, org: values.org });
}

// Runs `project add`.
async function runAdd(argv, ctx) {
  await addFromArgs(argv, ctx, "nightqueue project add <path> [--org <name>] [--name <name>]");
}

// The listing shape of a project: its checkout path, when it has one, and whether that path still exists.
function listedProject(project) {
  return { id: project.id, name: project.name, path: project.path, org: project.org, exists: project.path ? existsSync(project.path) : false };
}

// One line of `project list`; a project known only from history has no path.
function projectLine(project) {
  if (!project.path) return `${project.name}  (no path)  ${project.org}`;
  return `${project.name}  ${project.path}  ${project.org}  ${project.exists ? "ok" : "missing"}`;
}

// Runs `project list`: every registered project, path-less ones included.
async function runList(argv, ctx) {
  const { values, positionals } = parseCommand(argv, { json: { type: "boolean" } });
  checkArgs(positionals, { max: 0, usage: "nightqueue project list [--json]" });
  const store = await openRegistryReader(ctx.env);
  const projects = store ? (await store.projects.list()).map(listedProject) : [];
  if (values.json) {
    ctx.out(JSON.stringify({ projects }));
    return;
  }
  if (projects.length === 0) {
    ctx.out("no projects registered");
    return;
  }
  for (const project of projects) ctx.out(projectLine(project));
}

// Runs `project rename`: one registry row, so every row keyed by the project id shows the new name at once.
async function runRename(argv, ctx) {
  const { positionals } = parseCommand(argv);
  checkArgs(positionals, { min: 2, max: 2, usage: "nightqueue project rename <old> <new>" });
  const [oldName, newName] = positionals;
  await renameProject(openStore(ctx.env), oldName, newName);
  ctx.out(`renamed project \`${oldName}\` to \`${newName}\``);
}

// Runs `project remove`: the database refuses a project that still owns rows, and the refusal lists them.
async function runRemove(argv, ctx) {
  const { positionals } = parseCommand(argv);
  checkArgs(positionals, { min: 1, usage: "nightqueue project remove <name>" });
  const store = openStore(ctx.env);
  const project = await requireProject(store, positionals[0]);
  await store.projects.remove(project.id);
  ctx.out(`removed project \`${project.name}\``);
}

// What a move asks for: the target org and/or the new checkout path.
async function moveTarget(store, { org, path }) {
  if (org === undefined && path === undefined) {
    throw new UserError("name the org to move the project to, or its new checkout with --path <path>");
  }
  return {
    org: org === undefined ? null : await requireOrg(store, org),
    path: path === undefined ? undefined : requireGitPath(path),
  };
}

// The line a move reports, naming only what changed.
function moveReport(project, moved, target) {
  const changes = [];
  if (target.org && moved.org_id !== project.org_id) changes.push(`to org \`${moved.org}\``);
  if (target.path !== undefined && moved.path !== project.path) changes.push(`to path ${moved.path}`);
  if (!changes.length) return `project \`${project.name}\` is already ${target.org ? `in org \`${project.org}\`` : `at ${project.path}`}`;
  return `moved project \`${project.name}\` ${changes.join(" and ")}`;
}

// Runs `project move`: to another org, to a new checkout path, or both.
async function runMove(argv, ctx) {
  const { values, positionals } = parseCommand(argv, { path: { type: "string" } });
  checkArgs(positionals, { min: 1, max: 2, usage: "nightqueue project move <name> [<org>] [--path <path>]" });
  const store = openStore(ctx.env);
  const project = await requireProject(store, positionals[0]);
  const target = await moveTarget(store, { org: positionals[1], path: values.path });
  const moved = await store.projects.move(project.id, { orgId: target.org?.id, path: target.path });
  ctx.out(moveReport(project, moved, target));
}

const SUBCOMMANDS = new Map([
  ["add", runAdd],
  ["list", runList],
  ["rename", runRename],
  ["remove", runRemove],
  ["move", runMove],
]);

// Dispatches the subcommands of `nightqueue project`.
export async function run(argv, ctx) {
  const [sub, ...rest] = argv;
  const handler = SUBCOMMANDS.get(sub);
  if (!handler) {
    throw new UserError(`unknown project subcommand \`${sub ?? ""}\`; use: ${[...SUBCOMMANDS.keys()].join(", ")}`);
  }
  await handler(rest, ctx);
}
