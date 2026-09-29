import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { UserError } from "../config/errors.mjs";
import { requireOrg } from "../config/orgs.mjs";
import { registerProject as registerInStore, renameProject, requireGitPath, requireProject, setProjectKey } from "../config/projects.mjs";
import { runsDir } from "../config/paths.mjs";
import { loadConfig } from "../config/store.mjs";
import { keptCommentsError } from "../memory/project-purge.mjs";
import { requireKey } from "../memory/refs.mjs";
import { openRegistryReader, openStore } from "../store/open.mjs";
import { checkArgs, parseCommand } from "./args.mjs";
import { askKey, choose } from "./prompt.mjs";

// The key `--key` asks for, validated at the edge; undefined when the option is absent.
export function keyOption(values) {
  return values.key === undefined ? undefined : requireKey(values.key);
}

// Registers a git repository as a project of an org and answers what happened, printing nothing; without a key the terminal is asked, or the suggestion taken.
export async function saveProject(ctx, { path, name, org, key } = {}) {
  const store = openStore(ctx.env);
  const chooseKey = async (projectName) =>
    await askKey(ctx, { kind: "project", name: projectName, suggested: await store.projects.suggestKey(projectName) });
  return await registerInStore(store, loadConfig(ctx.env, { warn: ctx.err }), { path, name, org, key, chooseKey });
}

// Registers a git repository as a project of an org, reports the one fact that matters and returns the row it landed on.
export async function registerProject(ctx, { path, name, org, key } = {}) {
  const { project } = await saveProject(ctx, { path, name, org, key });
  ctx.out(`registered project \`${project.name}\` (${project.path}) with key ${project.key}`);
  return project;
}

// Registers a git repository as a project of an org, from the arguments of a command.
export async function addFromArgs(argv, ctx, usage) {
  const { values, positionals } = parseCommand(argv, { org: { type: "string" }, name: { type: "string" }, key: { type: "string" } });
  checkArgs(positionals, { max: 1, usage });
  await registerProject(ctx, { path: positionals[0] ?? ".", name: values.name, org: values.org, key: keyOption(values) });
}

// Runs `project add`.
async function runAdd(argv, ctx) {
  await addFromArgs(argv, ctx, "nightqueue project add <path> [--org <name>] [--name <name>] [--key <KEY>]");
}

// The listing shape of a project: its key and old keys, its checkout path, when it has one, and whether that path still exists.
function listedProject(project, aliases) {
  return {
    id: project.id,
    name: project.name,
    key: project.key,
    aliases: aliases[project.id] ?? [],
    path: project.path,
    org: project.org,
    exists: project.path ? existsSync(project.path) : false,
  };
}

// One line of `project list`; a project known only from history has no path.
function projectLine(project) {
  if (!project.path) return `${project.name}  ${project.key}  (no path)  ${project.org}`;
  return `${project.name}  ${project.key}  ${project.path}  ${project.org}  ${project.exists ? "ok" : "missing"}`;
}

// Every registered project in its listing shape; a home with no database yet has none.
async function listedProjects(ctx) {
  const store = await openRegistryReader(ctx.env);
  if (!store) return [];
  const aliases = await store.projects.keyAliases();
  return (await store.projects.list()).map((project) => listedProject(project, aliases));
}

// Runs `project list`: every registered project, path-less ones included.
async function runList(argv, ctx) {
  const { values, positionals } = parseCommand(argv, { json: { type: "boolean" } });
  checkArgs(positionals, { max: 0, usage: "nightqueue project list [--json]" });
  const projects = await listedProjects(ctx);
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

// Runs `project key`: one registry row and one alias, so the old key keeps resolving and every render shows the new one.
async function runKey(argv, ctx) {
  const { positionals } = parseCommand(argv);
  checkArgs(positionals, { min: 2, max: 2, usage: "nightqueue project key <name> <KEY>" });
  const [name, key] = positionals;
  const { oldKey, key: newKey } = await setProjectKey(openStore(ctx.env), name, key);
  ctx.out(`changed the key of project \`${name}\` from ${oldKey} to ${newKey}; ${oldKey} refs still resolve`);
}

// The per-table counts of what a project owns, one per line, as `<total> <table>`.
function footprintLines(footprint) {
  return footprint.map((entry) => `  ${entry.total} ${entry.table.replaceAll("_", " ")}`);
}

// Refuses a plain remove of a project with history, listing what it owns and pointing to --purge.
function refuseOwnedRows(project, footprint) {
  const detail = footprint.map((entry) => `${entry.total} ${entry.table.replaceAll("_", " ")}`).join(", ");
  throw new UserError(`cannot remove project \`${project.name}\`: it still owns ${detail}; use --purge to delete it with everything it owns; nothing was removed`);
}

// Lists what a purge deletes and asks the terminal to confirm; without --yes and without a terminal it refuses.
async function confirmPurge(ctx, project, footprint, yes) {
  ctx.out(`purging project \`${project.name}\` deletes:`);
  for (const line of footprintLines(footprint)) ctx.out(line);
  if (yes) return;
  if (!ctx.stdin?.isTTY) throw new UserError("purge needs confirmation: run it on a terminal or pass --yes; nothing was removed");
  const question = `Delete project \`${project.name}\` and all of the above? [y/N] `;
  const answer = await choose({ stdin: ctx.stdin, stdout: ctx.stdout ?? process.stdout, question, choices: ["y", "yes"], fallback: "no" });
  if (answer === "no") throw new UserError("purge cancelled; nothing was removed");
}

// Purges a project: the rows in one transaction, and its run directory only after that commits.
async function purgeProject(ctx, store, project, yes) {
  const footprint = await store.projects.footprint(project.id);
  const kept = footprint.find((entry) => entry.kept);
  if (kept) throw keptCommentsError(project, kept.total);
  await confirmPurge(ctx, project, footprint, yes);
  await store.projects.purge(project.id);
  rmSync(join(runsDir(ctx.env), project.id), { recursive: true, force: true });
  ctx.out(`purged project \`${project.name}\` and everything it owned`);
}

// Runs `project remove`: a project with history is refused unless --purge deletes it with everything it owns.
async function runRemove(argv, ctx) {
  const { values, positionals } = parseCommand(argv, { purge: { type: "boolean" }, yes: { type: "boolean" } });
  checkArgs(positionals, { min: 1, max: 1, usage: "nightqueue project remove <name> [--purge [--yes]]" });
  const store = openStore(ctx.env);
  const project = await requireProject(store, positionals[0]);
  if (values.purge) return await purgeProject(ctx, store, project, values.yes === true);
  const footprint = await store.projects.footprint(project.id);
  if (footprint.length) refuseOwnedRows(project, footprint);
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
  ["key", runKey],
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
