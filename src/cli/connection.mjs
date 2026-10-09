import {
  addConnection,
  assertHomeFree,
  bindConnection,
  completeConnection,
  connectionExtras,
  hasConnection,
  listConnections,
  removeConnection,
  requireType,
  testConnection,
  typeOf,
} from "../config/connections.mjs";
import { UserError } from "../config/errors.mjs";
import { DESTINATION_KIND, unlinkProjectsUsing } from "../integrations/destinations.mjs";
import { defaultOrg, requireOrg } from "../config/orgs.mjs";
import { assertName } from "../config/schema.mjs";
import { loadConfig, loadSecrets } from "../config/store.mjs";
import { openRegistryReader, openRegistryWriter } from "../store/open.mjs";
import { checkArgs, parseCommand } from "./args.mjs";
import { readSecret } from "./prompt.mjs";

// The org names by id, read without creating a database; an id the registry does not know shows as itself.
async function orgNamesById(ctx) {
  const store = await openRegistryReader(ctx.env);
  const orgs = store ? await store.orgs.list() : [];
  const names = new Map(orgs.map((org) => [org.id, org.name]));
  return (ids) => ids.map((id) => names.get(id) ?? id);
}

// The orgs column of `connection list`: `home` for a home-wide connection, the org names, or `-`.
function orgsColumn(connection) {
  if (connection.scope === "home") return "home";
  return connection.orgs.length ? connection.orgs.join(",") : "-";
}

// Formats one line of `connection list`.
function formatConnection(connection) {
  const orgs = orgsColumn(connection);
  const missing = connection.present ? "" : "  MISSING SECRET";
  return `${connection.name}  ${connection.type}${missing}  orgs=${orgs}`;
}

// Writes the config after the secret, pointing at the recovery when that write fails.
export function saveConfigAfterSecret({ config, ctx, name, org }) {
  try {
    ctx.saveConfig(config, ctx.env);
  } catch (err) {
    throw new Error(
      `secret stored for \`${name}\`, but the config write failed: ${err?.message ?? String(err)}; run \`nightqueue connection bind ${name} --org ${org}\``,
    );
  }
}

// Writes the secrets after the config, pointing at the recovery when that write fails.
export function saveSecretsAfterConfig({ secrets, ctx, name }) {
  try {
    ctx.saveSecrets(secrets, ctx.env);
  } catch (err) {
    throw new Error(
      `unbound \`${name}\` from all orgs, but the secret file write failed: ${err?.message ?? String(err)}; run \`nightqueue connection remove ${name}\` again`,
    );
  }
}

// Reads the `--set <field>=<value>` options of `connection add` into an object; a field given twice is refused.
function parseExtraFields(assignments, usage) {
  const extra = Object.create(null);
  for (const assignment of assignments ?? []) {
    const at = assignment.indexOf("=");
    const field = at > 0 ? assignment.slice(0, at).trim() : "";
    if (!field) throw new UserError(`\`--set\` takes <field>=<value>; usage: ${usage}`);
    if (field in extra) throw new UserError(`\`--set ${field}\` given twice`);
    extra[field] = assignment.slice(at + 1).trim();
  }
  return extra;
}

// Reads the secret of a new connection from stdin and the fields its type derives from it.
async function readNewSecret({ ctx, name, type, descriptor, extra }) {
  const secret = await readSecret({
    stdin: ctx.stdin,
    stdout: ctx.stdout,
    prompt: `${type} ${descriptor.secretLabel ?? "secret"} for \`${name}\`: `,
  });
  const derived = await completeConnection({ type, secret, extra, fetchImpl: ctx.fetchImpl });
  return { secret, derived };
}

// Adds a home-wide connection to the secrets and writes them: no org and no config change.
export function storeHomeConnection({ env, secrets, name, type, secret, extra = {}, derived = {}, saveSecrets }) {
  const result = addConnection({ config: null, secrets, name, type, orgId: null, secret, extra, derived });
  saveSecrets(result.secrets, env);
}

// Stores a connection of a home-wide type: the secret only, no org and no config change.
async function addHomeConnection({ ctx, secrets, name, type, descriptor, extra }) {
  if (hasConnection(secrets, name)) throw new UserError(`connection \`${name}\` already exists; remove it first`);
  assertHomeFree(secrets, type);
  const { secret, derived } = await readNewSecret({ ctx, name, type, descriptor, extra });
  storeHomeConnection({ env: ctx.env, secrets, name, type, secret, extra, derived, saveSecrets: ctx.saveSecrets });
  ctx.out(`stored connection \`${name}\` (${type}) for the whole home`);
}

// Runs `connection add`, reading the secret from stdin and never from argv.
async function runAdd(argv, ctx) {
  const usage = "nightqueue connection add <name> --type <type> [--org <name>] [--set <field>=<value>]...";
  const { values, positionals } = parseCommand(argv, {
    type: { type: "string" },
    org: { type: "string" },
    set: { type: "string", multiple: true },
  });
  checkArgs(positionals, { min: 1, usage });
  const name = positionals[0];
  if (!values.type) throw new UserError(`\`connection add\` requires --type <type>; usage: ${usage}`);
  const store = await openRegistryWriter(ctx.env);
  const config = loadConfig(ctx.env, { warn: ctx.err });
  const secrets = loadSecrets(ctx.env, { warn: ctx.err });
  assertName("connection", name);
  const descriptor = requireType(values.type);
  const extra = connectionExtras(values.type, parseExtraFields(values.set, usage));
  if (descriptor.scope === "home") {
    if (values.org !== undefined) throw new UserError(`a ${values.type} connection serves the whole home; drop --org`);
    await addHomeConnection({ ctx, secrets, name, type: values.type, descriptor, extra });
    return;
  }
  const target = values.org === undefined ? await defaultOrg(store, config) : await requireOrg(store, values.org);
  const org = target.name;
  if (hasConnection(secrets, name)) throw new UserError(`connection \`${name}\` already exists; remove it first`);
  const { secret, derived } = await readNewSecret({ ctx, name, type: values.type, descriptor, extra });
  const result = addConnection({ config, secrets, name, type: values.type, orgId: target.id, secret, extra, derived });
  ctx.saveSecrets(result.secrets, ctx.env);
  saveConfigAfterSecret({ config: result.config, ctx, name, org });
  if (result.bound) {
    ctx.out(`stored connection \`${name}\` (${values.type}) and bound it to org \`${org}\``);
    return;
  }
  ctx.out(`stored connection \`${name}\` (${values.type})`);
  ctx.err(
    `nightqueue: warning: org \`${org}\` already uses \`${result.occupiedBy}\` for ${values.type}; run \`nightqueue connection bind ${name} --org ${org}\` to switch`,
  );
}

