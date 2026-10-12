// The studio's Settings › Projects & orgs: the listings, the folder browser, and every write on projects and orgs.
// Every write is the runtime's own function under the config lock; a refusal code comes from the runtime's preconditions
// run in order before it, never from the text of a runtime message.
import { existsSync } from "node:fs";
import { purgeProjectRows, projectListing } from "../cli/project.mjs";
import { UserError } from "../config/errors.mjs";
import { isId } from "../config/ids.mjs";
import { addOrg, defaultOrg, listOrgs, removeOrg, renameOrg, requireOrg, setDefaultOrg, setOrgKey } from "../config/orgs.mjs";
import { dbPath } from "../config/paths.mjs";
import { ALL_PROJECTS, mainCheckoutOf, registerProject, renameProject, requireGitPath, suggestName } from "../config/projects.mjs";
import { assertName } from "../config/schema.mjs";
import { loadConfig, loadSecrets, saveConfig } from "../config/store.mjs";
import { orgUsesConnection } from "../integrations/connections.mjs";
import { quietFiles } from "../integrations/coverage.mjs";
import { CONNECTION_KEY, setDestination } from "../integrations/destinations.mjs";
import { applyIntegrationChange, getSetting, providerSettingsView } from "../integrations/settings.mjs";
import { jobRef, requireKey, suggestKey } from "../memory/refs.mjs";
import { withReadOnlyStore } from "../store/open.mjs";
import { expandPath, listDirs, originOf, repoFacts, userHome } from "./fs-dirs.mjs";
import { ApiRefusal, lockedWrite } from "./integrations.mjs";

const QUIET = { warn: () => {} };
const PROJECT_PATH = /^\/api\/projects\/([^/]+)$/;
const ORG_PATH = /^\/api\/orgs\/([^/]+)$/;
const RECENT_JOBS = 50;
const PROJECT_STEPS = ["name", "key", "org", "path", "integrations"];
const ORG_STEPS = ["name", "key", "isDefault"];
const PROJECT_RESIDUALS = {
  name: [409, "name-taken"],
  key: [409, "key-taken"],
  org: [409, "refused"],
  path: [409, "already-registered"],
  integrations: [422, "integration-invalid"],
};
const ORG_RESIDUALS = { name: [409, "name-taken"], key: [409, "key-taken"], isDefault: [409, "refused"] };
const KEY_KINDS = new Set(["project", "org"]);

// Tells whether the home already has a database.
function hasDb(env) {
  return existsSync(dbPath(env));
}

// Tells whether a value is a plain object.
function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

// The 404 of an unknown project or org id.
function notFound(kind, id) {
  return new ApiRefusal(404, `unknown ${kind} \`${id}\``, { code: "not-found" });
}

// Runs a validation, turning its usage error into an API refusal with the given status and code.
function coded(status, code, check) {
  try {
    return check();
  } catch (err) {
    if (err instanceof UserError) throw new ApiRefusal(status, err.message, { code });
    throw err;
  }
}

// A valid project name, `all` refused like the runtime refuses it; 422 `name-invalid` otherwise.
function validProjectName(name) {
  return coded(422, "name-invalid", () => {
    if (name === null) throw new UserError("cannot derive a valid project name from that folder; pass a name");
    assertName("project", name);
    if (name === ALL_PROJECTS) throw new UserError(`project name \`${ALL_PROJECTS}\` is reserved: it targets every project of an org`);
    return name;
  });
}

// A valid org name; 422 `name-invalid` otherwise.
function validOrgName(name) {
  return coded(422, "name-invalid", () => assertName("org", name));
}

// A key normalised the runtime's way; 422 `key-invalid` otherwise.
function validKey(key) {
  return coded(422, "key-invalid", () => requireKey(key));
}

// The org a request names, by id or by name; 422 `org-unknown` otherwise.
async function orgOf(store, ref) {
  const byId = isId(ref) ? await store.orgs.byId(ref) : null;
  if (byId) return byId;
  try {
    return await requireOrg(store, ref);
  } catch (err) {
    if (err instanceof UserError) throw new ApiRefusal(422, err.message, { code: "org-unknown" });
    throw err;
  }
}

// The checkout a requested path registers: the git repository it names and the main checkout of a linked worktree; 422 `not-a-git-repo` otherwise.
function checkoutOf(raw, env) {
  return coded(422, "not-a-git-repo", () => {
    if (!raw) throw new UserError("`path` expects the folder of a git repository");
    const requested = requireGitPath(expandPath(raw, userHome(env)));
    return { requested, abs: mainCheckoutOf(requested) };
  });
}

