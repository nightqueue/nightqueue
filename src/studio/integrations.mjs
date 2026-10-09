// The studio's Settings › Integrations: the connections, the projects' log destination, and every write on them.
import { existsSync } from "node:fs";
import { saveConfigAfterSecret, saveSecretsAfterConfig } from "../cli/connection.mjs";
import {
  addConnection,
  bindConnection,
  hasConnection,
  lastTestOf,
  listConnections,
  orgsUsingConnection,
  recordTest,
  removeConnection,
  requireType,
  testConnection,
  unbindConnection,
} from "../config/connections.mjs";
import { UserError } from "../config/errors.mjs";
import { requireOrg } from "../config/orgs.mjs";
import { dbPath, homeDir } from "../config/paths.mjs";
import { assertName } from "../config/schema.mjs";
import { loadConfig, loadSecrets, saveConfig, saveSecrets } from "../config/store.mjs";
import { withLock } from "../config/lock.mjs";
import { quietFiles } from "../integrations/coverage.mjs";
import {
  DESTINATION_KIND,
  DestinationNotFound,
  NotAllowedForOrg,
  destinationOf,
  linkProjects,
  projectsUsing,
  setDestination,
  unlinkProjectsUsing,
} from "../integrations/destinations.mjs";
import { announceWebhook, discordReason, isWebhookUrl } from "../integrations/discord.mjs";
import { jobRef } from "../memory/refs.mjs";
import { refuseHomeWriteInsideJob } from "../queue/home-guard.mjs";
import { openRegistryWriter, withReadOnlyStore } from "../store/open.mjs";

const QUIET = { warn: () => {} };
const MAX_URL_CHARS = 512;
const MAX_LINK_IDS = 500;
const TEST_TIMEOUT_MS = 5000;
const NOTHING_SAVED = "Nothing was saved.";
const CONNECTION_PATH = /^\/api\/integrations\/([^/]+)(?:\/(test|orgs|link)(?:\/([^/]+))?)?$/;
const DESTINATION_PATH = /^\/api\/projects\/([^/]+)\/destination$/;
const EMPTY_REGISTRY = { orgs: [], projects: [], integrations: new Map(), notices: [] };
const addsInFlight = new Set();

// A refusal the API answers with its own status, a stable `code` and structured details.
export class ApiRefusal extends Error {
  constructor(status, message, { code, details = {} } = {}) {
    super(message);
    this.name = "ApiRefusal";
    this.status = status;
    this.code = code ?? null;
    this.details = details;
  }
}

// Reads config.json and secrets.json for a write, a broken file refusing the write.
function loadFiles(env) {
  return { config: loadConfig(env, QUIET), secrets: loadSecrets(env, QUIET) };
}

// The registry facts the view reads: orgs, projects with their integrations, and each project's last log step.
async function readRegistry(store) {
  const [orgs, projects, notices] = await Promise.all([store.orgs.list(), store.projects.list(), store.jobs.lastLogResults()]);
  const integrations = new Map();
  for (const project of projects) integrations.set(project.id, await store.projects.integrations(project.id));
  return { orgs, projects, integrations, notices };
}

// The last test of a record as public fields only, or null when it was never tested.
function publicLastTest(lastTest) {
  if (!lastTest || typeof lastTest !== "object" || typeof lastTest.ok !== "boolean") return null;
  const answer = { ok: lastTest.ok, at: typeof lastTest.at === "string" ? lastTest.at : null, status: Number.isInteger(lastTest.status) ? lastTest.status : null };
  return typeof lastTest.reason === "string" ? { ...answer, reason: lastTest.reason } : answer;
}

// The Discord fields of a record a row may show: webhook name, channel and server ids.
function webhookFields(record) {
  const text = (value) => (typeof value === "string" && value ? value : null);
  return { channelId: text(record?.channelId), serverId: text(record?.guildId), webhookName: text(record?.webhookName) };
}

// The ids of the projects a connection serves: its destination projects for Discord, its orgs' projects otherwise.
function usedByOf(listed, registry) {
  if (listed.type === DESTINATION_KIND) return registry.projects.filter((project) => destinationOf(registry.integrations.get(project.id)) === listed.name).map((project) => project.id);
  if (listed.scope === "home") return registry.projects.map((project) => project.id);
  return registry.projects.filter((project) => listed.orgs.includes(project.org_id)).map((project) => project.id);
}

