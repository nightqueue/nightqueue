import { connectionRecord, orgUsesConnection, resolveForClose } from "./connections.mjs";
import { connectionPlace, quietFiles } from "./coverage.mjs";
import { requestJson } from "./http.mjs";
import { originLabel } from "./origin.mjs";
import { actsOnOrigin, byRegistryOrder, providerOf, providers } from "./registry.mjs";
import { getSetting } from "./settings.mjs";

const HTTP_TIMEOUT_MS = 15000;
const BUDGET_RESERVE_MS = 3000;
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
  return (url, options = {}) =>
    requestJson(fetchImpl, url, { timeoutMs: Math.max(1, Math.min(HTTP_TIMEOUT_MS, ctx.remainingMs() - BUDGET_RESERVE_MS)), ...options, signal: ctx.signal });
}

// What a provider is told about the closed job, how it closed (its pull request merged, or resolved without change with the run's conclusion) and the origins it came from.
function closeFacts(ctx, origins) {
  return {
    job: { id: ctx.jobId, ref: ctx.jobRef, slug: ctx.slug, title: ctx.title, operatorTitle: ctx.operatorTitle, project: ctx.project, notice_md: ctx.noticeMd },
    result: {
      prUrl: ctx.prUrl,
      prNumber: ctx.prNumber,
      mergeSha: ctx.mergeSha,
      mergedAt: ctx.mergedAt,
      resolution: ctx.resolution ?? "merged",
      conclusion: ctx.conclusion ?? null,
      resolvedAt: ctx.resolvedAt ?? null,
    },
    origins,
  };
}

// Looks one origin up through its own provider: its label, url and title, or the stored ref as plain text with the reason.
async function describeOrigin(origin, { ctx, deps, files }) {
  const plain = { kind: origin.kind, ref: origin.ref, label: origin.ref, url: null, title: null };
  const describe = providerOf(origin.kind)?.origin?.describe;
  if (typeof describe !== "function") return { described: plain };
  const lost = (reason) => ({ described: plain, warning: `${originLabel(origin)}: link not resolved (${reason})` });
  if (ctx.signal.aborted || ctx.remainingMs() <= BUDGET_RESERVE_MS) return lost("not attempted, the post-close budget ran out");
  try {
    const { slot, connections } = resolveForClose({ kind: origin.kind, orgId: ctx.orgId, ...files });
    const found = await describe(origin.ref, { slot, connections, http: boundHttp(ctx, deps) });
    if (typeof found?.label !== "string" || !found.label) return lost(found?.detail ?? "no answer");
    return { described: { ...plain, label: found.label, url: found.url ?? null, title: found.title ?? null } };
  } catch {
    return lost("the lookup failed");
  }
}

// Describes every origin of the job in registry order, answering { described, warnings }.
async function describeOrigins({ ctx, deps, files }) {
  const results = [];
  for (const origin of byRegistryOrder(ctx.origins ?? [])) results.push(await describeOrigin(origin, { ctx, deps, files }));
  return { described: results.map((result) => result.described), warnings: results.flatMap((result) => result.warning ?? []) };
}

// A provider's answer as a step result; anything outside the contract is a warning naming the provider only.
function providerAnswer(kind, raw) {
  if (!raw || typeof raw !== "object" || !ANSWER_STATUSES.has(raw.status)) return answer("warning", `${kind} answered an invalid result`);
  const progress = isPlainObject(raw.progress) ? { progress: raw.progress } : {};
  return answer(raw.status, String(raw.note ?? raw.status), { notice: raw.notice === true, notified: raw.status === "done" || raw.notified === true, ...progress });
}

// Whether a value is a plain object, not null nor an array.
function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

// A copy of a stored per-origin map of the checklist, empty when it is missing or malformed.
function storedMap(value) {
  return isPlainObject(value) ? { ...value } : {};
}

// Runs a provider action, turning a throw into a warning that never carries the error's message.
async function callProvider(kind, action, run) {
  try {
    return providerAnswer(kind, await run());
  } catch {
    return answer("warning", `the ${kind} ${action} failed`);
  }
}

// Runs one origin's close action from the progress an earlier close left, answering a result without the `notified` mark.
async function closeOneOrigin(origin, { ctx, deps, files, progress, described }) {
  const provider = providerOf(origin.kind);
  if (typeof provider?.onClosed !== "function") return answer("skipped", `${origin.kind} has no close action`);
  if (!actsOnOrigin(origin.kind, ctx.integrations)) return answer("skipped", `project has no ${origin.kind} integration`);
  const { slot, connections } = resolveForClose({ kind: origin.kind, orgId: ctx.orgId, ...files });
  if (!slot && !connections.length) return answer("skipped", `no ${origin.kind} connection ${connectionPlace(origin.kind)}`, { notice: true });
  if (ctx.signal.aborted) return answer("warning", `interrupted before the ${origin.kind} close action`);
  const settings = ctx.integrations?.[origin.kind] ?? null;
  return await callProvider(origin.kind, "close action", () =>
    provider.onClosed({ ref: origin.ref, ...closeFacts(ctx, described), settings, slot, connections, http: boundHttp(ctx, deps), progress }),
  );
}