// Runs `connection bind`.
async function runBind(argv, ctx) {
  const usage = "nightqueue connection bind <name> --org <name>";
  const { values, positionals } = parseCommand(argv, { org: { type: "string" } });
  checkArgs(positionals, { min: 1, usage });
  const name = positionals[0];
  if (!values.org) throw new UserError(`\`connection bind\` requires --org <name>; usage: ${usage}`);
  const store = await openRegistryWriter(ctx.env);
  const config = loadConfig(ctx.env, { warn: ctx.err });
  const secrets = loadSecrets(ctx.env, { warn: ctx.err });
  if (!hasConnection(secrets, name)) throw new UserError(`unknown connection \`${name}\``);
  const org = await requireOrg(store, values.org);
  const result = bindConnection({ config, secrets, name, orgId: org.id });
  ctx.saveConfig(result.config, ctx.env);
  const replaced = result.previous && result.previous !== name ? ` (replaced \`${result.previous}\`)` : "";
  ctx.out(`bound \`${name}\` to org \`${values.org}\` (${result.type})${replaced}`);
}

// Runs `connection list`.
async function runList(argv, ctx) {
  const { values, positionals } = parseCommand(argv, { json: { type: "boolean" } });
  checkArgs(positionals, { max: 0, usage: "nightqueue connection list [--json]" });
  const namesOf = await orgNamesById(ctx);
  const listed = listConnections(loadConfig(ctx.env, { warn: ctx.err }), loadSecrets(ctx.env, { warn: ctx.err }));
  const connections = listed.map((connection) => ({ ...connection, orgs: namesOf(connection.orgs) }));
  if (values.json) {
    ctx.out(JSON.stringify({ connections }));
    return;
  }
  if (connections.length === 0) {
    ctx.out("no connections stored");
    return;
  }
  for (const connection of connections) ctx.out(formatConnection(connection));
}

// Describes a successful connection test with the summary its type declares.
function testSummary(result) {
  const summary = requireType(result.type).summary;
  return typeof summary === "function" ? summary(result) : result.detail;
}

// Runs `connection test`.
async function runTest(argv, ctx) {
  const { positionals } = parseCommand(argv);
  checkArgs(positionals, { min: 1, usage: "nightqueue connection test <name>" });
  const name = positionals[0];
  const result = await testConnection({
    name,
    secrets: loadSecrets(ctx.env, { warn: ctx.err }),
    fetchImpl: ctx.fetchImpl,
  });
  if (!result.ok) throw new UserError(`${name} (${result.type}): failed — ${result.detail}`);
  ctx.out(`${name} (${result.type}): ok — ${testSummary(result)}`);
}

// Clears the log destination of the projects that use a Discord connection about to be removed, answering their names; a home without a database has none.
async function unlinkRemovedDestination(ctx, { name, type }) {
  if (type !== DESTINATION_KIND || !(await openRegistryReader(ctx.env))) return [];
  const store = await openRegistryWriter(ctx.env);
  return (await unlinkProjectsUsing({ store, name })).map((project) => project.name);
}

// Runs `connection remove`.
async function runRemove(argv, ctx) {
  const { positionals } = parseCommand(argv);
  checkArgs(positionals, { min: 1, usage: "nightqueue connection remove <name>" });
  const name = positionals[0];
  const namesOf = await orgNamesById(ctx);
  const secrets = loadSecrets(ctx.env, { warn: ctx.err });
  const type = typeOf(secrets, name);
  const result = removeConnection({ config: loadConfig(ctx.env, { warn: ctx.err }), secrets, name });
  const unlinked = await unlinkRemovedDestination(ctx, { name, type });
  ctx.saveConfig(result.config, ctx.env);
  saveSecretsAfterConfig({ secrets: result.secrets, ctx, name });
  const unbound = result.unboundFrom.length ? namesOf(result.unboundFrom).join(", ") : "none";
  ctx.out(`removed connection \`${name}\`; unbound from: ${unbound}`);
  if (unlinked.length) ctx.out(`unlinked the log destination of: ${unlinked.join(", ")}`);
}

const SUBCOMMANDS = new Map([
  ["add", runAdd],
  ["bind", runBind],
  ["list", runList],
  ["test", runTest],
  ["remove", runRemove],
]);

// Dispatches the subcommands of `nightqueue connection`.
export async function run(argv, ctx) {
  const [sub, ...rest] = argv;
  const handler = SUBCOMMANDS.get(sub);
  if (!handler) {
    throw new UserError(`unknown connection subcommand \`${sub ?? ""}\`; use: ${[...SUBCOMMANDS.keys()].join(", ")}`);
  }
  await handler(rest, ctx);
}
