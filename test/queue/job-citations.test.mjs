import assert from "node:assert/strict";
import { test } from "node:test";
import { parseJobCitations, resolveCitations } from "../../src/queue/job-citations.mjs";
import { jobIdOfPrUrl, jobIdsOfPrUrl } from "../../src/queue/pr-lookup.mjs";

// A fake store over a list of `{ id, projectId, pr_url }` jobs, answering the two reads the citations use.
function fakeStore(jobs, { failPrLookup = false, failByIds = false } = {}) {
  return {
    jobs: {
      jobsWithPrNumber: async (number) => {
        if (failPrLookup) throw new Error("store down");
        return jobs.filter((job) => String(job.pr_url ?? "").includes(`/pull/${number}`)).map(({ id, pr_url }) => ({ id, pr_url }));
      },
      jobsByIds: async ({ projectId, ids }) => {
        if (failByIds) throw new Error("store down");
        return ids.map((id) => jobs.find((job) => job.id === id && job.projectId === projectId)).filter(Boolean);
      },
    },
  };
}

const JOBS = [
  { id: 3, projectId: "alpha", pr_url: "https://github.com/o/r/pull/7" },
  { id: 4, projectId: "alpha", pr_url: "https://github.com/o/r/pull/7" },
  { id: 5, projectId: "alpha", pr_url: "https://github.com/o/r/pull/42" },
  { id: 6, projectId: "beta", pr_url: "https://github.com/o/r/pull/50" },
  { id: 7, projectId: "beta", pr_url: "https://github.com/o/r/pull/7" },
  { id: 8, projectId: "alpha", pr_url: "https://github.com/o/r/pull/60" },
];

test("parseJobCitations answers job refs and pull request URLs in the order they appear", () => {
  const text = "see https://github.com/o/r/pull/42 then J-12, and J-3.";
  assert.deepEqual(parseJobCitations(text), [
    { kind: "pr", url: "https://github.com/o/r/pull/42", key: "o/r#42" },
    { kind: "job", id: 12, ref: "J-12" },
    { kind: "job", id: 3, ref: "J-3" },
  ]);
});

test("parseJobCitations dedupes job refs by id and URLs by pull request", () => {
  const text = "J-12 J-12 https://github.com/O/R/pull/42 https://github.com/o/r/pull/42/files";
  assert.deepEqual(
    parseJobCitations(text).map((citation) => citation.ref ?? citation.key),
    ["J-12", "o/r#42"],
  );
});

test("parseJobCitations ignores decoys: J-stream, project keys, lowercase refs, bare numbers and zero", () => {
  assert.deepEqual(parseJobCitations("J-stream NQ-48 j-5 obj-1 #12 XJ-9 J-0 https://github.com/o/r/issues/4"), []);
});

test("parseJobCitations cuts a URL at its pull request number, before punctuation or a path", () => {
  const text = "(https://github.com/o/r/pull/42). and https://github.com/o/r/pull/43/files, https://github.com/o/r/pull/44.";
  assert.deepEqual(
    parseJobCitations(text).map((citation) => citation.url),
    ["https://github.com/o/r/pull/42", "https://github.com/o/r/pull/43", "https://github.com/o/r/pull/44"],
  );
});

test("parseJobCitations does not read a J-<n> inside a URL as a job citation", () => {
  assert.deepEqual(
    parseJobCitations("see https://github.com/o/J-5/pull/3 please, https://linear.app/t/issue/J-7 and J-2").map((citation) => citation.ref ?? citation.key),
    ["o/j-5#3", "J-2"],
  );
});

test("parseJobCitations caps the citations at five and answers none for a non-text input", () => {
  assert.equal(parseJobCitations("J-1 J-2 J-3 J-4 J-5 J-6 J-7").length, 5);
  assert.deepEqual(parseJobCitations(null), []);
  assert.deepEqual(parseJobCitations(42), []);
});

test("jobIdsOfPrUrl answers null for a non pull request URL, else every job id that opened it", async () => {
  const store = fakeStore(JOBS);
  assert.equal(await jobIdsOfPrUrl(store, "https://github.com/o/r/issues/7"), null);
  assert.deepEqual(await jobIdsOfPrUrl(store, "https://github.com/o/r/pull/99"), []);
  assert.deepEqual(await jobIdsOfPrUrl(store, "https://github.com/o/r/pull/42"), [5]);
  assert.deepEqual(await jobIdsOfPrUrl(store, "https://github.com/o/r/pull/7"), [3, 4, 7]);
});

