import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { connectionRecord } from "./connections.mjs";
import { coverageLabel, originCoverage, quietFiles } from "./coverage.mjs";
import { requestJson } from "./http.mjs";
import { providerOf } from "./registry.mjs";

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
  if (!provider || !integrations?.[provider.kind]) return false;
  if (provider.capabilities?.read !== true || typeof provider.origin?.enrich !== "function") return false;
  return !existsSync(file);
}

// Runs a provider's enrichment inside the total budget, answering markdown text or the reason it was skipped.
async function fetchMarkdown({ provider, ref, connection, fetchImpl }) {
  const budget = AbortSignal.timeout(ENRICH_BUDGET_MS);
  const http = (url, options = {}) => requestJson(fetchImpl, url, { ...options, signal: budget });
  const expired = new Promise((resolve) => {
    budget.addEventListener("abort", () => resolve({ detail: `timeout (${ENRICH_BUDGET_MS / 1000}s)` }), { once: true });
  });
  try {
    const answer = await Promise.race([provider.origin.enrich(ref, { connection, http }), expired]);
    if (typeof answer === "string" && answer.trim()) return { markdown: answer };
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

// Fetches what a read-capable provider knows about the job's origin into `<dir>/<kind>.md`; nothing here ever fails the job.
async function enrichInto({ origin, coverage, dir, secrets, fetchImpl, log }) {
  const provider = providerOf(origin.kind);
  const connection = connectionRecord({ secrets, name: coverage.connection, kind: origin.kind });
  if (!connection) return log(`origin enrichment skipped: ${coverage.detail ?? `no ${origin.kind} connection in the org`}`);
  const fetched = await fetchMarkdown({ provider, ref: origin.ref, connection, fetchImpl });
  if (!fetched.markdown) return log(`origin enrichment skipped: ${fetched.detail}`);
  try {
    writeOnce(dir, join(dir, `${origin.kind}.md`), fetched.markdown);
  } catch {
    log("origin enrichment skipped: the file could not be written");
  }
}

// Logs the origin line of a claimed job and, when its project enabled a read-capable provider, enriches the run's origin directory.
export async function enrichJobOrigin({ origin, orgId, integrations, dir, env, fetchImpl = globalThis.fetch, log }) {
  if (!origin) return;
  const { config, secrets } = quietFiles(env);
  const coverage = originCoverage({ origin, orgId, integrations, config, secrets });
  log(`origin: ${coverageLabel(coverage)}`);
  const provider = providerOf(origin.kind);
  if (!dir || !wantsEnrichment({ provider, integrations, file: join(dir, `${origin.kind}.md`) })) return;
  await enrichInto({ origin, coverage, dir, secrets, fetchImpl, log });
}
