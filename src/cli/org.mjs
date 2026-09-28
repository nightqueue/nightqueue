import { UserError } from "../config/errors.mjs";
import { addOrg, listOrgs, removeOrg, renameOrg } from "../config/orgs.mjs";
import { loadConfig } from "../config/store.mjs";
import { openRegistryReader, openRegistryWriter, openStore } from "../store/open.mjs";
import { checkArgs, parseCommand } from "./args.mjs";

// Formats the connection slots of an org for the text output.
function formatSlots(connections) {
  return Object.entries(connections)
    .map(([type, name]) => `${type}=${name ?? "-"}`)
    .join(" ");
}

// Formats one line of `org list`.
function formatOrg(org) {
  const marker = org.isDefault ? "*" : " ";
  return `${marker} ${org.name}  ${formatSlots(org.connections)}  projects=${org.projects}`;
}

// Runs `org add`.
async function runAdd(argv, ctx) {
  const { positionals } = parseCommand(argv);
  checkArgs(positionals, { min: 1, usage: "nightqueue org add <name>" });
  const org = await addOrg(openStore(ctx.env), positionals[0]);
  ctx.out(`created org \`${org.name}\``);
}

// The orgs of the home as `org list` shows them; a home with no database yet has none.
async function currentOrgs(ctx) {
  const store = await openRegistryReader(ctx.env);
  if (!store) return { defaultOrg: null, orgs: [] };
  const orgs = await listOrgs(store, loadConfig(ctx.env, { warn: ctx.err }));
  return { defaultOrg: orgs.find((org) => org.isDefault)?.id ?? null, orgs };
}

// Runs `org list`.
async function runList(argv, ctx) {
  const { values, positionals } = parseCommand(argv, { json: { type: "boolean" } });
  checkArgs(positionals, { max: 0, usage: "nightqueue org list [--json]" });
  const listing = await currentOrgs(ctx);
  if (values.json) {
    ctx.out(JSON.stringify(listing));
    return;
  }
  for (const org of listing.orgs) ctx.out(formatOrg(org));
}

// Runs `org rename`: one registry row, so every project, binding and default keyed by the org id follows it.
async function runRename(argv, ctx) {
  const { positionals } = parseCommand(argv);
  checkArgs(positionals, { min: 2, usage: "nightqueue org rename <old> <new>" });
  const [oldName, newName] = positionals;
  await renameOrg(openStore(ctx.env), oldName, newName);
  ctx.out(`renamed org \`${oldName}\` to \`${newName}\``);
}

// Runs `org remove`: the registry refuses an org still owning projects or rows, and its bindings leave the config.
async function runRemove(argv, ctx) {
  const { positionals } = parseCommand(argv);
  checkArgs(positionals, { min: 1, usage: "nightqueue org remove <name>" });
  const name = positionals[0];
  const store = await openRegistryWriter(ctx.env);
  const config = await removeOrg(store, loadConfig(ctx.env, { warn: ctx.err }), name);
  ctx.saveConfig(config, ctx.env);
  ctx.out(`removed org \`${name}\``);
}

const SUBCOMMANDS = new Map([
  ["add", runAdd],
  ["list", runList],
  ["rename", runRename],
  ["remove", runRemove],
]);

// Dispatches the subcommands of `nightqueue org`.
export async function run(argv, ctx) {
  const [sub, ...rest] = argv;
  const handler = SUBCOMMANDS.get(sub);
  if (!handler) {
    throw new UserError(`unknown org subcommand \`${sub ?? ""}\`; use: ${[...SUBCOMMANDS.keys()].join(", ")}`);
  }
  await handler(rest, ctx);
}