// Refuses a checkout another project already holds, naming it.
async function refusePathTaken(store, abs, ownId) {
  const holder = (await store.projects.list()).find((project) => project.path === abs && project.id !== ownId);
  if (!holder) return;
  const project = { id: holder.id, name: holder.name, org: holder.org };
  throw new ApiRefusal(409, `${abs} is already registered as \`${holder.name}\` in org \`${holder.org}\``, { code: "already-registered", details: { project } });
}

// Refuses a project name another project already holds, naming it and its checkout.
async function refuseProjectNameTaken(store, name, ownId) {
  const holder = await store.projects.byName(name);
  if (!holder || holder.id === ownId) return;
  const where = holder.path ? `is already registered for ${holder.path}` : "is already known without a checkout";
  throw new ApiRefusal(409, `project name \`${name}\` ${where}`, { code: "name-taken", details: { project: { id: holder.id, name: holder.name, path: holder.path } } });
}

// Refuses an org name another org already holds.
async function refuseOrgNameTaken(store, name, ownId) {
  const holder = await store.orgs.byName(name);
  if (holder && holder.id !== ownId) throw new ApiRefusal(409, `org \`${name}\` already exists`, { code: "name-taken" });
}

// The job running on each project, by project id: a `running` job or a close holding a live lease, the condition a purge refuses.
async function runningJobs(store) {
  const [open, recent, closes] = await Promise.all([store.jobs.listOpenJobs(), store.jobs.listJobs({ limit: RECENT_JOBS }), store.jobs.listCloses()]);
  const running = new Map();
  for (const job of [...open, ...recent]) if (job.status === "running" && !running.has(job.project_id)) running.set(job.project_id, job.id);
  for (const job of closes) {
    const closing = job.close_status === "closing" && Number(job.close_lease_live) === 1;
    if (closing && !running.has(job.project_id)) running.set(job.project_id, job.id);
  }
  return running;
}

// The connection settings of a project that an org does not use, the ones a move to that org unsets.
export function connectionSettingsLostIn(integrations, orgId, config) {
  const keys = providerSettingsView().flatMap((provider) => provider.keys.filter((entry) => entry.type === "connection").map((entry) => ({ ...entry, kind: provider.kind })));
  return keys
    .filter((entry) => {
      const name = getSetting(integrations, entry.kind, entry.key.slice(entry.kind.length + 1));
      return typeof name === "string" && name && !orgUsesConnection({ config, orgId, kind: entry.kind, name });
    })
    .map((entry) => entry.key);
}

// The settings a move to each other org would unset, only the orgs where there is any.
function unlinkedByMoveOf(project, integrations, context) {
  const answer = {};
  if (!context.config) return answer;
  for (const org of context.orgs) {
    if (org.id === project.org_id) continue;
    const lost = connectionSettingsLostIn(integrations, org.id, context.config);
    if (lost.length) answer[org.id] = lost;
  }
  return answer;
}

// Reads config.json, or null when it cannot be read, so a broken file is never mistaken for an empty one.
function configOrNull(env) {
  try {
    return loadConfig(env, QUIET);
  } catch {
    return null;
  }
}

// Reads config.json and secrets.json for a write; a broken file refuses the step instead of reading as empty.
function strictFiles(env) {
  return { config: loadConfig(env, QUIET), secrets: loadSecrets(env, QUIET) };
}

// The facts every project row of one answer shares: old keys, orgs, running jobs and the config.
async function rowContext(store, env) {
  const [aliases, orgs, running] = await Promise.all([store.projects.keyAliases(), store.orgs.list(), runningJobs(store)]);
  return { aliases, orgs, running, config: configOrNull(env), env };
}

// One project row of the Settings answer: the CLI's listing plus origin, integrations, footprint, running job and move preview.
async function projectRow(store, project, context) {
  const listing = projectListing(project, context.aliases);
  const integrations = await store.projects.integrations(project.id);
  const runningId = context.running.get(project.id);
  return {
    ...listing,
    origin: listing.exists ? await originOf(listing.path, context.env) : null,
    integrations,
    footprint: await store.projects.footprint(project.id),
    runningJob: runningId ? { ref: jobRef(runningId) } : null,
    unlinkedByMove: unlinkedByMoveOf(project, integrations, context),
  };
}

