import { UserError } from "../config/errors.mjs";
import { addOrg, listOrgs, removeOrg, renameOrg, setOrgKey } from "../config/orgs.mjs";
import { loadConfig } from "../config/store.mjs";
import { openRegistryReader, openRegistryWriter, openStore } from "../store/open.mjs";
import { checkArgs, parseCommand } from "./args.mjs";
import { keyOption } from "./project.mjs";
import { askKey } from "./prompt.mjs";

// Formats one binding of an org: a slot's name, a list joined by commas, `-` when empty.
function formatBinding(binding) {
  const names = Array.isArray(binding) ? binding.join(",") : binding;
  return names || "-";
}

// Formats the connection slots of an org for the text output.
function formatSlots(connections) {
  return Object.entries(connections)
    .map(([type, binding]) => `${type}=${formatBinding(binding)}`)
    .join(" ");
}

// Formats one line of `org list`.
function formatOrg(org) {
  const marker = org.isDefault ? "*" : " ";
  return `${marker} ${org.name}  ${org.key}  ${formatSlots(org.connections)}  projects=${org.projects}`;
}

// The key a new org gets: the one `--key` asks for, the one typed at the terminal, or the suggestion.
async function newOrgKey(store, name, values, ctx) {
  const asked = keyOption(values);
  if (asked !== undefined) return asked;
  return await askKey(ctx, { kind: "org", name, suggested: await store.orgs.suggestKey(name) });
}

// Runs `org add`.
async function runAdd(argv, ctx) {
  const { values, positionals } = parseCommand(argv, { key: { type: "string" } });
  checkArgs(positionals, { min: 1, usage: "nightqueue org add <name> [--key <KEY>]" });
  const store = openStore(ctx.env);
  const name = positionals[0];
  const org = await addOrg(store, name, await newOrgKey(store, name, values, ctx));
  ctx.out(`created org \`${org.name}\` with key ${org.key}`);
}

// Runs `org key`: one registry row and one alias, so the old key keeps resolving and every render shows the new one.
async function runKey(argv, ctx) {
  const { positionals } = parseCommand(argv);
  checkArgs(positionals, { min: 2, max: 2, usage: "nightqueue org key <name> <KEY>" });
  const [name, key] = positionals;
  const { oldKey, key: newKey } = await setOrgKey(openStore(ctx.env), name, key);
  ctx.out(`changed the key of org \`${name}\` from ${oldKey} to ${newKey}; ${oldKey} refs still resolve`);
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
  ["key", runKey],
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
