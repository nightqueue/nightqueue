import { connectionRecord, orgUsesConnection, resolveForClose } from "./connections.mjs";
import { quietFiles } from "./coverage.mjs";
import { requestJson } from "./http.mjs";
import { providerOf, providers } from "./registry.mjs";
import { getSetting } from "./settings.mjs";

const HTTP_TIMEOUT_MS = 15000;
const ANSWER_STATUSES = new Set(["done", "skipped", "warning"]);
const SEVERITY = { skipped: 0, done: 1, warning: 2 };
const CLOSE_EVENT = "closed";

// A post-close step result.
function answer(status, note, extra = {}) {
  return { status, note, ...extra };
}

// Reads config.json and secrets.json through the close's deps, or quietly from the home when the deps carry no reader.
function readFiles(ctx, deps) {
  const files = deps?.integrations;
  if (typeof files?.config !== "function" || typeof files?.secrets !== "function") return quietFiles(ctx.env);
  try {
    return { config: files.config(), secrets: files.secrets() };
  } catch {
    return { config: null, secrets: null };
  }
}

// The HTTP a provider calls through: the close's fetch, bounded by the post-close budget and its abort signal.
function boundHttp(ctx, deps) {
  const fetchImpl = typeof deps?.fetch === "function" ? deps.fetch : globalThis.fetch;
  return (url, options = {}) => requestJson(fetchImpl, url, { timeoutMs: Math.max(1, Math.min(HTTP_TIMEOUT_MS, ctx.remainingMs())), ...options, signal: ctx.signal });
}

// What a provider is told about the closed job and the merge that closed it.
function closeFacts(ctx) {
  return {
    job: { id: ctx.jobId, ref: ctx.jobRef, slug: ctx.slug, title: ctx.title, project: ctx.project, notice_md: ctx.noticeMd },
    result: { prUrl: ctx.prUrl, prNumber: ctx.prNumber, mergeSha: ctx.mergeSha, mergedAt: ctx.mergedAt },
  };
}

// A provider's answer as a step result; anything outside the contract is a warning naming the provider only.
function providerAnswer(kind, raw) {
  if (!raw || typeof raw !== "object" || !ANSWER_STATUSES.has(raw.status)) return answer("warning", `${kind} answered an invalid result`);
  return answer(raw.status, String(raw.note ?? raw.status), { notice: raw.notice === true, notified: raw.status === "done" || raw.notified === true });
}

// Runs a provider action, turning a throw into a warning that never carries the error's message.
async function callProvider(kind, action, run) {
  try {
    return providerAnswer(kind, await run());
  } catch {
    return answer("warning", `the ${kind} ${action} failed`);
  }
}

// Tells the service the job came from that its pull request merged, once: the origin step of a close.
export async function originStep({ ctx, deps }) {
  if (ctx.data.originNotified === true) return answer("done", "already notified");
  const origin = ctx.origin;
  if (!origin) return answer("skipped", "no origin");
  const provider = providerOf(origin.kind);
  if (typeof provider?.onClosed !== "function") return answer("skipped", `${origin.kind} has no close action`);
  if (!ctx.integrations?.[origin.kind]) return answer("skipped", `project has no ${origin.kind} integration`);
  const { slot, connections } = resolveForClose({ kind: origin.kind, orgId: ctx.orgId, ...readFiles(ctx, deps) });
  if (!slot && !connections.length) return answer("skipped", `no ${origin.kind} connection in the org`, { notice: true });
  if (ctx.signal.aborted) return answer("warning", `interrupted before the ${origin.kind} close action`);
  const settings = ctx.integrations[origin.kind];
  const result = await callProvider(origin.kind, "close action", () =>
    provider.onClosed({ ref: origin.ref, ...closeFacts(ctx), settings, slot, connections, http: boundHttp(ctx, deps) }),
  );
  const { notified, ...rest } = result;
  return notified ? { ...rest, data: { originNotified: true } } : rest;
}

// The providers a project logs its closes to: a `log` action, a `log.connection` set, and `closed` among its `log.events`.
function logTargets(integrations) {
  return providers().filter((provider) => {
    if (typeof provider.log !== "function" || !integrations?.[provider.kind]) return false;
    const events = getSetting(integrations, provider.kind, "log.events") ?? [CLOSE_EVENT];
    return Boolean(getSetting(integrations, provider.kind, "log.connection")) && Array.isArray(events) && events.includes(CLOSE_EVENT);
  });
}

// Clears the mark that the origin was notified, so the origin step posts again.
export function forgetOrigin(data) {
  delete data.originNotified;
}

// Clears the logged mark of every provider the project logs to, so the log step posts again.
export function forgetLogged(data, integrations) {
  if (!data.logged || typeof data.logged !== "object" || Array.isArray(data.logged)) return;
  for (const provider of logTargets(integrations)) delete data.logged[provider.kind];
}

// Logs the close to one provider unless it already did, answering a result whose note names the provider.
async function logTo(provider, { ctx, deps, files, logged }) {
  const kind = provider.kind;
  if (logged[kind] === true) return answer("done", `${kind}: already logged`);
  const name = getSetting(ctx.integrations, kind, "log.connection");
  const connection = connectionRecord({ secrets: files.secrets, name, kind });
  if (!connection) return answer("skipped", `${kind}: log connection ${name} not found`, { notice: true });
  if (!orgUsesConnection({ config: files.config, orgId: ctx.orgId, kind, name })) {
    return answer("skipped", `${kind}: log connection ${name} is not bound to the project's org`, { notice: true });
  }
  if (ctx.signal.aborted) return answer("warning", `${kind}: interrupted before the log`);
  const settings = ctx.integrations[kind];
  const result = await callProvider(kind, "log", () => provider.log({ event: CLOSE_EVENT, ...closeFacts(ctx), settings, connection, http: boundHttp(ctx, deps) }));
  if (result.status === "done") logged[kind] = true;
  return { ...result, note: result.note.startsWith(`${kind}:`) ? result.note : `${kind}: ${result.note}` };
}

// Folds the per-provider log results into one: the worst status wins, every note is kept.
function foldLogResults(results, logged) {
  const status = results.reduce((worst, result) => (SEVERITY[result.status] > SEVERITY[worst] ? result.status : worst), "skipped");
  const note = results.map((result) => result.note).join("; ");
  return answer(status, note, { notice: results.some((result) => result.notice), data: { logged } });
}

// Posts the close to every log destination the project configured, once per provider: the log step of a close.
export async function logStep({ ctx, deps }) {
  const targets = logTargets(ctx.integrations);
  if (!targets.length) return answer("skipped", "no log destination");
  const stored = ctx.data.logged;
  const logged = stored && typeof stored === "object" && !Array.isArray(stored) ? { ...stored } : {};
  const files = readFiles(ctx, deps);
  const results = [];
  for (const provider of targets) results.push(await logTo(provider, { ctx, deps, files, logged }));
  return foldLogResults(results, logged);
}
