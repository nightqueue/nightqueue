import assert from "node:assert/strict";
import { test } from "node:test";
import { openDb } from "../../src/memory/db.mjs";
import { getLesson, saveLesson, setLessonEmbedding } from "../../src/memory/lessons.mjs";
import { saveMemory } from "../../src/memory/memory.mjs";
import { recallLessons, recallMemories, searchLessonsLexical } from "../../src/memory/search.mjs";
import { fakeEmbedder, makeHome, makeProject } from "../../test-support/memory.mjs";

const FAKE_MODEL = "fake-embedder@v1";

// Inserts a lesson with a controlled creation time and violation count, so the recall order is deterministic.
function addLesson(env, { project = null, title, prevention = "keep the invariant", target, createdAt, violated = 0 }) {
  const { id } = saveLesson(
    { project, title, root_cause: `${title} happened again`, solution: "fix it", prevention, target },
    env,
  );
  const db = openDb(env);
  if (createdAt) db.prepare("UPDATE lessons SET created_at = ? WHERE id = ?").run(createdAt, id);
  if (violated) db.prepare("UPDATE lessons SET violated = ? WHERE id = ?").run(violated, id);
  return id;
}

// Ids of a recall result, in the order the recall returned them.
function idsOf(rows) {
  return rows.map((row) => row.id);
}

test("without a query the recall orders by project, then violated, then recency, and keeps the globals", async (t) => {
  const env = makeHome(t, "search-order");
  makeProject(t, env, "alpha");
  makeProject(t, env, "beta");
  const older = addLesson(env, { project: "alpha", title: "alpha older lesson", createdAt: "2024-01-01 10:00:00" });
  const violated = addLesson(env, {
    project: "alpha",
    title: "alpha violated lesson",
    createdAt: "2024-01-02 10:00:00",
    violated: 2,
  });
  const global = addLesson(env, { title: "global lesson", createdAt: "2024-03-01 10:00:00" });
  const other = addLesson(env, { project: "beta", title: "beta lesson", createdAt: "2024-04-01 10:00:00" });

  const rows = await recallLessons({ project: "alpha", limit: 8 }, env);
  assert.deepEqual(idsOf(rows), [violated, older, global]);
  assert.deepEqual(
    rows.map((row) => row.via),
    ["lexical", "lexical", "lexical"],
  );
  assert.equal(idsOf(rows).includes(other), false);
});

test("without a query a lesson of another project never shows up", async (t) => {
  const env = makeHome(t, "search-scope");
  makeProject(t, env, "alpha");
  makeProject(t, env, "beta");
  addLesson(env, { project: "beta", title: "beta only lesson" });
  const mine = addLesson(env, { project: "alpha", title: "alpha only lesson" });
  assert.deepEqual(idsOf(await recallLessons({ project: "alpha" }, env)), [mine]);
});

test("with a query and an embedder that returns nothing, the result is the pure BM25 one", async (t) => {
  const env = makeHome(t, "search-bm25", { embed: true });
  makeProject(t, env, "alpha");
  addLesson(env, { project: "alpha", title: "the worker leaks a file descriptor on failure" });
  addLesson(env, { project: "alpha", title: "the migration drops the unique index" });
  const query = "the worker leaks a file descriptor when the run fails";
  const embedder = fakeEmbedder(null);

  const rows = await recallLessons({ query, project: "alpha", embedder }, env);
  const lexical = searchLessonsLexical({ query, project: "alpha", limit: 8 }, env);
  assert.ok(rows.length > 0);
  assert.deepEqual(idsOf(rows), idsOf(lexical));
  assert.deepEqual(new Set(rows.map((row) => row.via)), new Set(["lexical"]));
  assert.equal(embedder.calls.length, 1);
});

