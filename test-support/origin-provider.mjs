import { github } from "../src/integrations/github.mjs";
import { loadConfig, loadSecrets, saveConfig, saveSecrets } from "../src/config/store.mjs";
import { openDb } from "../src/memory/db.mjs";

export const TRACKER_SECRET = "tracker-secret-token-123";
export const TRACKER_URL = "https://tracker.example/issues/4507";

const ISSUE_LINK = /https:\/\/tracker\.example\/issues\/(\d+)/;

// Reads a tracker reference: an issue link anywhere in the text, or a bare issue number given alone.
function parseTracker(text) {
  const linked = ISSUE_LINK.exec(text)?.[1];
  if (linked) return linked;
  const bare = text.trim();
  return /^\d+$/.test(bare) ? bare : null;
}

// Fetches one issue through the http the runtime hands in, answering markdown or the reason it could not.
async function enrichTracker(ref, { connection, http }) {
  const answer = await http(`https://tracker.example/api/issues/${ref}`, { headers: { Authorization: `Bearer ${connection.token}` } });
  return answer.ok ? `# Issue ${ref}\n\n${answer.body.title}\n` : { detail: answer.detail };
}

// A read-capable test provider: one org connection, an issue link as origin, an enrichment over the injected fetch.
export function trackerProvider(overrides = {}) {
  return {
    kind: "tracker",
    connection: { cardinality: "one", secretFields: ["token"], extraFields: [], secretLabel: "token", test: async () => ({ ok: true, detail: "ok" }), summary: () => "ok" },
    capabilities: { post: false, read: true, resolve: false },
    origin: { parse: parseTracker, enrich: overrides.enrich ?? enrichTracker },
    ...(overrides.covers ? { covers: overrides.covers } : {}),
  };
}

// A second origin provider that recognizes every tracker link too, to prove registry order decides.
export function shadowProvider() {
  return {
    kind: "shadow",
    connection: { cardinality: "one", secretFields: ["token"], extraFields: [], secretLabel: "token", test: async () => ({ ok: true }) },
    capabilities: { post: false, read: false, resolve: false },
    origin: { parse: (text) => ISSUE_LINK.exec(text)?.[1] ?? null },
  };
}

// The registry list the origin tests run under: github first as in the build, then the fixtures.
export function originProviders(...extra) {
  return [github, trackerProvider(), ...extra];
}

// The org id of a registered project.
export function orgOfProject(env, projectId) {
  return openDb(env).prepare("SELECT org_id FROM projects WHERE id = ?").get(projectId).org_id;
}

// Stores the tracker connection `trk` and binds it to the project's org slot.
export function bindTrackerConnection(env, projectId, { name = "trk" } = {}) {
  const orgId = orgOfProject(env, projectId);
  const config = loadConfig(env, { warn: () => {} });
  config.orgConnections[orgId] = { ...(config.orgConnections[orgId] ?? {}), tracker: name };
  saveConfig(config, env);
  const secrets = loadSecrets(env, { warn: () => {} });
  secrets.connections[name] = { type: "tracker", token: TRACKER_SECRET };
  saveSecrets(secrets, env);
}

// Writes a project's integrations column directly, the writer of a later stage standing in.
export function setIntegrations(env, projectId, value) {
  openDb(env).prepare("UPDATE projects SET integrations = ? WHERE id = ?").run(value === null ? null : JSON.stringify(value), projectId);
}

// A fake fetch that records every call and answers the tracker issue, or the status it was told to.
export function fakeTrackerFetch({ status = 200, title = "worker crashes on boot", throws = false } = {}) {
  const calls = [];
  const impl = async (url, options) => {
    calls.push({ url, options });
    if (throws) throw new Error(`connect ECONNREFUSED ${url} ${TRACKER_SECRET}`);
    return { status, headers: new Map(), json: async () => ({ title }) };
  };
  return { impl, calls };
}
