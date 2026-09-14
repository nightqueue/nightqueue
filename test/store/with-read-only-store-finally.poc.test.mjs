import assert from "node:assert/strict";
import { existsSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { dbPath } from "../../src/config/paths.mjs";
import { addJob, claimJobById, finishJob } from "../../src/memory/jobs.mjs";
import { withReadOnlyStore } from "../../src/store/open.mjs";
import { makeHome, makeProject } from "../../test-support/memory.mjs";

// Group C of 05a-qa-analyst.md: `withReadOnlyStore`'s `finally` calls `store.close()` unconditionally
// (src/store/open.mjs:29-36); if that call itself threw AND `fn` had already thrown, the `finally`-throws
// semantics of JS would replace `fn`'s error with the close failure. This file first asks whether the real
// `close()` (src/store/local.mjs:162-172 `readOnlyConnection.release`) can ever throw in a state this
// product reaches, before asking whether the masking would matter.

// The one way a real node:sqlite `DatabaseSync` throws on `.close()`: calling it a second time.
test("a real read-only DatabaseSync throws 'database is not open' on a second .close() call", (t) => {
  const env = makeHome(t, "with-read-only-store-finally-language");
  makeProject(t, env, "alpha");
  addJob({ project: "alpha", prompt: "fix the worker" }, env);

  const db = new DatabaseSync(dbPath(env), { readOnly: true });
  db.close();
  assert.throws(() => db.close(), /database is not open/, "node:sqlite's DatabaseSync.close() no longer throws on a double close; the language premise behind Group C changed");
});

// The guard that stands between that language fact and this product: readOnlyConnection's `release()`
// (src/store/local.mjs:166-171) nulls its local `db` before calling the real `.close()`, so a second logical
// `release()` never reaches the real object at all.
test("calling store.close() twice on a real read-only store never dispatches a second real DatabaseSync.close()", async (t) => {
  const env = makeHome(t, "with-read-only-store-finally-guard");
  makeProject(t, env, "alpha");
  addJob({ project: "alpha", prompt: "fix the worker" }, env);

  let realCloseCalls = 0;
  const originalClose = DatabaseSync.prototype.close;
  DatabaseSync.prototype.close = function spy(...args) {
    realCloseCalls += 1;
    return originalClose.apply(this, args);
  };
  t.after(() => {
    DatabaseSync.prototype.close = originalClose;
  });

  await withReadOnlyStore(env, async (store) => {
    await store.jobs.status(1).catch(() => {});
    await store.close();
    await store.close();
  });

  assert.equal(realCloseCalls, 1, `readOnlyConnection's release() dispatched the real close() ${realCloseCalls} times; a second real dispatch is exactly what would let a genuine close failure mask fn's error`);
});

// End-to-end: even when `fn` itself already closed the store before throwing (so the wrapper's own `finally`
// runs a second, logical `store.close()`), the error that escapes `withReadOnlyStore` must still be fn's own,
// never a close-related one - because the guard above makes the second close a no-op, not a real dispatch.
test("withReadOnlyStore surfaces fn's own error untouched even when fn already closed the store before throwing", async (t) => {
  const env = makeHome(t, "with-read-only-store-finally-error");
  makeProject(t, env, "alpha");
  const id = addJob({ project: "alpha", prompt: "fix the worker" }, env).id;
  claimJobById(id, { worker: "host:1", cap: 4 }, env);
  finishJob(id, { worker: "host:1", status: "done" }, env);

  await assert.rejects(
    withReadOnlyStore(env, async (store) => {
      await store.jobs.status(id);
      await store.close();
      throw new Error("DISTINCTIVE_FN_FAILURE");
    }),
    /DISTINCTIVE_FN_FAILURE/,
    "the error that escaped withReadOnlyStore was not fn's own DISTINCTIVE_FN_FAILURE - the finally's own close() call masked it",
  );
});

// A close() that would only throw on a double dispatch is not the only candidate: a file removed out from
// under an open read-only connection (a home reset / org rename racing a long-lived follow) is a state this
// product can reach. If close() tolerated that silently, Group C's whole premise (close() throwing at all,
// outside a double dispatch) has no real trigger left to investigate.
test("closing a read-only DatabaseSync after its underlying file was deleted mid-session does not throw", (t) => {
  const env = makeHome(t, "with-read-only-store-finally-deleted-file");
  makeProject(t, env, "alpha");
  addJob({ project: "alpha", prompt: "fix the worker" }, env);

  const db = new DatabaseSync(dbPath(env), { readOnly: true });
  rmSync(dbPath(env));
  assert.equal(existsSync(dbPath(env)), false, "the database file was not actually removed; this probe's precondition failed");
  assert.doesNotThrow(() => db.close(), "closing after the file vanished threw; this is a second, previously-unflagged path that could mask fn's error and deserves its own ticket");
});