// One connection row of the view, built from whitelisted fields only: a secret never reaches it.
function connectionRow(listed, { secrets, registry, orgName }) {
  const record = secrets?.connections?.[listed.name];
  const row = {
    id: listed.name,
    name: listed.name,
    type: listed.type,
    present: listed.present,
    scope: listed.scope === "home" ? "home" : "org",
    orgs: listed.orgs.map(orgName),
    lastTest: publicLastTest(record?.lastTest),
    usedBy: usedByOf(listed, registry),
  };
  return listed.type === DESTINATION_KIND ? { ...row, ...webhookFields(record) } : row;
}

// One project row of the view: its org, its destination and the last notice its closed jobs logged.
function projectRow(project, registry) {
  const notice = registry.notices.find((entry) => entry.projectId === project.id);
  return {
    id: project.id,
    name: project.name,
    org: project.org,
    destination: destinationOf(registry.integrations.get(project.id)),
    lastNotice: notice ? { jobRef: jobRef(notice.jobId), at: notice.at, ok: notice.ok, note: notice.note } : null,
  };
}

// The Settings › Integrations view: orgs, connections and projects; it calls no service and writes nothing.
export async function integrationsView(env) {
  const { config, secrets } = quietFiles(env);
  const registry = existsSync(dbPath(env)) ? await withReadOnlyStore(env, readRegistry) : EMPTY_REGISTRY;
  const names = new Map(registry.orgs.map((org) => [org.id, org.name]));
  const orgName = (id) => names.get(id) ?? id;
  const listed = listConnections(config, secrets?.connections ? secrets : { connections: {} });
  return {
    orgs: registry.orgs.map((org) => ({ id: org.id, name: org.name, projects: registry.projects.filter((project) => project.org_id === org.id).length })),
    connections: listed.map((entry) => connectionRow(entry, { secrets, registry, orgName })),
    projects: registry.projects.map((project) => projectRow(project, registry)),
  };
}

// The writable store of a home that already has a database; a home without one has no org nor project to change.
async function writableStore(env) {
  if (!existsSync(dbPath(env))) throw new UserError("this home has no registry yet; run `nightqueue setup` first");
  return await openRegistryWriter(env);
}

// The API refusal a destination error stands for: 403 with the org for a not-allowed connection, 404 for a missing target.
async function destinationRefusal(store, err) {
  if (err instanceof NotAllowedForOrg) {
    const org = await store.orgs.byId(err.orgId);
    const details = { org: org?.name ?? err.orgId, connectionId: err.connection, projectId: err.projectId };
    return new ApiRefusal(403, err.message, { code: "not-allowed-for-org", details });
  }
  if (err instanceof DestinationNotFound) return new ApiRefusal(404, err.message, { code: "not-found" });
  return err;
}

// Runs a write inside the configuration lock with the writable store; refused inside a job before anything is read.
async function lockedWrite(env, write) {
  refuseHomeWriteInsideJob(env);
  return await withLock(env, async () => {
    const store = await writableStore(env);
    try {
      return await write(store);
    } catch (err) {
      throw await destinationRefusal(store, err);
    }
  });
}

// The `connection list` row of a connection, stored or only bound; an unknown one is a 404.
function requireListed(files, name) {
  const listed = listConnections(files.config, files.secrets).find((entry) => entry.name === name);
  if (!listed) throw new ApiRefusal(404, `unknown connection \`${name}\``, { code: "not-found" });
  return listed;
}

// Refuses an org edit on a connection that is not Discord: other types keep the CLI's binding rules.
function requireDiscordRow(listed) {
  if (listed.type !== DESTINATION_KIND) throw new UserError(`only a Discord connection is allowed for orgs here; \`${listed.name}\` is a ${listed.type} connection`);
}

// Refuses a remove that would leave projects without notice, unless the request asked to unlink them.
function refuseInUse(using, unlink) {
  if (!using.length || unlink) return;
  const usedBy = using.map((project) => ({ id: project.id, name: project.name }));
  throw new ApiRefusal(409, `the connection is the log destination of ${using.length} project(s); confirm with ?unlink=1`, { code: "in-use", details: { usedBy } });
}