// The row of one project by id, read again from the store.
async function rowOfId(store, id, env) {
  const project = await store.projects.byId(id);
  return project ? await projectRow(store, project, await rowContext(store, env)) : null;
}

// The Settings › Projects answer: every project with its facts, and the settings each provider offers.
export async function projectsAnswer(env) {
  const providers = providerSettingsView();
  if (!hasDb(env)) return { projects: [], providers };
  const projects = await withReadOnlyStore(env, async (store) => {
    const context = await rowContext(store, env);
    return await Promise.all((await store.projects.list()).map((project) => projectRow(store, project, context)));
  });
  return { projects, providers };
}

// The orgs of the home as `org list --json` lists them.
export async function orgsAnswer(env) {
  if (!hasDb(env)) return { orgs: [] };
  return { orgs: await withReadOnlyStore(env, async (store) => await listOrgs(store, quietFiles(env).config)) };
}

// An optional string field of a body; any other type than a string is refused.
function optionalString(body, field) {
  const value = body?.[field];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new UserError(`\`${field}\` expects a string`);
  return value.trim();
}

// Refuses a body field the route does not know.
function refuseUnknownFields(body, allowed) {
  const unknown = Object.keys(body ?? {}).filter((field) => !allowed.includes(field));
  if (unknown.length) throw new UserError(`unknown field(s) ${unknown.map((field) => `\`${field}\``).join(", ")}; expected: ${allowed.join(", ")}`);
}

// The fields of a project registration: a path, and an optional name, key and org.
function registrationOf(body) {
  refuseUnknownFields(body, ["path", "name", "key", "org"]);
  const path = optionalString(body, "path");
  if (!path) throw new UserError("`path` expects the folder of a git repository");
  return { path, name: optionalString(body, "name") || undefined, key: optionalString(body, "key") || undefined, org: optionalString(body, "org") || undefined };
}

// Registers a git repository as a project, the way `nightqueue project add` does, each refusal with its own code.
export async function createProject(body, env) {
  const fields = registrationOf(body);
  return await lockedWrite(env, async (store) => {
    const { requested, abs } = checkoutOf(fields.path, env);
    await refusePathTaken(store, abs, null);
    const name = validProjectName(fields.name ?? suggestName([], abs));
    await refuseProjectNameTaken(store, name, null);
    const key = fields.key === undefined ? null : validKey(fields.key);
    const org = fields.org === undefined ? null : await orgOf(store, fields.org);
    const created = await registerProject(store, loadConfig(env, QUIET), { path: abs, name, org: org?.name, key }).catch((err) => {
      if (err instanceof UserError) throw new ApiRefusal(409, err.message, { code: key ? "key-taken" : "refused" });
      throw err;
    });
    const row = await rowOfId(store, created.project.id, env);
    return requested === abs ? { project: row } : { project: row, registeredFrom: requested };
  });
}

// The integrations change of a PATCH: `{ set?: {key: text}, unset?: [key] }`.
function integrationsPatchOf(value) {
  if (value === undefined) return undefined;
  if (!isPlainObject(value)) throw new UserError("`integrations` expects `{ set?: {<kind.key>: <text>}, unset?: [<kind.key>] }`");
  refuseUnknownFields(value, ["set", "unset"]);
  const set = value.set ?? {};
  const unset = value.unset ?? [];
  if (!isPlainObject(set) || !Object.values(set).every((text) => typeof text === "string")) throw new UserError("`integrations.set` expects an object of text values");
  if (!Array.isArray(unset) || !unset.every((key) => typeof key === "string")) throw new UserError("`integrations.unset` expects a list of setting keys");
  return { set, unset };
}

// The fields of a project PATCH, each optional.
function projectPatchOf(body) {
  refuseUnknownFields(body, PROJECT_STEPS);
  return {
    name: optionalString(body, "name"),
    key: optionalString(body, "key"),
    org: optionalString(body, "org"),
    path: optionalString(body, "path"),
    integrations: integrationsPatchOf(body?.integrations),
  };
}

// The refusal of one step of an ordered PATCH: its own code or the step's residual one, with the step, the reason and what was applied.
async function refusedStep({ err, step, applied, residuals, current }) {
  if (!(err instanceof UserError) && !(err instanceof ApiRefusal)) return err;
  const [status, code] = residuals[step];
  const base = err instanceof ApiRefusal ? err : new ApiRefusal(status, err.message, { code });
  const details = { ...base.details, step, reason: base.message, applied: [...applied], ...(await current()) };
  return new ApiRefusal(base.status, base.message, { code: base.code, details });
}

// Applies the steps of a PATCH in their fixed order, stopping at the first refusal; answers the steps applied.
async function applySteps({ order, patch, handlers, residuals, current }) {
  const applied = [];
  for (const step of order) {
    if (patch[step] === undefined) continue;
    try {
      if (await handlers[step](patch[step])) applied.push(step);
    } catch (err) {
      throw await refusedStep({ err, step, applied, residuals, current });
    }
  }
  return applied;
}

// Unsets the connection settings the project's new org does not use, answering the keys it unset.
async function unlinkLostConnections(store, project, files) {
  const lost = connectionSettingsLostIn(await store.projects.integrations(project.id), project.org_id, files.config);
  if (lost.includes(CONNECTION_KEY)) await setDestination({ store, project, name: null, files });
  const others = lost.filter((key) => key !== CONNECTION_KEY);
  if (others.length) {
    const current = await store.projects.integrations(project.id);
    await store.projects.setIntegrations(project.id, others.reduce((next, key) => applyIntegrationChange({ current: next, action: "unset", key }), current));
  }
  return lost;
}

// The integrations after a PATCH's sets and then its unsets, validated against the project's current org.
function nextIntegrations(current, change, { project, files }) {
  const apply = (next, action, key, value) => applyIntegrationChange({ current: next, action, key, value, orgId: project.org_id, ...files });
  const afterSets = Object.entries(change.set).reduce((next, [key, value]) => apply(next, "set", key, value), current);
  return change.unset.reduce((next, key) => apply(next, "unset", key), afterSets);
}

// The handlers of the project PATCH steps; each re-reads the project and answers whether it wrote.
function projectStepHandlers({ store, env, id, unlinked }) {
  const read = async () => await store.projects.byId(id);
  return {
    name: async (name) => {
      const project = await read();
      if (name === project.name) return false;
      validProjectName(name);
      await refuseProjectNameTaken(store, name, id);
      await renameProject(store, project.name, name);
      return true;
    },
    key: async (raw) => {
      const key = validKey(raw);
      if (key === (await read()).key) return false;
      await store.projects.setKey(id, key);
      return true;
    },
    org: async (ref) => {
      const org = await orgOf(store, ref);
      if (org.id === (await read()).org_id) return false;
      const files = strictFiles(env);
      const moved = await store.projects.move(id, { orgId: org.id });
      unlinked.push(...(await unlinkLostConnections(store, moved, files)));
      return true;
    },
    path: async (raw) => {
      const { abs } = checkoutOf(raw, env);
      if (abs === (await read()).path) return false;
      await refusePathTaken(store, abs, id);
      await store.projects.move(id, { path: abs });
      return true;
    },
    integrations: async (change) => {
      if (!Object.keys(change.set).length && !change.unset.length) return false;
      const project = await read();
      const current = await store.projects.integrations(id);
      const next = coded(422, "integration-invalid", () => nextIntegrations(current, change, { project, files: strictFiles(env) }));
      await store.projects.setIntegrations(id, next);
      return true;
    },
  };
}

// Applies a project PATCH in the order name, key, org, path, integrations; the first refusal stops the rest.
export async function patchProject(id, body, env) {
  const patch = projectPatchOf(body);
  return await lockedWrite(env, async (store) => {
    if (!(await store.projects.byId(id))) throw notFound("project", id);
    const unlinked = [];
    const applied = await applySteps({
      order: PROJECT_STEPS,
      patch,
      handlers: projectStepHandlers({ store, env, id, unlinked }),
      residuals: PROJECT_RESIDUALS,
      current: async () => ({ project: await rowOfId(store, id, env) }),
    });
    return { project: await rowOfId(store, id, env), applied, unlinked };
  });
}

// Removes a project: refused while a job runs on it, and with rows unless `?purge=1` deletes them and its run directory.
export async function deleteProject(id, purge, env) {
  return await lockedWrite(env, async (store) => {
    const project = await store.projects.byId(id);
    if (!project) throw notFound("project", id);
    const runningId = (await runningJobs(store)).get(id);
    if (runningId) throw new ApiRefusal(409, `${jobRef(runningId)} is running on this project — cancel it first`, { code: "job-running", details: { ref: jobRef(runningId) } });
    const removed = { id: project.id, name: project.name };
    if (purge) return { removed, purged: await purgeOrRefuse(env, store, project) };
    const footprint = await store.projects.footprint(id);
    if (footprint.length) throw ownsRows(project, footprint);
    await store.projects.remove(id).catch(async (err) => {
      if (err instanceof UserError) throw ownsRows(project, await store.projects.footprint(id));
      throw err;
    });
    return { removed, purged: [] };
  });
}

// The refusal of a plain remove of a project that still owns rows, listing them.
function ownsRows(project, footprint) {
  return new ApiRefusal(409, `project \`${project.name}\` still owns rows; remove it with purge to delete them`, { code: "owns-rows", details: { footprint } });
}