// Records one origin's outcome: notified once told, else the progress its provider reported for the next close to resume from.
function recordOriginOutcome(key, result, { notified, progress }) {
  if (result.notified === true) {
    notified[key] = true;
    delete progress[key];
  } else if (result.progress) {
    progress[key] = result.progress;
  }
}

// Tells one origin its pull request merged, or it was resolved without change, unless it already was, marking it notified; a throw becomes a warning.
async function notifyOrigin(origin, { ctx, deps, files, notified, progress, described }) {
  const key = originLabel(origin);
  const named = (result, extra = {}) => ({ status: result.status, note: `${key}: ${result.note}`, notice: result.notice === true, ...extra });
  if (notified[key] === true) return named(answer("done", "already notified"), { earlier: true });
  if (ctx.remainingMs() <= BUDGET_RESERVE_MS) return named(answer("warning", "not attempted, the post-close budget ran out"));
  try {
    const result = await closeOneOrigin(origin, { ctx, deps, files, progress: storedMap(progress[key]), described });
    recordOriginOutcome(key, result, { notified, progress });
    return named(result);
  } catch {
    return named(answer("warning", "the close action failed"));
  }
}

// The notice line of an origin whose link could not be looked up.
function linkWarning(note) {
  return answer("warning", note, { notice: true });
}

// Folds the per-origin results into one: the worst status wins, every note is kept, one line per origin.
function foldOriginResults(results, { notified, progress }) {
  const status = results.reduce((worst, result) => (SEVERITY[result.status] > SEVERITY[worst] ? result.status : worst), "skipped");
  const note = results.map((result) => result.note).join("; ");
  return answer(status, note, { notice: results.some((result) => result.notice), data: { originsNotified: notified, originsProgress: progress }, lines: results });
}

// Tells every service the job came from that its pull request merged or it was resolved without change, once per origin and in registry order: the origin step of a close.
export async function originStep({ ctx, deps }) {
  const origins = byRegistryOrder(ctx.origins ?? []);
  if (!origins.length) return answer("skipped", "no origin");
  const marks = { notified: storedMap(ctx.data.originsNotified), progress: storedMap(ctx.data.originsProgress) };
  const files = readFiles(ctx, deps);
  const pending = origins.some((origin) => marks.notified[originLabel(origin)] !== true);
  const { described, warnings } = pending ? await describeOrigins({ ctx, deps, files }) : { described: [], warnings: [] };
  const results = [];
  for (const origin of origins) results.push(await notifyOrigin(origin, { ctx, deps, files, described, ...marks }));
  return foldOriginResults([...results, ...warnings.map(linkWarning)], marks);
}

// The providers a project logs its closes to: a `log` action, a `log.connection` set, and `closed` among its `log.events`.
function logTargets(integrations) {
  return providers().filter((provider) => {
    if (typeof provider.log !== "function" || !integrations?.[provider.kind]) return false;
    const events = getSetting(integrations, provider.kind, "log.events") ?? [CLOSE_EVENT];
    return Boolean(getSetting(integrations, provider.kind, "log.connection")) && Array.isArray(events) && events.includes(CLOSE_EVENT);
  });
}

// Clears the marks and the progress of the origins, so the origin step posts to every origin again.
export function forgetOrigin(data) {
  delete data.originsNotified;
  delete data.originsProgress;
}

// Clears the logged mark of every provider the project logs to, so the log step posts again.
export function forgetLogged(data, integrations) {
  if (!data.logged || typeof data.logged !== "object" || Array.isArray(data.logged)) return;
  for (const provider of logTargets(integrations)) delete data.logged[provider.kind];
}

// Logs the close to one provider unless it already did, answering a result whose note names the provider.
async function logTo(provider, { ctx, deps, files, logged, described }) {
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
  const result = await callProvider(kind, "log", () => provider.log({ event: CLOSE_EVENT, ...closeFacts(ctx, described), settings, connection, http: boundHttp(ctx, deps) }));
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
  const pending = targets.some((provider) => logged[provider.kind] !== true);
  const { described } = pending ? await describeOrigins({ ctx, deps, files }) : { described: [] };
  const results = [];
  for (const provider of targets) results.push(await logTo(provider, { ctx, deps, files, logged, described }));
  return foldLogResults(results, logged);
}