// A required non-empty string field of a body, trimmed.
function requiredString(body, field) {
  const value = typeof body?.[field] === "string" ? body[field].trim() : "";
  if (!value) throw new UserError(`\`${field}\` expects a non-empty string`);
  return value;
}

// The name, org and webhook URL of an add; the URL is never echoed back, not even in a refusal.
function addFields(body) {
  const name = requiredString(body, "name");
  assertName("connection", name);
  const org = requiredString(body, "org");
  const url = typeof body?.url === "string" ? body.url.trim() : "";
  if (!url || url.length > MAX_URL_CHARS) throw new ApiRefusal(422, `Invalid URL: a Discord webhook URL of at most ${MAX_URL_CHARS} characters is expected. ${NOTHING_SAVED}`, { code: "invalid-url" });
  return { name, org, url };
}

// Refuses a connection name the home already has, naming the orgs that use it.
async function refuseDuplicate({ store, files, name }) {
  if (!hasConnection(files.secrets, name)) return;
  const ids = orgsUsingConnection(files.config, name);
  const orgs = (await store.orgs.list()).filter((org) => ids.includes(org.id)).map((org) => org.name);
  throw new ApiRefusal(409, `A connection named \`${name}\` already exists. ${NOTHING_SAVED}`, { code: "duplicate", details: { orgs } });
}

// Refuses a Discord answer that is not a success, with the fixed reason and the status only.
function refuseUnless(result) {
  if (result.ok) return;
  const reason = discordReason(result);
  throw new ApiRefusal(502, `${reason} ${NOTHING_SAVED}`, { code: "refused", details: { status: result.status, reason } });
}

// Reads the webhook from Discord; a failure refuses with nothing stored.
async function testedWebhook(url, fetchImpl) {
  const tested = await requireType(DESTINATION_KIND).test({ type: DESTINATION_KIND, url }, { fetchImpl, timeoutMs: TEST_TIMEOUT_MS });
  refuseUnless(tested);
  return tested;
}

// Reserves a connection name for one add of this process, answering its release; a name another add is still announcing is refused.
function reserveName(env, name) {
  const key = `${homeDir(env)}\0${name}`;
  if (addsInFlight.has(key)) throw new ApiRefusal(409, `A connection named \`${name}\` is being added right now. ${NOTHING_SAVED}`, { code: "duplicate", details: { orgs: [] } });
  addsInFlight.add(key);
  return () => addsInFlight.delete(key);
}

// Runs one guarded step of an add, a usage refusal (such as a busy lock) telling that nothing was saved.
async function nothingSavedOnRefusal(step) {
  try {
    return await step();
  } catch (err) {
    if (!(err instanceof UserError) || err.message.includes(NOTHING_SAVED)) throw err;
    throw new UserError(`${err.message.replace(/\.?$/, ".")} ${NOTHING_SAVED}`);
  }
}

// Posts the "nightqueue connected" embed once the name is reserved and the lock and the name were checked, then stores the connection.
async function announceAndStore({ env, name, org, url, tested, fetchImpl }) {
  const release = reserveName(env, name);
  try {
    await nothingSavedOnRefusal(() => lockedWrite(env, async (store) => await refuseDuplicate({ store, files: loadFiles(env), name })));
    refuseUnless(await announceWebhook({ url }, { fetchImpl, timeoutMs: TEST_TIMEOUT_MS }));
    await nothingSavedOnRefusal(() => storeDiscord({ env, name, org, url, tested }));
  } finally {
    release();
  }
}

// Stores a verified Discord connection under the lock, re-checking the name, and binds it to the org.
async function storeDiscord({ env, name, org, url, tested }) {
  const at = new Date().toISOString();
  const named = tested.webhookName ? { webhookName: tested.webhookName } : {};
  const derived = { channelId: tested.channelId, guildId: tested.guildId, ...named, mode: "webhook", lastTest: { ok: true, at, status: tested.status } };
  await lockedWrite(env, async (store) => {
    const files = loadFiles(env);
    await refuseDuplicate({ store, files, name });
    const result = addConnection({ ...files, name, type: DESTINATION_KIND, orgId: org.id, secret: url, derived });
    saveSecrets(result.secrets, env);
    saveConfigAfterSecret({ config: result.config, ctx: { saveConfig, env }, name, org: org.name });
  });
}