// Purges a project, the only refusal left after the checks being a job that started running or closing.
async function purgeOrRefuse(env, store, project) {
  try {
    return (await purgeProjectRows(env, store, project)).removed;
  } catch (err) {
    if (err instanceof UserError) throw new ApiRefusal(409, err.message, { code: "job-running", details: { ref: null } });
    throw err;
  }
}

// The `org list` row of one org, read again.
async function orgRowOf(store, id, env) {
  return (await listOrgs(store, loadConfig(env, QUIET))).find((org) => org.id === id) ?? null;
}

// Creates an org, the way `nightqueue org add` does, each refusal with its own code.
export async function createOrg(body, env) {
  refuseUnknownFields(body, ["name", "key"]);
  const name = optionalString(body, "name") ?? "";
  const rawKey = optionalString(body, "key") || undefined;
  return await lockedWrite(env, async (store) => {
    validOrgName(name);
    await refuseOrgNameTaken(store, name, null);
    const key = rawKey === undefined ? null : validKey(rawKey);
    let created;
    try {
      created = await addOrg(store, name, key);
    } catch (err) {
      if (err instanceof UserError) throw new ApiRefusal(409, err.message, { code: key ? "key-taken" : "refused" });
      throw err;
    }
    return { org: await orgRowOf(store, created.id, env) };
  });
}

