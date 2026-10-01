import { loadConfig, loadSecrets } from "../config/store.mjs";
import { publicFields, resolveForClose } from "./connections.mjs";
import { providerOf } from "./registry.mjs";

const NONE = "none";

// The coverage a provider without its own rule answers: the org's single slot, when there is one.
function slotCoverage(kind, { slot }) {
  if (slot) return { connection: slot.name, detail: null };
  return { connection: null, detail: `no ${kind} connection in the org` };
}

// The org's connections of a kind as names and public fields only.
function publicConnections({ provider, orgId, config, secrets }) {
  const resolved = resolveForClose({ kind: provider.kind, orgId, config, secrets });
  const visible = (record) => publicFields(record, provider.connection);
  return { slot: resolved.slot ? visible(resolved.slot) : null, connections: resolved.connections.map(visible) };
}

// Asks a provider which connection covers a reference, a provider rule that throws answering no connection.
function providerCoverage(provider, ref, known) {
  try {
    const answer = typeof provider.covers === "function" ? provider.covers(ref, known) : slotCoverage(provider.kind, known);
    return { connection: answer?.connection || null, detail: answer?.detail ?? null };
  } catch {
    return { connection: null, detail: "the coverage check failed" };
  }
}

// Which connection of the org covers a job's origin, by name, or `none` with the reason; reads no secret and calls no service.
export function originCoverage({ origin, orgId, integrations, config, secrets }) {
  const base = { kind: origin.kind, ref: origin.ref };
  const provider = providerOf(origin.kind);
  if (!provider) return { ...base, connection: NONE, detail: `this build has no ${origin.kind} provider` };
  if (!integrations?.[origin.kind]) return { ...base, connection: NONE, detail: `project has no ${origin.kind} integration` };
  const covered = providerCoverage(provider, origin.ref, publicConnections({ provider, orgId, config, secrets }));
  return { ...base, connection: covered.connection ?? NONE, detail: covered.detail };
}

// Reads config.json and secrets.json quietly; a file that cannot be read is an empty one.
export function quietFiles(env) {
  const quiet = { warn: () => {} };
  try {
    return { config: loadConfig(env, quiet), secrets: loadSecrets(env, quiet) };
  } catch {
    return { config: null, secrets: null };
  }
}

// The coverage of a job's origin read through a store for its project, or null when the job has no origin.
export async function jobOriginCoverage({ origin, projectId, store, env }) {
  if (!origin) return null;
  const [project, integrations] = await Promise.all([store.projects.byId(projectId), store.projects.integrations(projectId)]);
  return originCoverage({ origin, orgId: project?.org_id ?? null, integrations, ...quietFiles(env) });
}

// The coverage as the `origin` field of an answer: `detail` only when there is one.
export function coverageField(coverage) {
  const { detail, ...rest } = coverage;
  return detail ? { ...rest, detail } : rest;
}

// The coverage as one line: `<kind> <ref> (connection: <name|none>)`.
export function coverageLabel(coverage) {
  return `${coverage.kind} ${coverage.ref} (connection: ${coverage.connection})`;
}