// Adds a Discord connection for an org: validated, read and announced on Discord first, then stored and bound at once.
export async function addDiscord({ body, env, fetchImpl }) {
  refuseHomeWriteInsideJob(env);
  const { name, org: orgName, url } = addFields(body);
  const store = await writableStore(env);
  const org = await requireOrg(store, orgName);
  await refuseDuplicate({ store, files: loadFiles(env), name });
  if (!isWebhookUrl(url)) throw new ApiRefusal(422, `Invalid URL: expected https://discord.com/api/webhooks/<id>/<token>. ${NOTHING_SAVED}`, { code: "invalid-url" });
  const tested = await testedWebhook(url, fetchImpl);
  await announceAndStore({ env, name, org, url, tested, fetchImpl });
  const view = await integrationsView(env);
  return { connection: view.connections.find((row) => row.id === name) ?? null };
}

// Tests one stored connection against its service and records the outcome on its record; a failed test is an answer, not an error.
export async function testOne({ name, env, fetchImpl }) {
  refuseHomeWriteInsideJob(env);
  const secrets = loadSecrets(env, QUIET);
  if (!hasConnection(secrets, name)) throw new ApiRefusal(404, `unknown connection \`${name}\``, { code: "not-found" });
  const result = await testConnection({ name, secrets, fetchImpl, timeoutMs: TEST_TIMEOUT_MS });
  const at = new Date().toISOString();
  return await withLock(env, async () => {
    const fresh = loadSecrets(env, QUIET);
    const stored = recordTest({ secrets: fresh, name, tested: secrets.connections[name], result, at });
    if (stored) saveSecrets(fresh, env);
    return stored ?? lastTestOf({ type: result.type, result, at });
  });
}

// Allows a Discord connection for one more org.
export async function allowOrg({ name, body, env }) {
  const orgName = requiredString(body, "org");
  return await lockedWrite(env, async (store) => {
    const org = await requireOrg(store, orgName);
    const files = loadFiles(env);
    requireDiscordRow(requireListed(files, name));
    if (!hasConnection(files.secrets, name)) throw new UserError(`connection \`${name}\` has no stored secret; remove it and add it again`);
    bindConnection({ ...files, name, orgId: org.id });
    saveConfig(files.config, env);
    return { connection: name, org: org.name };
  });
}

// Takes one org away from a Discord connection, unlinking that org's projects first when the request confirms it.
export async function removeOrg({ name, orgName, unlink, env }) {
  return await lockedWrite(env, async (store) => {
    const org = await requireOrg(store, orgName);
    const files = loadFiles(env);
    requireDiscordRow(requireListed(files, name));
    refuseInUse(await projectsUsing({ store, name, orgIds: [org.id] }), unlink);
    const unlinked = await unlinkProjectsUsing({ store, name, orgIds: [org.id] });
    unbindConnection({ ...files, name, orgId: org.id });
    saveConfig(files.config, env);
    return { connection: name, org: org.name, unlinked: unlinked.map((project) => project.id) };
  });
}

// Removes a connection after unlinking its projects (database, then config, then secrets); a bound one without a secret is only unbound.
export async function removeOne({ name, unlink, env }) {
  return await lockedWrite(env, async (store) => {
    const files = loadFiles(env);
    const listed = requireListed(files, name);
    const isDestination = listed.type === DESTINATION_KIND;
    if (isDestination) refuseInUse(await projectsUsing({ store, name }), unlink);
    const unlinked = isDestination ? await unlinkProjectsUsing({ store, name }) : [];
    if (listed.present) removeConnection({ ...files, name });
    else for (const orgId of listed.orgs) unbindConnection({ ...files, name, orgId });
    saveConfig(files.config, env);
    if (listed.present) saveSecretsAfterConfig({ secrets: files.secrets, ctx: { saveSecrets, env }, name });
    return { removed: name, unlinked: unlinked.map((project) => project.id) };
  });
}