// The fields of an org PATCH; `isDefault` only accepts true.
function orgPatchOf(body) {
  refuseUnknownFields(body, ORG_STEPS);
  if (body?.isDefault !== undefined && body.isDefault !== true) throw new UserError("`isDefault` only accepts true; set another org as default instead");
  return { name: optionalString(body, "name"), key: optionalString(body, "key"), isDefault: body?.isDefault };
}

// The handlers of the org PATCH steps; each re-reads the org and answers whether it wrote.
function orgStepHandlers({ store, env, id }) {
  const read = async () => await store.orgs.byId(id);
  return {
    name: async (name) => {
      const org = await read();
      if (name === org.name) return false;
      validOrgName(name);
      await refuseOrgNameTaken(store, name, id);
      await renameOrg(store, org.name, name);
      return true;
    },
    key: async (raw) => {
      const key = validKey(raw);
      const org = await read();
      if (key === org.key) return false;
      await setOrgKey(store, org.name, key);
      return true;
    },
    isDefault: async () => {
      const { config, changed } = await setDefaultOrg(store, loadConfig(env, QUIET), (await read()).name);
      saveConfig(config, env);
      return changed;
    },
  };
}

// Applies an org PATCH in the order name, key, isDefault; the first refusal stops the rest.
export async function patchOrg(id, body, env) {
  const patch = orgPatchOf(body);
  return await lockedWrite(env, async (store) => {
    if (!(await store.orgs.byId(id))) throw notFound("org", id);
    const applied = await applySteps({
      order: ORG_STEPS,
      patch,
      handlers: orgStepHandlers({ store, env, id }),
      residuals: ORG_RESIDUALS,
      current: async () => ({ org: await orgRowOf(store, id, env) }),
    });
    return { org: await orgRowOf(store, id, env), applied };
  });
}

// Removes an org that is not the default one and owns no project, dropping its bindings from config.json.
export async function deleteOrg(id, env) {
  return await lockedWrite(env, async (store) => {
    const org = await store.orgs.byId(id);
    if (!org) throw notFound("org", id);
    const config = loadConfig(env, QUIET);
    if ((await defaultOrg(store, config)).id === id) throw new ApiRefusal(409, `cannot remove org \`${org.name}\`: it is the default org`, { code: "is-default" });
    const projects = (await store.projects.ofOrg(id)).map((project) => ({ id: project.id, name: project.name }));
    if (projects.length) throw new ApiRefusal(409, `cannot remove org \`${org.name}\`: it owns ${projects.length} project(s)`, { code: "owns-projects", details: { projects } });
    try {
      await removeOrg(store, config, org.name);
    } catch (err) {
      if (err instanceof UserError) throw new ApiRefusal(409, err.message, { code: "owns-rows" });
      throw err;
    }
    saveConfig(config, env);
    return { removed: { id: org.id, name: org.name } };
  });
}

