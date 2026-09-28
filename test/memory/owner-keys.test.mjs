import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { newId } from "../../src/config/ids.mjs";
import { openDb } from "../../src/memory/db.mjs";
import * as registry from "../../src/memory/registry.mjs";
import { makeDir, makeHome } from "../../test-support/memory.mjs";

const DB_URL = new URL("../../src/memory/db.mjs", import.meta.url).href;
const REGISTRY_URL = new URL("../../src/memory/registry.mjs", import.meta.url).href;
const TRIGGER = /owner key taken/;

// A fresh home with the `default` org, a project `alpha` (key AL) and an org `acme` (key AC).
function keyedHome(t, name) {
  const env = makeHome(t, name);
  const db = openDb(env);
  const org = registry.insertOrg(db, "acme", "AC");
  const project = registry.insertProject(db, { name: "alpha", path: null, orgId: org.id, key: "AL" });
  return { env, db, org, project };
}

// The number of rows of a table.
function rowsIn(db, table) {
  return db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
}

test("a key or an old key of any owner is refused to a new project and a new org, by the registry and by the database", (t) => {
  const { db, org, project } = keyedHome(t, "keys-insert");
  registry.setProjectKey(db, { id: project.id, key: "AX" });
  registry.setOrgKey(db, { id: org.id, key: "AY" });
  const cases = [
    ["AX", /key `AX` is taken: it is the key of project `alpha`/],
    ["AL", /key `AL` is taken: it is an old key of project `alpha`/],
    ["AY", /key `AY` is taken: it is the key of org `acme`/],
    ["AC", /key `AC` is taken: it is an old key of org `acme`/],
  ];
  for (const [key, message] of cases) {
    assert.throws(() => registry.insertProject(db, { name: `p-${key}`, path: null, orgId: org.id, key }), message);
    assert.throws(() => registry.insertOrg(db, `o-${key}`, key), message);
    assert.throws(() => db.prepare("INSERT INTO projects (id, name, key, org_id) VALUES (?, ?, ?, ?)").run(newId(), `raw-${key}`, key, org.id), TRIGGER);
    assert.throws(() => db.prepare("INSERT INTO orgs (id, name, key) VALUES (?, ?, ?)").run(newId(), `raw-o-${key}`, key), TRIGGER);
    assert.throws(() => db.prepare("INSERT INTO project_key_aliases (key, project_id) VALUES (?, ?)").run(key, project.id), TRIGGER);
    assert.throws(() => db.prepare("INSERT INTO org_key_aliases (key, org_id) VALUES (?, ?)").run(key, org.id), TRIGGER);
  }
  assert.throws(() => db.prepare("UPDATE projects SET key = 'AY' WHERE id = ?").run(project.id), TRIGGER);
  assert.throws(() => db.prepare("UPDATE orgs SET key = 'AL' WHERE id = ?").run(org.id), TRIGGER);
  assert.throws(() => db.prepare("INSERT OR REPLACE INTO projects (id, name, key, org_id) VALUES (?, 'alpha', 'AY', ?)").run(project.id, org.id), TRIGGER);
});

test("a key rename is one row changed and one alias added, and the old key keeps naming the owner", (t) => {
  const { db, project } = keyedHome(t, "keys-rename");
  const aliases = rowsIn(db, "project_key_aliases");
  const changes = db.prepare("SELECT total_changes() AS n").get().n;
  const renamed = registry.setProjectKey(db, { id: project.id, key: "nx" });
  assert.deepEqual({ oldKey: renamed.oldKey, key: renamed.key, rowKey: renamed.row.key }, { oldKey: "AL", key: "NX", rowKey: "NX" });
  assert.equal(rowsIn(db, "project_key_aliases"), aliases + 1);
  assert.equal(db.prepare("SELECT total_changes() AS n").get().n - changes, 2, "a rename wrote more than one row and one alias");
  assert.deepEqual(registry.keyHolder(db, "AL"), { kind: "project", id: project.id, name: "alpha", current: false });
  assert.equal(registry.ownerByKey(db, "AL").projectId, project.id);
  assert.equal(registry.ownerByKey(db, "NX").projectId, project.id);
  assert.equal(registry.ownerByKey(db, "ZZ"), null);
});