// The project ids of a batch link: a non-empty list of at most 500 strings.
function projectIdsOf(body) {
  const ids = body?.projectIds;
  if (!Array.isArray(ids) || !ids.length || ids.length > MAX_LINK_IDS || !ids.every((id) => typeof id === "string" && id)) {
    throw new UserError(`\`projectIds\` expects a non-empty list of at most ${MAX_LINK_IDS} project ids`);
  }
  return ids;
}

// Links many projects to a Discord connection, all of them or none.
export async function linkMany({ name, body, env }) {
  const projectIds = projectIdsOf(body);
  return await lockedWrite(env, async (store) => await linkProjects({ store, name, projectIds, files: loadFiles(env) }));
}

// The connection a destination request names: a name, or null to clear it.
function connectionIdOf(body) {
  const value = body?.connectionId;
  if (value === null) return null;
  if (typeof value === "string" && value.trim()) return value.trim();
  throw new UserError("`connectionId` expects a connection name or null");
}

// Sets or clears the log destination of one project.
export async function putDestination({ projectId, body, env }) {
  const name = connectionIdOf(body);
  return await lockedWrite(env, async (store) => {
    const project = await store.projects.byId(projectId);
    if (!project) throw new ApiRefusal(404, `unknown project \`${projectId}\``, { code: "not-found" });
    return { project: project.id, destination: await setDestination({ store, project, name, files: loadFiles(env) }) };
  });
}

// A path segment decoded; a malformed escape is refused.
function segmentOf(raw) {
  try {
    return decodeURIComponent(raw);
  } catch {
    throw new UserError(`unreadable path segment \`${raw}\``);
  }
}

// Tells whether a request confirmed unlinking with `?unlink=1`.
function unlinkAsked(url) {
  return new URL(url ?? "/", "http://x").searchParams.get("unlink") === "1";
}

// The handler of one `/api/integrations/<name>[/…]` request, or null for a method the path does not have.
function connectionHandler({ req, match, ctx }) {
  const [, rawName, sub, rawOrg] = match;
  const name = segmentOf(rawName);
  const unlink = unlinkAsked(req.url);
  const { env, fetchImpl, readBody } = ctx;
  if (!sub && req.method === "DELETE") return async () => ({ status: 200, body: await removeOne({ name, unlink, env }) });
  if (sub === "test" && !rawOrg && req.method === "POST") return async () => ({ status: 200, body: await testOne({ name, env, fetchImpl }) });
  if (sub === "orgs" && !rawOrg && req.method === "POST") return async () => ({ status: 200, body: await allowOrg({ name, body: await readBody(req), env }) });
  if (sub === "orgs" && rawOrg && req.method === "DELETE") return async () => ({ status: 200, body: await removeOrg({ name, orgName: segmentOf(rawOrg), unlink, env }) });
  if (sub === "link" && !rawOrg && req.method === "POST") return async () => ({ status: 200, body: await linkMany({ name, body: await readBody(req), env }) });
  return null;
}

// The handler of one Settings › Integrations request, or null when the path and method are not one of its routes.
function integrationsHandler(req, path, ctx) {
  const { env, fetchImpl, readBody } = ctx;
  if (path === "/api/integrations" && req.method === "GET") return async () => ({ status: 200, body: await integrationsView(env) });
  if (path === "/api/integrations/discord" && req.method === "POST") return async () => ({ status: 201, body: await addDiscord({ body: await readBody(req), env, fetchImpl }) });
  const destination = DESTINATION_PATH.exec(path);
  if (destination && req.method === "PUT") return async () => ({ status: 200, body: await putDestination({ projectId: segmentOf(destination[1]), body: await readBody(req), env }) });
  const connection = CONNECTION_PATH.exec(path);
  return connection ? connectionHandler({ req, match: connection, ctx }) : null;
}

// Serves one Settings › Integrations request as `{ status, body }`, or null when the request is not one of its routes.
export async function serveIntegrations(req, { path, env, fetchImpl, readBody }) {
  const handler = integrationsHandler(req, path, { env, fetchImpl: fetchImpl ?? globalThis.fetch, readBody });
  return handler ? await handler() : null;
}