test("the hybrid recall adds semantic hits without ever dropping a BM25 one", async (t) => {
  const env = makeHome(t, "search-hybrid", { embed: true });
  makeProject(t, env, "alpha");
  const query = "the worker leaks a file descriptor when the run fails";
  const lexicalIds = [
    addLesson(env, { project: "alpha", title: "the worker leaks a file descriptor on failure" }),
    addLesson(env, { project: "alpha", title: "the worker leaks a descriptor when the run fails" }),
    addLesson(env, { project: "alpha", title: "the run fails and leaks a file descriptor" }),
  ];
  const semanticId = addLesson(env, { project: "alpha", title: "unrelated wording about resource cleanup" });
  const farId = addLesson(env, { project: "alpha", title: "another unrelated wording about caching" });
  setLessonEmbedding({ id: semanticId, vector: [1, 0, 0, 0], model: FAKE_MODEL }, env);
  setLessonEmbedding({ id: farId, vector: [0, 1, 0, 0], model: FAKE_MODEL }, env);
  const embedder = fakeEmbedder([1, 0, 0, 0]);

  const rows = await recallLessons({ query, project: "alpha", limit: 8, embedder }, env);
  const ids = idsOf(rows);
  for (const id of lexicalIds) assert.ok(ids.includes(id), `lexical lesson ${id} survived the fusion`);
  assert.ok(ids.includes(semanticId));
  assert.equal(ids.includes(farId), false);
  assert.equal(rows.find((row) => row.id === semanticId).via, "semantic");
  assert.equal(rows[0].via, "lexical");

  const tight = await recallLessons({ query, project: "alpha", limit: 3, embedder }, env);
  for (const id of lexicalIds) assert.ok(idsOf(tight).includes(id), `lexical lesson ${id} survived the tight limit`);
});

test("an embedder that never answers loses its slot at the deadline and the lexical result stands", async (t) => {
  const env = makeHome(t, "search-deadline", { embed: true });
  makeProject(t, env, "alpha");
  const id = addLesson(env, { project: "alpha", title: "the worker leaks a file descriptor on failure" });
  const embedder = { model: FAKE_MODEL, embedText: () => new Promise(() => {}) };
  const started = Date.now();
  const rows = await recallLessons(
    { query: "the worker leaks a file descriptor when the run fails", project: "alpha", embedder, deadlineMs: 20 },
    env,
  );
  assert.deepEqual(idsOf(rows), [id]);
  assert.ok(Date.now() - started < 1000, `recall answered in ${Date.now() - started}ms`);
});

test("an embedder that throws does not cost the lexical result", async (t) => {
  const env = makeHome(t, "search-embed-throws", { embed: true });
  makeProject(t, env, "alpha");
  const id = addLesson(env, { project: "alpha", title: "the worker leaks a file descriptor on failure" });
  const embedder = {
    model: FAKE_MODEL,
    embedText: async () => {
      throw new Error("embedder is down");
    },
  };
  const rows = await recallLessons(
    { query: "the worker leaks a file descriptor when the run fails", project: "alpha", embedder },
    env,
  );
  assert.deepEqual(idsOf(rows), [id]);
});

test("NIGHTSHIFT_EMBED_DISABLED skips the semantic path entirely", async (t) => {
  const env = makeHome(t, "search-disabled");
  makeProject(t, env, "alpha");
  const id = addLesson(env, { project: "alpha", title: "the worker leaks a file descriptor on failure" });
  const embedder = fakeEmbedder([1, 0, 0, 0]);
  const rows = await recallLessons(
    { query: "the worker leaks a file descriptor when the run fails", project: "alpha", embedder },
    env,
  );
  assert.deepEqual(idsOf(rows), [id]);
  assert.equal(embedder.calls.length, 0);
});

test("exclude_ids drops the integers it can use and ignores the rest, capped at 200", async (t) => {
  const env = makeHome(t, "search-exclude");
  makeProject(t, env, "alpha");
  const first = addLesson(env, { project: "alpha", title: "first lesson", createdAt: "2024-01-01 10:00:00" });
  const second = addLesson(env, { project: "alpha", title: "second lesson", createdAt: "2024-01-02 10:00:00" });

  const excluded = await recallLessons({ project: "alpha", excludeIds: [first, "2", null, 1.5, {}] }, env);
  assert.deepEqual(idsOf(excluded), [second]);

  const overflow = [...Array.from({ length: 200 }, (_, i) => 100000 + i), second];
  assert.deepEqual(idsOf(await recallLessons({ project: "alpha", excludeIds: overflow }, env)), [second, first]);
});