test("jobIdOfPrUrl keeps its refusals and their messages", async () => {
  const store = fakeStore(JOBS);
  assert.equal(await jobIdOfPrUrl(store, "https://github.com/o/r/pull/42"), 5);
  await assert.rejects(jobIdOfPrUrl(store, "nope"), { message: "not a GitHub pull request URL: `nope`" });
  await assert.rejects(jobIdOfPrUrl(store, "https://github.com/o/r/pull/99"), { message: "no job opened `https://github.com/o/r/pull/99`" });
  await assert.rejects(jobIdOfPrUrl(store, "https://github.com/o/r/pull/7"), {
    message: "`https://github.com/o/r/pull/7` was opened by more than one job: J-3, J-4, J-7; pass one of them",
  });
});

// Resolves a text's citations against the fake jobs, from project alpha and job 8.
function resolve(text, options) {
  return resolveCitations(fakeStore(JOBS, options), { projectId: "alpha", text, ownJobId: 8 });
}

test("resolveCitations answers a same-project job cited by ref or by URL as cited", async () => {
  const entries = await resolve("J-3 and https://github.com/o/r/pull/42");
  assert.deepEqual(
    entries.map((entry) => [entry.kind, entry.job.id]),
    [
      ["cited", 3],
      ["cited", 5],
    ],
  );
});

test("resolveCitations reads an unknown job and another project's job the same way", async () => {
  const entries = await resolve("J-999 J-6");
  assert.deepEqual(entries, [
    { kind: "missing-job", ref: "J-999" },
    { kind: "missing-job", ref: "J-6" },
  ]);
});

test("resolveCitations drops the caller's own ref and marks a URL only it opened as own", async () => {
  const entries = await resolve("J-8 https://github.com/o/r/pull/60");
  assert.deepEqual(entries, [{ kind: "own" }]);
});

test("resolveCitations drops the caller's own ref before capping, so five other jobs still resolve", async () => {
  const store = { jobs: { jobsWithPrNumber: async () => [], jobsByIds: async ({ ids }) => ids.map((id) => ({ id })) } };
  const entries = await resolveCitations(store, { projectId: "alpha", text: "J-9 J-1 J-2 J-3 J-4 J-5", ownJobId: 9 });
  assert.deepEqual(
    entries.map((entry) => [entry.kind, entry.job.id]),
    [1, 2, 3, 4, 5].map((id) => ["cited", id]),
  );
});

test("resolveCitations answers a URL no job of the project opened as missing, even when another project's did", async () => {
  const entries = await resolve("https://github.com/o/r/pull/99 https://github.com/o/r/pull/50");
  assert.deepEqual(entries, [
    { kind: "missing-pr", url: "https://github.com/o/r/pull/99" },
    { kind: "missing-pr", url: "https://github.com/o/r/pull/50" },
  ]);
});

test("resolveCitations names only the project's own jobs of an ambiguous URL", async () => {
  const entries = await resolve("https://github.com/o/r/pull/7");
  assert.deepEqual(entries, [{ kind: "ambiguous-pr", url: "https://github.com/o/r/pull/7", refs: ["J-3", "J-4"] }]);
});

test("resolveCitations lists a job cited by ref and by URL once, at its first place", async () => {
  const entries = await resolve("https://github.com/o/r/pull/42 J-3 J-5");
  assert.deepEqual(
    entries.map((entry) => [entry.kind, entry.job.id]),
    [
      ["cited", 5],
      ["cited", 3],
    ],
  );
});

test("resolveCitations never throws and never reads a failed lookup as an absence", async () => {
  assert.deepEqual(await resolve("https://github.com/o/r/pull/42", { failPrLookup: true }), [
    { kind: "unavailable-pr", url: "https://github.com/o/r/pull/42" },
  ]);
  assert.deepEqual(await resolve("https://github.com/o/r/pull/42", { failByIds: true }), [
    { kind: "unavailable-pr", url: "https://github.com/o/r/pull/42" },
  ]);
  assert.deepEqual(await resolve("J-3", { failByIds: true }), [{ kind: "unavailable-job", ref: "J-3" }]);
  assert.deepEqual(await resolveCitations(null, { projectId: "alpha", text: "J-3" }), [{ kind: "unavailable-job", ref: "J-3" }]);
  assert.deepEqual(await resolve("no citation here"), []);
});

test("resolveCitations keeps a truthful absence when only the job read fails and no job opened the URL", async () => {
  assert.deepEqual(await resolve("https://github.com/o/r/pull/99 J-3", { failByIds: true }), [
    { kind: "missing-pr", url: "https://github.com/o/r/pull/99" },
    { kind: "unavailable-job", ref: "J-3" },
  ]);
});
