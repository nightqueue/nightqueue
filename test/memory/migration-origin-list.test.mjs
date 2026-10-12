import assert from "node:assert/strict";
import { test } from "node:test";
import { closeDb, DB_USER_VERSION, openDb } from "../../src/memory/db.mjs";
import { addJob, getJob, jobView } from "../../src/memory/jobs.mjs";
import { migrateOriginLists } from "../../src/memory/migration/origin-list.mjs";
import { makeHome, makeProject, projectIdOf } from "../../test-support/memory.mjs";

const STORED = [
  { label: "single object", value: JSON.stringify({ kind: "sentry", ref: "1" }), expected: JSON.stringify([{ kind: "sentry", ref: "1" }]) },
  { label: "object with padded texts", value: JSON.stringify({ kind: " linear ", ref: " MK-1 " }), expected: JSON.stringify([{ kind: "linear", ref: "MK-1" }]) },
  { label: "malformed text", value: "{broken", expected: null },
  { label: "number", value: 42, expected: null },
  { label: "blob", value: Buffer.from([0, 1, 2]), expected: null },
  { label: "missing ref", value: JSON.stringify({ kind: "sentry" }), expected: null },
  { label: "empty kind", value: JSON.stringify({ kind: "", ref: "1" }), expected: null },
  { label: "numeric ref", value: JSON.stringify({ kind: "sentry", ref: 1 }), expected: null },
  { label: "json string", value: JSON.stringify("sentry 1"), expected: null },
  { label: "existing list", value: JSON.stringify([{ kind: "discord", ref: "1/2/3" }]), expected: JSON.stringify([{ kind: "discord", ref: "1/2/3" }]) },
  { label: "null", value: null, expected: null },
];

// A home with the project `alpha` and one job per stored origin value, written raw as an older build left it.
function makeStoredHome(t, name) {
  const env = makeHome(t, name);
  makeProject(t, env, "alpha");
  const projectId = projectIdOf(env, "alpha");
  const db = openDb(env);
  const ids = STORED.map(({ value }) => {
    const id = addJob({ projectId, prompt: "fix it", origin: [] }, env).id;
    db.prepare("UPDATE jobs SET origin = ? WHERE id = ?").run(value, id);
    return id;
  });
  closeDb(env);
  return { env, ids };
}

test("the next open rewrites a stored single origin as a one-element list and anything unreadable as none, keeping lists and nulls", (t) => {
  const { env, ids } = makeStoredHome(t, "migration-origin-list");
  const db = openDb(env);
  STORED.forEach(({ label, expected }, index) => {
    assert.equal(getJob(ids[index], env).origin, expected, label);
  });
  assert.equal(db.prepare("PRAGMA user_version").get().user_version, DB_USER_VERSION);
  assert.deepEqual(jobView(getJob(ids[0], env)).origin, [{ kind: "sentry", ref: "1" }]);
  assert.deepEqual(jobView(getJob(ids[2], env)).origin, []);
});

test("once migrated the read gate finds nothing and a second pass writes nothing", (t) => {
  const { env } = makeStoredHome(t, "migration-origin-list-again");
  const db = openDb(env);
  const before = db.prepare("SELECT total_changes() AS n").get().n;
  migrateOriginLists(db);
  assert.equal(db.prepare("SELECT total_changes() AS n").get().n, before);
  closeDb(env);
  const reopened = openDb(env);
  const after = reopened.prepare("SELECT origin FROM jobs ORDER BY id").all().map((row) => row.origin);
  assert.deepEqual(after, STORED.map(({ expected }) => expected));
});
