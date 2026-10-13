import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { connectionRecord } from "./connections.mjs";
import { connectionPlace, coverageLabel, originCoverage, quietFiles } from "./coverage.mjs";
import { requestJson } from "./http.mjs";
import { originInLink, originLabel, originsLabel, validOrigins } from "./origin.mjs";
import { actsOnOrigin, providerOf } from "./registry.mjs";

export const ORIGIN_MAX_BYTES = 16384;
export const ENRICH_BUDGET_MS = 20000;
const TRUNCATED_MARK = "\n\n[truncated]";

// Cuts a markdown text to the byte cap on a code point boundary, marking the cut.
export function capMarkdown(text, maxBytes = ORIGIN_MAX_BYTES) {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  const room = maxBytes - Buffer.byteLength(TRUNCATED_MARK, "utf8");
  let used = 0;
  let cut = "";
  for (const char of text) {
    const size = Buffer.byteLength(char, "utf8");
    if (used + size > room) break;
    used += size;
    cut += char;
  }
  return `${cut}${TRUNCATED_MARK}`;
}

// Tells whether the project enabled a provider that can read the origin and this run has not fetched it yet.
function wantsEnrichment({ provider, integrations, file }) {
  if (!provider || !actsOnOrigin(provider.kind, integrations)) return false;
  if (provider.capabilities?.read !== true || typeof provider.origin?.enrich !== "function") return false;
  return !existsSync(file);
}

// Runs a provider's enrichment inside the total budget, answering its markdown and linked origins or the reason it was skipped.
async function fetchMarkdown({ provider, origin, connection, fetchImpl }) {
  const budget = AbortSignal.timeout(ENRICH_BUDGET_MS);
  const http = (url, options = {}) => requestJson(fetchImpl, url, { ...options, signal: budget });
  const linkOrigin = (url) => originInLink(url, { exclude: origin.kind });
  const expired = new Promise((resolve) => {
    budget.addEventListener("abort", () => resolve({ detail: `timeout (${ENRICH_BUDGET_MS / 1000}s)` }), { once: true });
  });
  try {
    const answer = await Promise.race([provider.origin.enrich(origin.ref, { connection, http, linkOrigin }), expired]);
    if (typeof answer?.markdown === "string" && answer.markdown.trim()) return { markdown: answer.markdown, linked: validOrigins(answer.linked) };
    return { detail: typeof answer?.detail === "string" && answer.detail ? answer.detail : "the service answered nothing" };
  } catch {
    return { detail: "the enrichment failed" };
  }
}

// Writes the enrichment file once and 0600: a file another process wrote first is left as it is.
function writeOnce(dir, file, markdown) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    writeFileSync(file, capMarkdown(markdown), { mode: 0o600, flag: "wx" });
  } catch (err) {
    if (err?.code !== "EEXIST") throw err;
  }
}

// The enrichment file of one origin: `<dir>/<kind>-<ref>.md`, the ref reduced to safe file name characters.
export function originFileOf(dir, origin) {
  return join(dir, `${origin.kind}-${origin.ref.replace(/[^A-Za-z0-9._-]/g, "_")}.md`);
}

// Fetches what a read-capable provider knows about one origin, answering it or null once the reason is logged.
async function fetchOrigin({ origin, coverage, run }) {
  const connection = connectionRecord({ secrets: run.secrets, name: coverage.connection, kind: origin.kind });
  if (!connection) {
    run.log(`origin enrichment skipped: ${coverage.detail ?? `no ${origin.kind} connection ${connectionPlace(origin.kind)}`}`);
    return null;
  }
  const fetched = await fetchMarkdown({ provider: providerOf(origin.kind), origin, connection, fetchImpl: run.fetchImpl });
  if (fetched.markdown) return fetched;
  run.log(`origin enrichment skipped: ${fetched.detail}`);
  return null;
}

// Writes the origin's file, logging instead of throwing when it cannot be written.
function writeOriginFile({ origin, markdown, run }) {
  try {
    writeOnce(run.dir, originFileOf(run.dir, origin), markdown);
  } catch {
    run.log("origin enrichment skipped: the file could not be written");
  }
}

// Records the origins an enrichment linked that the job does not carry yet, answering the new ones or null when the write-back was refused.
async function recordLinked({ origin, linked, run }) {
  const known = new Set(run.origins.map(originLabel));
  const added = linked.filter((candidate) => !known.has(originLabel(candidate)));
  if (!added.length) return [];
  let recorded = false;
  try {
    recorded = (await run.onLinked?.([...run.origins, ...added])) === true;
  } catch {
    recorded = false;
  }
  if (!recorded) {
    run.log("linked origins not recorded: the claim moved on");
    return null;
  }
  run.log(`origin linked by ${originLabel(origin)}: ${originsLabel(added)}`);
  return added;
}

// Logs one origin line and enriches it when wanted, answering the origins it linked and recorded.
async function enrichOne({ origin, links, run }) {
  const coverage = originCoverage({ origin, orgId: run.orgId, integrations: run.integrations, config: run.config, secrets: run.secrets });
  run.log(`origin: ${coverageLabel(coverage)}`);
  const provider = providerOf(origin.kind);
  if (!run.dir || !wantsEnrichment({ provider, integrations: run.integrations, file: originFileOf(run.dir, origin) })) return [];
  const fetched = await fetchOrigin({ origin, coverage, run });
  if (!fetched) return [];
  const added = links ? await recordLinked({ origin, linked: fetched.linked, run }) : [];
  if (added === null) return [];
  writeOriginFile({ origin, markdown: fetched.markdown, run });
  return added;
}

// Logs the origin lines of a claimed job and enriches the run's origin directory, one level of linked origins written back through onLinked.
export async function enrichJobOrigins({ origins, orgId, integrations, dir, env, fetchImpl = globalThis.fetch, log, onLinked }) {
  const list = validOrigins(origins);
  if (!list.length) return;
  const { config, secrets } = quietFiles(env);
  const run = { origins: list, orgId, integrations, config, secrets, dir, fetchImpl, log, onLinked };
  const pending = list.map((origin) => ({ origin, links: true }));
  while (pending.length) {
    const { origin, links } = pending.shift();
    const added = await enrichOne({ origin, links, run });
    run.origins = [...run.origins, ...added];
    pending.push(...added.map((linked) => ({ origin: linked, links: false })));
  }
}