test("the target filter is soft: it narrows when it can and steps aside when it finds nothing", async (t) => {
  const env = makeHome(t, "search-target");
  makeProject(t, env, "alpha");
  const coder = addLesson(env, {
    project: "alpha",
    title: "the worker leaks a file descriptor on failure",
    target: "coder",
  });
  const qa = addLesson(env, { project: "alpha", title: "the regression suite hides a flaky test", target: "qa" });

  assert.deepEqual(idsOf(await recallLessons({ project: "alpha", target: "coder" }, env)), [coder]);
  assert.deepEqual(
    idsOf(await recallLessons({ project: "alpha", target: "verifier" }, env)).sort(),
    [coder, qa].sort(),
  );
  const narrowed = await recallLessons(
    { query: "the worker leaks a file descriptor when the run fails", project: "alpha", target: "coder" },
    env,
  );
  assert.deepEqual(idsOf(narrowed), [coder]);
});

test("a lesson that only matches one token of a three token query stays out", async (t) => {
  const env = makeHome(t, "search-coverage");
  const full = addLesson(env, { title: "database connection pooling times out under load" });
  const partial = addLesson(env, { title: "database schema versioning is manual" });
  const rows = await recallLessons({ query: "database connection pooling timeout" }, env);
  assert.deepEqual(idsOf(rows), [full]);
  assert.equal(idsOf(rows).includes(partial), false);
});

test("a query that matches nothing falls back to the recent lessons, marked as fallback", async (t) => {
  const env = makeHome(t, "search-fallback");
  makeProject(t, env, "alpha");
  const id = addLesson(env, { project: "alpha", title: "the worker leaks a file descriptor on failure" });
  const rows = await recallLessons({ query: "kubernetes ingress certificate rotation", project: "alpha" }, env);
  assert.deepEqual(idsOf(rows), [id]);
  assert.deepEqual(
    rows.map((row) => row.via),
    ["fallback"],
  );
});

test("a lesson with an empty prevention has nothing to inject: it never comes back from the recall, in any path", async (t) => {
  const env = makeHome(t, "search-empty-prevention");
  makeProject(t, env, "alpha");
  const complete = addLesson(env, { project: "alpha", title: "the worker retries the same broken payload" });
  const { id: incomplete } = saveLesson(
    { project: "alpha", title: "the worker retries a different broken payload", root_cause: "y", solution: "z", prevention: "" },
    env,
  );
  assert.equal(getLesson(incomplete, env)?.id, incomplete, "the lesson was never stored");

  assert.deepEqual(idsOf(await recallLessons({ project: "alpha" }, env)), [complete]);
  assert.deepEqual(idsOf(await recallLessons({ query: "worker retries broken payload", project: "alpha" }, env)), [complete]);
});

test("the memory recall searches with a query and lists the recent ones without it", async (t) => {
  const env = makeHome(t, "search-memory");
  makeProject(t, env, "alpha");
  saveMemory({ project: "alpha", key: "deploy", value: "the deployment runs from the pipeline" }, env);
  saveMemory({ project: "alpha", key: "database", value: "the reports read from the replica" }, env);
  saveMemory({ project: "alpha", key: "cache", value: "redis keys expire in one hour" }, env);

  const searched = await recallMemories({ query: "how does the deployment run", project: "alpha" }, env);
  assert.equal(searched[0].key, "deploy");
  assert.equal(
    searched.some((row) => row.key === "cache"),
    false,
  );
  const recent = await recallMemories({ project: "alpha" }, env);
  assert.deepEqual(recent.map((row) => row.key).sort(), ["cache", "database", "deploy"]);
});
