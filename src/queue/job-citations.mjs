import { JOB_SEARCH_LIMIT } from "../memory/job-search.mjs";
import { jobRef } from "../memory/refs.mjs";
import { jobIdsOfPrUrl } from "./pr-lookup.mjs";
import { prStateKey } from "./pr-state.mjs";

const JOB_CITATION_RE = /\bJ-(\d+)\b/g;
const PR_CITATION_RE = /https:\/\/github\.com\/[^\s/()<>[\]"'`]+\/[^\s/()<>[\]"'`]+\/pull\/\d+\b/gi;
const URL_SPAN_RE = /https?:\/\/\S+/gi;

// The `[start, end)` spans of every URL of a text.
function urlSpans(text) {
  return [...text.matchAll(URL_SPAN_RE)].map((match) => [match.index, match.index + match[0].length]);
}

// Every job ref of a text outside a URL as `{ kind: "job", id, ref, index }`, skipping a number that is not a safe positive integer.
function jobMatches(text) {
  const spans = urlSpans(text);
  return [...text.matchAll(JOB_CITATION_RE)]
    .filter((match) => !spans.some(([start, end]) => match.index >= start && match.index < end))
    .map((match) => ({ kind: "job", id: Number(match[1]), index: match.index }))
    .filter((citation) => Number.isSafeInteger(citation.id) && citation.id > 0)
    .map((citation) => ({ ...citation, ref: jobRef(citation.id) }));
}

// Every GitHub pull request URL of a text as `{ kind: "pr", url, key, index }`, the URL ending at the pull request number.
function prMatches(text) {
  return [...text.matchAll(PR_CITATION_RE)]
    .map((match) => ({ kind: "pr", url: match[0], key: prStateKey(match[0]), index: match.index }))
    .filter((citation) => citation.key !== null);
}

// The identity two citations of the same thing share.
function citationKey(citation) {
  return citation.kind === "job" ? `job:${citation.id}` : `pr:${citation.key}`;
}

// Every citation of a text, by `J-<n>` or by GitHub pull request URL, in the order they first appear, deduped and uncapped.
function uniqueCitations(text) {
  if (typeof text !== "string" || !text) return [];
  const seen = new Set();
  const ordered = [...jobMatches(text), ...prMatches(text)].sort((a, b) => a.index - b.index);
  return ordered
    .filter((citation) => {
      const key = citationKey(citation);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map(({ index, ...citation }) => citation);
}

// The jobs a text cites, by `J-<n>` or by GitHub pull request URL, in the order they first appear, deduped and capped at five.
export function parseJobCitations(text) {
  return uniqueCitations(text).slice(0, JOB_SEARCH_LIMIT);
}

// The citations of a text without the caller's own `J-<n>`, capped at five.
function citationsBesidesOwn(text, ownJobId) {
  const others = uniqueCitations(text).filter((citation) => !(citation.kind === "job" && citation.id === ownJobId));
  return others.slice(0, JOB_SEARCH_LIMIT);
}

// The ids of the jobs that opened each cited pull request, keyed by its canonical key; a failed lookup is kept as null.
async function prJobIds(store, citations) {
  const byKey = new Map();
  for (const citation of citations.filter((entry) => entry.kind === "pr")) {
    try {
      byKey.set(citation.key, (await jobIdsOfPrUrl(store, citation.url)) ?? []);
    } catch {
      byKey.set(citation.key, null);
    }
  }
  return byKey;
}

// Every job id the citations could name, without the caller's own job.
function candidateIds(citations, prIds, ownJobId) {
  const ids = citations.flatMap((citation) => (citation.kind === "job" ? [citation.id] : prIds.get(citation.key) ?? []));
  return [...new Set(ids)].filter((id) => id !== ownJobId);
}

// The cited jobs of the project, keyed by id; a failed read answers null.
async function sameProjectJobs(store, projectId, ids) {
  if (!ids.length) return new Map();
  try {
    const rows = await store.jobs.jobsByIds({ projectId, ids });
    return new Map((Array.isArray(rows) ? rows : []).map((job) => [job.id, job]));
  } catch {
    return null;
  }
}

// The entry of one `J-<n>` citation: a job of the project, a ref the project does not know, or a failed lookup.
function jobEntry(citation, { jobs }) {
  if (jobs === null) return { kind: "unavailable-job", ref: citation.ref };
  if (jobs.has(citation.id)) return { kind: "cited", job: jobs.get(citation.id) };
  return { kind: "missing-job", ref: citation.ref };
}

// The entry of one pull request citation, naming only the project's own jobs that opened it, or a failed lookup.
function prEntry(citation, { jobs, ownJobId, prIds }) {
  const ids = prIds.get(citation.key);
  if (!Array.isArray(ids)) return { kind: "unavailable-pr", url: citation.url };
  const others = ids.filter((id) => id !== ownJobId);
  if (others.length && jobs === null) return { kind: "unavailable-pr", url: citation.url };
  const same = others.filter((id) => jobs.has(id));
  if (same.length === 1) return { kind: "cited", job: jobs.get(same[0]) };
  if (same.length > 1) return { kind: "ambiguous-pr", url: citation.url, refs: same.map(jobRef) };
  if (ids.includes(ownJobId)) return { kind: "own" };
  return { kind: "missing-pr", url: citation.url };
}

// Keeps the first entry of each cited job, so a job cited by ref and by URL is listed once.
function dedupeCited(entries) {
  const seen = new Set();
  return entries.filter((entry) => {
    if (entry.kind !== "cited") return true;
    if (seen.has(entry.job.id)) return false;
    seen.add(entry.job.id);
    return true;
  });
}

// The jobs a text cites, resolved within one project, one entry per citation (cited, own, missing-job, missing-pr, ambiguous-pr, unavailable-job, unavailable-pr); never throws.
export async function resolveCitations(store, { projectId, text, ownJobId = null } = {}) {
  try {
    const citations = citationsBesidesOwn(text, ownJobId);
    if (!citations.length) return [];
    const prIds = await prJobIds(store, citations);
    const jobs = await sameProjectJobs(store, projectId, candidateIds(citations, prIds, ownJobId));
    const context = { jobs, ownJobId, prIds };
    return dedupeCited(citations.map((citation) => (citation.kind === "job" ? jobEntry(citation, context) : prEntry(citation, context))));
  } catch {
    return [];
  }
}
