import { existsSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { UserError } from "../config/errors.mjs";
import { requireOrg } from "../config/orgs.mjs";
import {
  mainCheckoutOf,
  normalizePath,
  pathContains,
  registerProject as registerInStore,
  renameProject,
  requireGitPath,
  requireProject,
  setProjectKey,
} from "../config/projects.mjs";
import { runsDir } from "../config/paths.mjs";
import { loadConfig } from "../config/store.mjs";
import { changeProjectIntegrations, integrationLines, integrationsView } from "../integrations/settings.mjs";
import { requireKey } from "../memory/refs.mjs";
import { refuseHomeWriteInsideJob } from "../queue/home-guard.mjs";
import { agentModels, requireAgent, requireModel } from "../queue/routing.mjs";
import { openRegistryReader, openRegistryWriter, openStore } from "../store/open.mjs";
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
export function projectListing(project, aliases) {
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
export async function listedProjects(ctx) {
  const store = await openRegistryReader(ctx.env);
  if (!store) return [];
  const aliases = await store.projects.keyAliases();
  return (await store.projects.list()).map((project) => projectListing(project, aliases));
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

// Deletes a project's rows in one transaction, then its run directory once that committed; answers what the purge removed.
export async function purgeProjectRows(env, store, project) {
  const purged = await store.projects.purge(project.id);
  rmSync(join(runsDir(env), project.id), { recursive: true, force: true });
  return purged;
}

// Purges a project after the terminal confirmed it.
async function purgeProject(ctx, store, project, yes) {
  const footprint = await store.projects.footprint(project.id);
  await confirmPurge(ctx, project, footprint, yes);
  await purgeProjectRows(ctx.env, store, project);
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

const INTEGRATIONS_USAGE = "nightqueue project integrations <project> show [--json] | set <kind.key>=<value>... | unset <kind.key>...";

// Reads `set` arguments written `<kind.key>=<value>`, split on the first `=`.
function settingAssignments(args) {
  return args.map((arg) => {
    const at = arg.indexOf("=");
    if (at <= 0) throw new UserError(`\`${arg}\` is not <kind.key>=<value>; usage: ${INTEGRATIONS_USAGE}`);
    return { key: arg.slice(0, at), value: arg.slice(at + 1) };
  });
}

// Prints a project's integrations, as lines or as the JSON answer.
function printIntegrations(ctx, { project, integrations, json }) {
  if (json) {
    ctx.out(JSON.stringify(integrationsView(project, integrations)));
    return;
  }
  for (const line of integrationLines(integrations, { orgId: project.org_id, env: ctx.env, checkout: project.path })) ctx.out(line);
}

// Runs `project integrations <project> show`: reads only, a home without a database knowing no project.
async function showIntegrations(ctx, { name, json }) {
  const store = await openRegistryReader(ctx.env);
  if (!store) throw new UserError(`unknown project \`${name}\`; no project is registered yet`);
  const project = await requireProject(store, name);
  printIntegrations(ctx, { project, integrations: await store.projects.integrations(project.id), json });
}

// Runs `project integrations <project> set|unset`: every change validated before the one write, refused inside a job.
async function changeIntegrations(ctx, { name, action, args, json }) {
  refuseHomeWriteInsideJob(ctx.env);
  const changes = action === "set" ? settingAssignments(args) : args.map((key) => ({ key }));
  const store = await openRegistryWriter(ctx.env);
  const project = await requireProject(store, name);
  const integrations = await changeProjectIntegrations({ store, project, action, changes, env: ctx.env });
  printIntegrations(ctx, { project, integrations, json });
}

// Runs `project integrations`: shows or changes the per-provider settings of a project.
async function runIntegrations(argv, ctx) {
  const { values, positionals } = parseCommand(argv, { json: { type: "boolean" } });
  checkArgs(positionals, { min: 2, max: Infinity, usage: INTEGRATIONS_USAGE });
  const [name, action, ...args] = positionals;
  if (action === "show") {
    checkArgs(args, { max: 0, usage: INTEGRATIONS_USAGE });
    return await showIntegrations(ctx, { name, json: values.json === true });
  }
  if (action !== "set" && action !== "unset") throw new UserError(`unknown integrations action \`${action}\`; usage: ${INTEGRATIONS_USAGE}`);
  await changeIntegrations(ctx, { name, action, args, json: values.json === true });
}

const MODELS_USAGE = "nightqueue project models <project> [--set <agent>=<model>]... [--unset <agent>]... [--json]";

// Each agent's model for a project and where it comes from (`project` override or `default`).
function modelView(projectAgents) {
  const models = agentModels(projectAgents);
  return Object.fromEntries(
    Object.entries(models).map(([agent, model]) => [agent, { model, source: model === projectAgents?.[agent]?.model ? "project" : "default" }]),
  );
}

// Prints a project's agent models, as lines or as the JSON answer.
function printModels(ctx, { project, projectAgents, json }) {
  const agents = modelView(projectAgents);
  if (json) {
    ctx.out(JSON.stringify({ project: project.name, agents }));
    return;
  }
  for (const [agent, { model, source }] of Object.entries(agents)) ctx.out(`${agent}=${model} (${source})`);
}

// Reads `--set` values written `<agent>=<model>`, each name validated.
function modelAssignments(values) {
  return values.map((arg) => {
    const at = arg.indexOf("=");
    if (at <= 0) throw new UserError(`\`${arg}\` is not <agent>=<model>; usage: ${MODELS_USAGE}`);
    return { agent: requireAgent(arg.slice(0, at)), model: requireModel(arg.slice(at + 1)) };
  });
}

// The overrides after the sets and unsets are applied, every name validated before anything is written.
function changedAgents(current, { set, unset }) {
  const next = { ...(current ?? {}) };
  for (const { agent, model } of modelAssignments(set)) next[agent] = { model };
  for (const agent of unset) delete next[requireAgent(agent)];
  return next;
}

// Runs `project models <project>` without changes: reads only, a home without a database knowing no project.
async function showModels(ctx, { name, json }) {
  const store = await openRegistryReader(ctx.env);
  if (!store) throw new UserError(`unknown project \`${name}\`; no project is registered yet`);
  const project = await requireProject(store, name);
  printModels(ctx, { project, projectAgents: await store.projects.agents(project.id), json });
}

// Runs `project models <project> --set/--unset`: every change validated before the one write, refused inside a job.
async function changeModels(ctx, { name, set, unset, json }) {
  refuseHomeWriteInsideJob(ctx.env);
  const store = await openRegistryWriter(ctx.env);
  const project = await requireProject(store, name);
  const next = changedAgents(await store.projects.agents(project.id), { set, unset });
  const projectAgents = await store.projects.setAgents(project.id, next);
  printModels(ctx, { project, projectAgents, json });
}

// Runs `project models`: shows or changes the model each agent of the project runs on.
async function runModels(argv, ctx) {
  const options = { set: { type: "string", multiple: true }, unset: { type: "string", multiple: true }, json: { type: "boolean" } };
  const { values, positionals } = parseCommand(argv, options);
  checkArgs(positionals, { min: 1, max: 1, usage: MODELS_USAGE });
  const set = values.set ?? [];
  const unset = values.unset ?? [];
  const json = values.json === true;
  if (set.length === 0 && unset.length === 0) return await showModels(ctx, { name: positionals[0], json });
  await changeModels(ctx, { name: positionals[0], set, unset, json });
}

const DEMO_REPO_USAGE = "nightqueue project demo-repo <project> [--set <path>] [--json]";

// Prints a project's demo repository, as one line or as the JSON answer.
function printDemoRepo(ctx, { project, demoRepo, json }) {
  if (json) {
    ctx.out(JSON.stringify({ project: project.name, demoRepo }));
    return;
  }
  ctx.out(demoRepo ?? "none configured");
}

// Tells whether a directory is the project's own repository: its checkout, one of its worktrees, inside it or around it.
function isOwnRepository(absolute, project) {
  if (typeof project?.path !== "string" || !project.path) return false;
  const own = mainCheckoutOf(normalizePath(project.path));
  return mainCheckoutOf(absolute) === own || pathContains(own, absolute) || pathContains(absolute, own);
}

// The canonical path of a git repository that is not the project's own, or a refusal naming the path.
function requireDemoRepository(path, project) {
  const absolute = normalizePath(path);
  if (!existsSync(absolute) || !statSync(absolute).isDirectory()) throw new UserError(`the demo repository \`${absolute}\` is not an existing directory`);
  if (!existsSync(join(absolute, ".git"))) throw new UserError(`the demo repository \`${absolute}\` is not a git repository`);
  if (isOwnRepository(absolute, project)) {
    throw new UserError(`the demo repository \`${absolute}\` is the project's own repository: real pull requests are never opened there`);
  }
  return absolute;
}

// Runs `project demo-repo <project>` without `--set`: reads only.
async function showDemoRepo(ctx, { name, json }) {
  const store = await openRegistryReader(ctx.env);
  if (!store) throw new UserError(`unknown project \`${name}\`; no project is registered yet`);
  const project = await requireProject(store, name);
  printDemoRepo(ctx, { project, demoRepo: await store.projects.demoRepo(project.id), json });
}

// Runs `project demo-repo <project> --set <path>`: the path validated before the one write, refused inside a job.
async function changeDemoRepo(ctx, { name, path, json }) {
  refuseHomeWriteInsideJob(ctx.env);
  const store = await openRegistryWriter(ctx.env);
  const project = await requireProject(store, name);
  const demoRepoPath = requireDemoRepository(path, project);
  printDemoRepo(ctx, { project, demoRepo: await store.projects.setDemoRepo(project.id, demoRepoPath), json });
}

// Runs `project demo-repo`: shows or sets the repository where verifications may open real pull requests.
async function runDemoRepo(argv, ctx) {
  const { values, positionals } = parseCommand(argv, { set: { type: "string" }, json: { type: "boolean" } });
  checkArgs(positionals, { min: 1, max: 1, usage: DEMO_REPO_USAGE });
  const json = values.json === true;
  if (values.set === undefined) return await showDemoRepo(ctx, { name: positionals[0], json });
  if (!values.set) throw new UserError(`\`--set\` needs a path; usage: ${DEMO_REPO_USAGE}`);
  await changeDemoRepo(ctx, { name: positionals[0], path: values.set, json });
}

const SUBCOMMANDS = new Map([
  ["add", runAdd],
  ["list", runList],
  ["rename", runRename],
  ["key", runKey],
  ["remove", runRemove],
  ["move", runMove],
  ["integrations", runIntegrations],
  ["models", runModels],
  ["demo-repo", runDemoRepo],
]);

export const SUBCOMMAND_NAMES = Object.freeze([...SUBCOMMANDS.keys()]);

// Dispatches the subcommands of `nightqueue project`.
export async function run(argv, ctx) {
  const [sub, ...rest] = argv;
  const handler = SUBCOMMANDS.get(sub);
  if (!handler) {
    throw new UserError(`unknown project subcommand \`${sub ?? ""}\`; use: ${[...SUBCOMMANDS.keys()].join(", ")}`);
  }
  await handler(rest, ctx);
}
