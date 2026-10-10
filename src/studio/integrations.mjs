// The studio's Settings › Integrations: the module cards, the connections, the projects' log destination, and every write on them.
// Route rule: `POST /api/integrations/<kind>` and `GET /api/integrations/<kind>/status` are keyed by kind (a connection name never
// had a bare-path POST nor a `status` route); every other `/api/integrations/<x>[/…]` route is keyed by connection name.
import { existsSync } from "node:fs";
import { saveConfigAfterSecret, saveSecretsAfterConfig, storeHomeConnection } from "../cli/connection.mjs";
import {
  addConnection,
  bindConnection,
  completeConnection,
  connectionExtras,
  connectionFor,
  hasConnection,
  homeConnectionName,
  lastTestOf,
  listConnections,
  orgsUsingConnection,
  recordTest,
  removeConnection,
  testConnection,
  testReason,
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
import { manyTypes, moduleCards, providerOf } from "../integrations/registry.mjs";
import { jobRef } from "../memory/refs.mjs";
import { refuseHomeWriteInsideJob } from "../queue/home-guard.mjs";
import { openRegistryWriter, withReadOnlyStore } from "../store/open.mjs";

const QUIET = { warn: () => {} };
const MAX_SECRET_CHARS = 512;
const MAX_LINK_IDS = 500;
const TEST_TIMEOUT_MS = 5000;
const NOTHING_SAVED = "Nothing was saved.";
const KIND_PATH = /^\/api\/integrations\/([^/]+)$/;
const STATUS_PATH = /^\/api\/integrations\/([^/]+)\/status$/;
const CONNECTION_PATH = /^\/api\/integrations\/([^/]+)(?:\/(test|orgs|link)(?:\/([^/]+))?)?$/;
const DESTINATION_PATH = /^\/api\/projects\/([^/]+)\/destination$/;
const EMPTY_REGISTRY = { orgs: [], projects: [], integrations: new Map(), notices: [] };
const addsInFlight = new Set();
const statusesInFlight = new Map();

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

// The destination fields of a record a row may show: webhook name, channel and server ids.
function webhookFields(record) {
  const text = (value) => (typeof value === "string" && value ? value : null);
  return { channelId: text(record?.channelId), serverId: text(record?.guildId), webhookName: text(record?.webhookName) };
}

// The ids of the projects a connection serves: its destination projects for a destination kind, its orgs' projects otherwise.
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

// The Settings › Integrations view: module cards, orgs, connections and projects; it calls no service and writes nothing.
export async function integrationsView(env) {
  const { config, secrets } = quietFiles(env);
  const registry = existsSync(dbPath(env)) ? await withReadOnlyStore(env, readRegistry) : EMPTY_REGISTRY;
  const names = new Map(registry.orgs.map((org) => [org.id, org.name]));
  const orgName = (id) => names.get(id) ?? id;
  const listed = listConnections(config, secrets?.connections ? secrets : { connections: {} });
  return {
    modules: moduleCards(),
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

// Refuses an org edit on a connection whose kind does not bind many per org: other kinds keep the CLI's binding rules.
function requireOrgEditable(listed) {
  const kinds = manyTypes();
  if (kinds.includes(listed.type)) return;
  const labels = kinds.map((kind) => providerOf(kind)?.label ?? kind).join(" or ");
  throw new UserError(`only a ${labels} connection is allowed for orgs here; \`${listed.name}\` is a ${listed.type} connection`);
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

// The kind of an add with its provider and descriptor: an unknown kind is a 404, a kind read from the machine a 409.
function addKindOf(kind) {
  const provider = providerOf(kind);
  if (!provider) throw new ApiRefusal(404, `unknown integration \`${kind}\``, { code: "not-found" });
  if (!provider.connection) {
    const hint = provider.ambient?.hint ?? "it has no stored connection";
    throw new ApiRefusal(409, `${kind} is not a stored connection: ${hint}`, { code: "ambient" });
  }
  const descriptor = provider.connection;
  return { kind, provider, descriptor, home: descriptor.scope === "home", one: descriptor.cardinality !== "many" };
}

// The name of an add: required for a kind of many connections, otherwise the given one or the kind's default.
function addNameOf(body, target) {
  const given = typeof body?.name === "string" ? body.name.trim() : "";
  const name = target.one && !given ? (target.home ? target.kind : `${target.kind}-${requiredString(body, "org")}`) : requiredString(body, "name");
  assertName("connection", name);
  return name;
}

// The org an add binds to: required for an org kind, refused for a home-wide one.
function addOrgOf(body, target) {
  if (!target.home) return requiredString(body, "org");
  if (body?.org !== undefined) throw new UserError(`a ${target.kind} connection serves the whole home; drop \`org\``);
  return null;
}

// The secret of an add, trimmed; empty or over the cap is a 422 that never echoes it back.
function addSecretOf(body, target) {
  const field = target.descriptor.secretFields[0];
  const secret = typeof body?.[field] === "string" ? body[field].trim() : "";
  if (secret && secret.length <= MAX_SECRET_CHARS) return secret;
  const text = target.descriptor.tooLong ?? `Invalid ${target.descriptor.secretLabel ?? "secret"}: a value of at most ${MAX_SECRET_CHARS} characters is expected.`;
  throw new ApiRefusal(422, `${text} ${NOTHING_SAVED}`, { code: invalidCodeOf(target) });
}

// The stable code of a refused secret value of a kind.
function invalidCodeOf(target) {
  return `invalid-${String(target.descriptor.secretFields[0]).toLowerCase()}`;
}

// The extra fields of an add, validated against the kind's declaration.
function addExtrasOf(body, target) {
  const extra = body?.extra;
  if (extra !== undefined && (extra === null || typeof extra !== "object" || Array.isArray(extra))) throw new UserError("`extra` expects an object of fields");
  return connectionExtras(target.kind, extra ?? {});
}

// The fields of an add read from its body, in the order a refusal names them; the secret is never echoed back.
function addFields(body, target) {
  const name = addNameOf(body, target);
  const org = addOrgOf(body, target);
  const secret = addSecretOf(body, target);
  return { name, org, secret, extra: addExtrasOf(body, target) };
}

// Refuses a connection name the home already has, naming the orgs that use it.
async function refuseDuplicate({ store, files, name }) {
  if (!hasConnection(files.secrets, name)) return;
  const ids = orgsUsingConnection(files.config, name);
  const orgs = (await store.orgs.list()).filter((org) => ids.includes(org.id)).map((org) => org.name);
  throw new ApiRefusal(409, `A connection named \`${name}\` already exists. ${NOTHING_SAVED}`, { code: "duplicate", details: { orgs } });
}

// Refuses a second connection of a home-wide kind, naming the one the home already has.
function refuseHomeTaken(files, target) {
  const taken = homeConnectionName(files.secrets, target.kind);
  if (taken) throw new ApiRefusal(409, `A home has one ${target.kind} connection: \`${taken}\`; remove it first. ${NOTHING_SAVED}`, { code: "duplicate", details: { orgs: [] } });
}

// Refuses an add on an org slot another connection already holds, naming that connection and never its secret.
function refuseOccupied(files, { target, org }) {
  const bound = connectionFor(files.config, org.id, target.kind);
  if (!bound) return;
  const message = `org ${org.name} already has ${target.kind} connection \`${bound}\`; remove it first. ${NOTHING_SAVED}`;
  throw new ApiRefusal(409, message, { code: "occupied", details: { org: org.name, connection: bound } });
}

// Refuses an add that would clash with what the home holds: the name, the home's one connection, or the org's slot.
async function refuseConflicts({ store, files, add }) {
  await refuseDuplicate({ store, files, name: add.name });
  if (add.target.home) refuseHomeTaken(files, add.target);
  else if (add.target.one) refuseOccupied(files, add);
}

// Refuses an answer of the service that is not a success, with the kind's fixed reason and the status only.
function refuseUnless(kind, result) {
  if (result?.ok) return;
  const reason = testReason(kind, result);
  throw new ApiRefusal(502, `${reason} ${NOTHING_SAVED}`, { code: "refused", details: { status: result?.status ?? null, reason } });
}

// The record a test and a store of an add read: type, secret and extra fields.
function addRecordOf(add) {
  return { type: add.target.kind, [add.target.descriptor.secretFields[0]]: add.secret, ...add.extra };
}

// Tests an add against its service; a failure refuses with nothing stored.
async function testedAdd(add, fetchImpl) {
  const tested = await add.target.descriptor.test(addRecordOf(add), { fetchImpl, timeoutMs: TEST_TIMEOUT_MS });
  refuseUnless(add.target.kind, tested);
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

// Refuses a secret the kind's own shape check rejects, before its service is asked.
function refuseInvalidSecret(add) {
  const invalid = add.target.descriptor.validate?.(add.secret);
  if (invalid) throw new ApiRefusal(422, `${invalid} ${NOTHING_SAVED}`, { code: invalidCodeOf(add.target) });
}

// The fields a stored connection keeps from its test: the kind's own pick, or what the kind derives from its secret.
async function derivedOf(add, { tested, fetchImpl }) {
  const fromTest = add.target.descriptor.fromTest;
  if (typeof fromTest === "function") return fromTest(tested);
  return await completeConnection({ type: add.target.kind, secret: add.secret, extra: add.extra, fetchImpl, timeoutMs: TEST_TIMEOUT_MS });
}

// Announces the connection on its service once the name is reserved and the lock and the conflicts were checked, then stores it.
async function announceAndStore({ env, add, tested, fetchImpl }) {
  const release = reserveName(env, add.name);
  try {
    await nothingSavedOnRefusal(() => lockedWrite(env, async (store) => await refuseConflicts({ store, files: loadFiles(env), add })));
    const announce = add.target.descriptor.announce;
    if (typeof announce === "function") refuseUnless(add.target.kind, await announce(addRecordOf(add), { fetchImpl, timeoutMs: TEST_TIMEOUT_MS }));
    const derived = await derivedOf(add, { tested, fetchImpl });
    await nothingSavedOnRefusal(() => storeAdd({ env, add, derived: { ...derived, lastTest: { ok: true, at: new Date().toISOString(), status: tested.status } } }));
  } finally {
    release();
  }
}

// Stores a verified connection under the lock, re-checking the conflicts: home-wide in the secrets only, or bound to its org.
async function storeAdd({ env, add, derived }) {
  const { name, target, secret, extra, org } = add;
  await lockedWrite(env, async (store) => {
    const files = loadFiles(env);
    await refuseConflicts({ store, files, add });
    if (target.home) {
      storeHomeConnection({ env, secrets: files.secrets, name, type: target.kind, secret, extra, derived, saveSecrets });
      return;
    }
    const result = addConnection({ ...files, name, type: target.kind, orgId: org.id, secret, extra, derived });
    saveSecrets(result.secrets, env);
    saveConfigAfterSecret({ config: result.config, ctx: { saveConfig, env }, name, org: org.name });
  });
}

// Adds a connection of a kind: validated, tested and announced on its service first, then stored (and bound to its org) at once.
export async function addOfKind({ kind, body, env, fetchImpl }) {
  refuseHomeWriteInsideJob(env);
  const target = addKindOf(kind);
  const fields = addFields(body, target);
  const store = await writableStore(env);
  const org = target.home ? null : await requireOrg(store, fields.org);
  const add = { ...fields, target, org };
  await refuseConflicts({ store, files: loadFiles(env), add });
  refuseInvalidSecret(add);
  const tested = await testedAdd(add, fetchImpl);
  await announceAndStore({ env, add, tested, fetchImpl });
  const view = await integrationsView(env);
  return { connection: view.connections.find((row) => row.id === add.name) ?? null };
}

// The status of a kind read from the machine, one probe per home and kind at a time; any other kind is a 404.
export async function ambientStatus({ kind, env }) {
  const status = providerOf(kind)?.ambient?.status;
  if (typeof status !== "function") throw new ApiRefusal(404, `\`${kind}\` has no machine status`, { code: "not-found" });
  const key = `${homeDir(env)}\0${kind}`;
  if (!statusesInFlight.has(key)) {
    const probe = Promise.resolve()
      .then(() => status(env))
      .finally(() => statusesInFlight.delete(key));
    statusesInFlight.set(key, probe);
  }
  return publicStatus(kind, await statusesInFlight.get(key));
}

// The public fields of a machine status: flags and account names only, never raw output.
function publicStatus(kind, status) {
  const text = (value) => (typeof value === "string" && value ? value : null);
  return {
    kind,
    installed: status?.installed !== false,
    authenticated: status?.authenticated === null ? null : status?.authenticated === true,
    login: text(status?.login),
    host: text(status?.host),
    checkedAt: new Date().toISOString(),
  };
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

// Allows a connection of a many-per-org kind for one more org.
export async function allowOrg({ name, body, env }) {
  const orgName = requiredString(body, "org");
  return await lockedWrite(env, async (store) => {
    const org = await requireOrg(store, orgName);
    const files = loadFiles(env);
    requireOrgEditable(requireListed(files, name));
    if (!hasConnection(files.secrets, name)) throw new UserError(`connection \`${name}\` has no stored secret; remove it and add it again`);
    bindConnection({ ...files, name, orgId: org.id });
    saveConfig(files.config, env);
    return { connection: name, org: org.name };
  });
}

// Takes one org away from a many-per-org connection, unlinking that org's projects first when the request confirms it.
export async function removeOrg({ name, orgName, unlink, env }) {
  return await lockedWrite(env, async (store) => {
    const org = await requireOrg(store, orgName);
    const files = loadFiles(env);
    requireOrgEditable(requireListed(files, name));
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

// Links many projects to a destination connection, all of them or none.
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

// The handler of one kind-keyed request (an add, or a machine status), or null when the request is not one.
function kindHandler(req, path, ctx) {
  const { env, fetchImpl, readBody } = ctx;
  const add = req.method === "POST" ? KIND_PATH.exec(path) : null;
  if (add) return async () => ({ status: 201, body: await addOfKind({ kind: segmentOf(add[1]), body: await readBody(req), env, fetchImpl }) });
  const status = req.method === "GET" ? STATUS_PATH.exec(path) : null;
  if (status) return async () => ({ status: 200, body: await ambientStatus({ kind: segmentOf(status[1]), env }) });
  return null;
}

// The handler of one Settings › Integrations request, or null when the path and method are not one of its routes.
function integrationsHandler(req, path, ctx) {
  const { env, readBody } = ctx;
  if (path === "/api/integrations" && req.method === "GET") return async () => ({ status: 200, body: await integrationsView(env) });
  const byKind = kindHandler(req, path, ctx);
  if (byKind) return byKind;
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
