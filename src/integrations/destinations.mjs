// The log destination of a project: the Discord connection its "job closed" notice goes to, set as two keys or none.
import { UserError } from "../config/errors.mjs";
import { orgUsesConnection } from "./connections.mjs";
import { applyIntegrationChange, getSetting } from "./settings.mjs";

export const DESTINATION_KIND = "discord";
export const CONNECTION_KEY = "discord.log.connection";
export const EVENTS_KEY = "discord.log.events";
const CLOSED_EVENT = "closed";

// A project or connection the request names that does not exist.
export class DestinationNotFound extends UserError {
  constructor(message) {
    super(message);
    this.name = "DestinationNotFound";
  }
}

// A connection the project's org is not allowed to use.
export class NotAllowedForOrg extends UserError {
  constructor({ orgId, connection, projectId }) {
    super(`connection \`${connection}\` is not allowed for the project's org; allow it for the org first`);
    this.name = "NotAllowedForOrg";
    this.orgId = orgId;
    this.connection = connection;
    this.projectId = projectId;
  }
}

// The connection name a project's notice goes to, or null.
export function destinationOf(integrations) {
  const name = getSetting(integrations, DESTINATION_KIND, "log.connection");
  return typeof name === "string" && name ? name : null;
}

// The two settings a link writes: the connection and the one event it carries.
export function linkChanges(name) {
  return [
    { key: CONNECTION_KEY, value: name },
    { key: EVENTS_KEY, value: CLOSED_EVENT },
  ];
}

// The integrations without a destination: both keys unset, empty parents pruned, null when nothing is left.
function withoutDestination(current) {
  return [CONNECTION_KEY, EVENTS_KEY].reduce((integrations, key) => applyIntegrationChange({ current: integrations, action: "unset", key }), current);
}

// Refuses a connection that is not a stored Discord connection.
function requireDiscordConnection(name, secrets) {
  const record = secrets?.connections?.[name];
  if (!record || record.type !== DESTINATION_KIND) throw new DestinationNotFound(`there is no Discord connection named \`${name}\``);
}

// The integrations with the project linked to the connection, validated the way `project_integrations` validates them.
function withDestination({ current, project, name, files }) {
  requireDiscordConnection(name, files.secrets);
  if (!orgUsesConnection({ config: files.config, orgId: project.org_id, kind: DESTINATION_KIND, name })) {
    throw new NotAllowedForOrg({ orgId: project.org_id, connection: name, projectId: project.id });
  }
  return linkChanges(name).reduce(
    (integrations, change) => applyIntegrationChange({ current: integrations, action: "set", ...change, orgId: project.org_id, ...files }),
    current,
  );
}

// The integrations after pointing the project at a connection, or after clearing its destination with a null name.
function nextIntegrations({ current, project, name, files }) {
  return name === null ? withoutDestination(current) : withDestination({ current, project, name, files });
}

// Points one project at a connection, or clears its destination with a null name, answering the stored destination.
export async function setDestination({ store, project, name, files }) {
  const current = await store.projects.integrations(project.id);
  const next = nextIntegrations({ current, project, name, files });
  await store.projects.setIntegrations(project.id, next);
  return destinationOf(next);
}

// Resolves every project id of a batch, refusing the whole batch on the first unknown one.
async function resolveProjects(store, projectIds) {
  const projects = [];
  for (const id of [...new Set(projectIds)]) {
    const project = await store.projects.byId(id);
    if (!project) throw new DestinationNotFound(`unknown project \`${id}\``);
    projects.push(project);
  }
  return projects;
}

// Links every project to the connection, all or none: everything is validated before the first write.
export async function linkProjects({ store, name, projectIds, files }) {
  const planned = [];
  for (const project of await resolveProjects(store, projectIds)) {
    const current = await store.projects.integrations(project.id);
    const next = withDestination({ current, project, name, files });
    planned.push({ project, next, unchanged: destinationOf(current) === name });
  }
  const linked = [];
  for (const entry of planned.filter((item) => !item.unchanged)) {
    await store.projects.setIntegrations(entry.project.id, entry.next);
    linked.push(entry.project.id);
  }
  return { linked, unchanged: planned.filter((item) => item.unchanged).map((item) => item.project.id) };
}

// The projects whose notice goes to the connection, only those of the given org ids when some are given.
export async function projectsUsing({ store, name, orgIds = null }) {
  const using = [];
  for (const project of await store.projects.list()) {
    if (orgIds && !orgIds.includes(project.org_id)) continue;
    if (destinationOf(await store.projects.integrations(project.id)) === name) using.push(project);
  }
  return using;
}

// Clears the destination of every project that uses the connection, answering the projects cleared.
export async function unlinkProjectsUsing({ store, name, orgIds = null }) {
  const using = await projectsUsing({ store, name, orgIds });
  for (const project of using) {
    await store.projects.setIntegrations(project.id, withoutDestination(await store.projects.integrations(project.id)));
  }
  return using;
}
