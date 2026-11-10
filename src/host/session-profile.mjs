import { CLOSE_WORKER_ENV, JOB_CLAIM_ENV, JOB_CLAUDE_DIR_ENV, JOB_HOME_ENV } from "../config/job-home.mjs";

export const JOB_SCOPED_ENV_KEYS = Object.freeze(["NIGHTQUEUE_JOB_ID", JOB_HOME_ENV, JOB_CLAUDE_DIR_ENV, JOB_CLAIM_ENV, CLOSE_WORKER_ENV]);

// A copy of an environment without the variables that scope a process to one job, so no session that is not a job inherits them.
export function withoutJobScope(env) {
  const copy = { ...(env ?? {}) };
  for (const key of JOB_SCOPED_ENV_KEYS) delete copy[key];
  return copy;
}

const present = (value) => value !== null && value !== undefined;
const flag = (name, value) => (present(value) ? [name, String(value)] : []);

const SEGMENTS = Object.freeze({
  print: (v) => ["-p", String(v.prompt ?? "")],
  agent: (v) => (present(v.agent) ? ["--agent", v.agent] : flag("--append-system-prompt", v.appendSystemPrompt)),
  model: (v) => flag("--model", v.model),
  tools: (v) => flag("--tools", v.tools),
  permissionMode: (v) => flag("--permission-mode", v.permissionMode),
  stream: () => ["--output-format", "stream-json", "--verbose"],
  pluginDir: (v) => flag("--plugin-dir", v.pluginDir),
  mcpConfig: (v) => flag("--mcp-config", v.mcpConfig),
  strictMcp: (v) => (v.strictMcp === true ? ["--strict-mcp-config"] : []),
  settingSources: (v) => flag("--setting-sources", v.settingSources),
  settings: (v) => (present(v.settings) ? ["--settings", JSON.stringify(v.settings)] : []),
  resume: (v) => flag("--resume", v.resume),
  agents: (v) => flag("--agents", v.agents),
  sessionId: (v) => flag("--session-id", v.sessionId),
  operand: (v) => (present(v.operand) ? [v.operand] : []),
});

const profile = (entry) => Object.freeze({ ...entry, order: Object.freeze([...entry.order]) });

export const SESSION_PROFILES = Object.freeze({
  job: profile({
    order: ["print", "model", "permissionMode", "stream", "pluginDir", "mcpConfig", "strictMcp", "settingSources", "settings", "resume"],
    permissionMode: "bypassPermissions",
    strictMcp: true,
    settingSources: "project",
  }),
  merger: profile({
    order: ["print", "agent", "model", "tools", "permissionMode", "stream", "pluginDir", "strictMcp", "settingSources", "settings"],
    agent: "nightqueue:merger",
    tools: "Read,Edit",
    permissionMode: "acceptEdits",
    strictMcp: true,
    settingSources: "project",
  }),
  operator: profile({
    order: ["agent", "pluginDir", "mcpConfig", "permissionMode", "settingSources", "settings", "resume", "operand"],
    permissionMode: "default",
    strictMcp: false,
    settingSources: "user,project,local",
  }),
  chat: profile({
    order: ["agents", "agent", "pluginDir", "mcpConfig", "permissionMode", "settingSources", "settings", "sessionId", "resume", "operand"],
    permissionMode: "default",
    strictMcp: false,
    settingSources: "user,project,local",
  }),
});

// Merges a kind's defaults with the values the caller gives, a value left undefined keeping the default.
function profileValues(defaults, given) {
  const values = { ...defaults };
  for (const [key, value] of Object.entries(given)) {
    if (value !== undefined) values[key] = value;
  }
  return values;
}

// Builds the claude argv of one session kind (job, merger, operator or chat) from its declared profile and the caller's values.
export function profileArgs({ kind, ...given } = {}) {
  const defaults = Object.hasOwn(SESSION_PROFILES, kind) ? SESSION_PROFILES[kind] : null;
  if (defaults === null) {
    throw new Error(`unknown session profile kind ${JSON.stringify(kind)}; expected one of ${Object.keys(SESSION_PROFILES).join(", ")}`);
  }
  const values = profileValues(defaults, given);
  return defaults.order.flatMap((segment) => SEGMENTS[segment](values));
}