// A free key for a project or org name, read from the registry; a home with no database has every key free.
export async function suggestKeyAnswer(params, env) {
  const kind = params.get("kind");
  const name = (params.get("name") ?? "").trim();
  if (!KEY_KINDS.has(kind)) throw new UserError("`kind` expects project or org");
  if (!name) throw new UserError("`name` expects a non-empty name");
  if (!hasDb(env)) return { key: suggestKey(name, [], { kind }) };
  return { key: await withReadOnlyStore(env, async (store) => await (kind === "org" ? store.orgs : store.projects).suggestKey(name)) };
}

// Runs a read with the read-only store, or with none on a home without a database.
async function readWith(env, read) {
  return hasDb(env) ? await withReadOnlyStore(env, read) : await read(null);
}

// The folders of one directory inside the home, `?path=` defaulting to the home.
async function dirsAnswer(params, env) {
  return await readWith(env, async (store) => listDirs({ path: params.get("path"), env, projects: store ? await store.projects.list() : [] }));
}

// What registering one folder would do, named by `?path=`.
async function repoAnswer(params, env) {
  const path = params.get("path");
  if (!path) throw new UserError("`path` expects the folder to read");
  return await readWith(env, async (store) => await repoFacts({ path, env, store }));
}

// A path segment decoded; a malformed escape is refused.
function segmentOf(raw) {
  try {
    return decodeURIComponent(raw);
  } catch {
    throw new UserError(`unreadable path segment \`${raw}\``);
  }
}

// The handler of one `/api/projects[/<id>]` request, or null.
function projectHandler(req, { path, params, env, readBody }) {
  if (path === "/api/projects" && req.method === "GET") return async () => ({ status: 200, body: await projectsAnswer(env) });
  if (path === "/api/projects" && req.method === "POST") return async () => ({ status: 201, body: await createProject(await readBody(req), env) });
  const one = PROJECT_PATH.exec(path);
  if (!one) return null;
  const id = segmentOf(one[1]);
  if (req.method === "PATCH") return async () => ({ status: 200, body: await patchProject(id, await readBody(req), env) });
  if (req.method === "DELETE") return async () => ({ status: 200, body: await deleteProject(id, params.get("purge") === "1", env) });
  return null;
}

// The handler of one `/api/orgs[/<id>]` request, or null.
function orgHandler(req, { path, env, readBody }) {
  if (path === "/api/orgs" && req.method === "GET") return async () => ({ status: 200, body: await orgsAnswer(env) });
  if (path === "/api/orgs" && req.method === "POST") return async () => ({ status: 201, body: await createOrg(await readBody(req), env) });
  const one = ORG_PATH.exec(path);
  if (!one) return null;
  const id = segmentOf(one[1]);
  if (req.method === "PATCH") return async () => ({ status: 200, body: await patchOrg(id, await readBody(req), env) });
  if (req.method === "DELETE") return async () => ({ status: 200, body: await deleteOrg(id, env) });
  return null;
}

// The handler of one read-only helper route (folders, repository facts, key suggestion), or null.
function helperHandler(req, { path, params, env }) {
  if (req.method !== "GET") return null;
  if (path === "/api/fs/dirs") return async () => ({ status: 200, body: await dirsAnswer(params, env) });
  if (path === "/api/fs/repo") return async () => ({ status: 200, body: await repoAnswer(params, env) });
  if (path === "/api/keys/suggest") return async () => ({ status: 200, body: await suggestKeyAnswer(params, env) });
  return null;
}

// Serves one Settings › Projects & orgs request as `{ status, body }`, or null when the request is not one of its routes.
export async function serveProjects(req, { path, env, readBody }) {
  const params = new URL(req.url ?? "/", "http://x").searchParams;
  const context = { path, params, env, readBody };
  const handler = projectHandler(req, context) ?? orgHandler(req, context) ?? helperHandler(req, context);
  return handler ? await handler() : null;
}
