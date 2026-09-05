import { UserError } from "../config/errors.mjs";
import { addOrg, listOrgs, removeOrg, renameOrg } from "../config/orgs.mjs";
import { loadConfig } from "../config/store.mjs";
import { checkArgs, parseCommand } from "./args.mjs";

// Formata os slots de connection de uma org para a saida textual.
function formatSlots(connections) {
  return Object.entries(connections)
    .map(([type, name]) => `${type}=${name ?? "-"}`)
    .join(" ");
}

// Formata uma linha de `org list`.
function formatOrg(org) {
  const marker = org.isDefault ? "*" : " ";
  return `${marker} ${org.name}  ${org.displayName}  ${formatSlots(org.connections)}  projects=${org.projects}`;
}

// Executa `org add`.
async function runAdd(argv, ctx) {
  const { values, positionals } = parseCommand(argv, { "display-name": { type: "string" } });
  checkArgs(positionals, { min: 1, usage: 'shift org add <name> [--display-name "..."]' });
  const name = positionals[0];
  const config = addOrg(loadConfig(ctx.env, { warn: ctx.err }), name, { displayName: values["display-name"] });
  ctx.saveConfig(config, ctx.env);
  ctx.out(`created org \`${name}\` (${config.orgs[name].displayName})`);
}

// Executa `org list`.
async function runList(argv, ctx) {
  const { values, positionals } = parseCommand(argv, { json: { type: "boolean" } });
  checkArgs(positionals, { max: 0, usage: "shift org list [--json]" });
  const config = loadConfig(ctx.env, { warn: ctx.err });
  const orgs = listOrgs(config);
  if (values.json) {
    ctx.out(JSON.stringify({ defaultOrg: config.defaultOrg, orgs }));
    return;
  }
  for (const org of orgs) ctx.out(formatOrg(org));
}

// Executa `org rename`.
async function runRename(argv, ctx) {
  const { positionals } = parseCommand(argv);
  checkArgs(positionals, { min: 2, usage: "shift org rename <old> <new>" });
  const [oldName, newName] = positionals;
  ctx.saveConfig(renameOrg(loadConfig(ctx.env, { warn: ctx.err }), oldName, newName), ctx.env);
  ctx.out(`renamed org \`${oldName}\` to \`${newName}\``);
}

// Executa `org remove`.
async function runRemove(argv, ctx) {
  const { positionals } = parseCommand(argv);
  checkArgs(positionals, { min: 1, usage: "shift org remove <name>" });
  const name = positionals[0];
  ctx.saveConfig(removeOrg(loadConfig(ctx.env, { warn: ctx.err }), name), ctx.env);
  ctx.out(`removed org \`${name}\``);
}

const SUBCOMMANDS = new Map([
  ["add", runAdd],
  ["list", runList],
  ["rename", runRename],
  ["remove", runRemove],
]);

// Despacha os subcomandos de `shift org`.
export async function run(argv, ctx) {
  const [sub, ...rest] = argv;
  const handler = SUBCOMMANDS.get(sub);
  if (!handler) {
    throw new UserError(`unknown org subcommand \`${sub ?? ""}\`; use: ${[...SUBCOMMANDS.keys()].join(", ")}`);
  }
  await handler(rest, ctx);
}