test("an owner reclaims its own old key, never another owner's, and never its current one", (t) => {
  const { db, org, project } = keyedHome(t, "keys-reclaim");
  registry.setProjectKey(db, { id: project.id, key: "NX" });
  const back = registry.setProjectKey(db, { id: project.id, key: "AL" });
  assert.equal(back.row.key, "AL");
  assert.deepEqual(db.prepare("SELECT key FROM project_key_aliases WHERE project_id = ?").all(project.id).map((row) => row.key), ["NX"]);
  registry.setOrgKey(db, { id: org.id, key: "AZ" });
  assert.throws(() => registry.setProjectKey(db, { id: project.id, key: "AC" }), /key `AC` is taken: it is an old key of org `acme`/);
  assert.throws(() => registry.setProjectKey(db, { id: project.id, key: "AL" }), /project `alpha` already has key `AL`/);
  assert.throws(() => registry.setProjectKey(db, { id: project.id, key: "1X" }), /key `1X` is invalid/);
});

test("an alias is never edited, and removing a project removes its aliases", (t) => {
  const { db, org, project } = keyedHome(t, "keys-alias");
  registry.setProjectKey(db, { id: project.id, key: "NX" });
  registry.setOrgKey(db, { id: org.id, key: "OX" });
  assert.throws(() => db.prepare("UPDATE project_key_aliases SET key = 'QQ' WHERE key = 'AL'").run(), /owner key aliases are never edited/);
  assert.throws(() => db.prepare("UPDATE org_key_aliases SET org_id = org_id WHERE key = 'AC'").run(), /owner key aliases are never edited/);
  registry.removeProject(db, project.id);
  assert.equal(rowsIn(db, "project_key_aliases"), 0);
  assert.equal(registry.keyHolder(db, "AL"), null);
});

test("a registry without an org gets a default org with a valid key, and a derived key skips every key already held", (t) => {
  const env = makeHome(t, "keys-default");
  const db = openDb(env);
  db.exec("DELETE FROM orgs");
  registry.ensureDefaultOrg(db);
  assert.match(registry.earliestOrg(db).key, /^[A-Z][A-Z0-9]{1,4}$/);
  const org = registry.earliestOrg(db);
  const first = registry.insertProject(db, { name: "nightqueue", path: null, orgId: org.id });
  const second = registry.insertProject(db, { name: "nightqueue-two", path: null, orgId: org.id });
  registry.setProjectKey(db, { id: first.id, key: "ZZ" });
  const third = registry.insertProject(db, { name: "nightqueue-three", path: null, orgId: org.id });
  assert.deepEqual([first.key, second.key, third.key], ["NQ", "NT", "NTA"]);
  assert.equal(registry.suggestFreeKey(db, "nightqueue", "project"), "NQA", "a derived key reused an old key");
});

// Source of a process that registers a project with an asked key at a shared instant and prints the outcome.
function registrarSource() {
  return [
    `import { openDb } from ${JSON.stringify(DB_URL)};`,
    `import * as registry from ${JSON.stringify(REGISTRY_URL)};`,
    "const [, , startAt, name, key] = process.argv;",
    "const db = openDb(process.env);",
    "const orgId = registry.earliestOrg(db).id;",
    "while (Date.now() < Number(startAt)) {}",
    "try {",
    "  registry.insertProject(db, { name, path: null, orgId, key });",
    '  process.stdout.write(JSON.stringify({ ok: true }) + "\\n");',
    "} catch (err) {",
    '  process.stdout.write(JSON.stringify({ ok: false, error: err.message }) + "\\n");',
    "}",
    "",
  ].join("\n");
}

// Runs one registrar as a real child process.
function spawnRegistrar(env, script, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", script, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.on("error", reject);
    child.on("exit", () => resolve(JSON.parse(stdout.trim())));
  });
}

test("two processes asking the same key for two projects at once: one gets it, the other is refused, one row holds it", async (t) => {
  const env = makeHome(t, "keys-race");
  openDb(env);
  const script = join(makeDir(t, "keys-race-script"), "registrar.mjs");
  writeFileSync(script, registrarSource());
  const startAt = String(Date.now() + 400);
  const results = await Promise.all([spawnRegistrar(env, script, [startAt, "one", "KK"]), spawnRegistrar(env, script, [startAt, "two", "KK"])]);
  assert.equal(results.filter((result) => result.ok).length, 1, JSON.stringify(results));
  assert.match(results.find((result) => !result.ok).error, /key `KK` is taken: it is the key of project `(one|two)`/);
  assert.equal(openDb(env).prepare("SELECT COUNT(*) AS n FROM projects WHERE key = 'KK'").get().n, 1);
});
