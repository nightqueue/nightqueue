import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { UserError } from "../../src/config/errors.mjs";
import { isId, newId } from "../../src/config/ids.mjs";
import { dbPath } from "../../src/config/paths.mjs";
import { openDb } from "../../src/memory/db.mjs";
import { saveDecision } from "../../src/memory/decisions.mjs";
import * as registry from "../../src/memory/registry.mjs";
import { makeHostEnv } from "../../test-support/host.mjs";
import { makeDir, makeHome, makeOrg, makeProject } from "../../test-support/memory.mjs";

const CLI = fileURLToPath(new URL("../../bin/nightqueue.mjs", import.meta.url));
const PROJECTS_URL = new URL("../../src/config/projects.mjs", import.meta.url).href;
const STORE_URL = new URL("../../src/store/open.mjs", import.meta.url).href;
const CONFIG_URL = new URL("../../src/config/store.mjs", import.meta.url).href;

// Runs the real CLI in its own process, with the isolated home of the test.
function runCli(env, args, { cwd } = {}) {
  return spawnSync(process.execPath, [CLI, ...args], { env, cwd, encoding: "utf8" });
}

test("ids are 26-character monotonic ULIDs", () => {
  const ids = Array.from({ length: 200 }, () => newId(1_700_000_000_000));
  assert.ok(ids.every(isId));
  assert.deepEqual([...ids].sort(), ids, "ids of one millisecond are out of creation order");
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(isId("default"), false);
  assert.equal(isId(null), false);
});

test("an org rename is one transaction: when the sweep of its rows fails, the org and its rows keep the old name", (t) => {
  const env = makeHome(t, "registry-rename-atomic");
  makeOrg(env, "acme");
  saveDecision({ org: "acme", title: "one queue per product", context: "c", decision: "d" }, env);
  const db = openDb(env);
  db.exec("CREATE TRIGGER refuse_org_sweep BEFORE UPDATE OF org ON decisions BEGIN SELECT RAISE(ABORT, 'sweep refused'); END;");
  const acme = registry.orgByName(db, "acme");
  assert.throws(() => registry.renameOrg(db, { id: acme.id, name: "acme-inc" }), /sweep refused/);
  assert.equal(registry.orgById(db, acme.id).name, "acme");
  assert.equal(db.prepare("SELECT org FROM decisions").get().org, "acme");
  db.exec("DROP TRIGGER refuse_org_sweep");
  registry.renameOrg(db, { id: acme.id, name: "acme-inc" });
  assert.equal(registry.orgById(db, acme.id).name, "acme-inc");
  assert.equal(db.prepare("SELECT org FROM decisions").get().org, "acme-inc");
});

test("a taken name, a taken path and an org still in use are refused with a usage error, and nothing is written", (t) => {
  const env = makeHome(t, "registry-refusals");
  const path = makeProject(t, env, "alpha", { org: "acme" });
  const db = openDb(env);
  const acme = registry.orgByName(db, "acme");
  assert.throws(() => registry.insertProject(db, { name: "alpha", path: null, orgId: acme.id }), (err) => {
    assert.ok(err instanceof UserError);
    assert.match(err.message, /project name `alpha` is already taken/);
    return true;
  });
  const registered = registry.projectByName(db, "alpha").path;
  assert.throws(() => registry.insertProject(db, { name: "beta", path: registered, orgId: acme.id }), /is already registered as `alpha`/);
  assert.throws(() => registry.insertOrg(db, "acme"), /org `acme` already exists/);
  assert.throws(() => registry.removeOrg(db, acme.id), /1 project\(s\) still point to it: alpha/);
  assert.deepEqual(registry.listProjects(db).map((project) => project.name), ["alpha"]);
  assert.ok(existsSync(path));
});

test("a project that still owns rows is refused a removal, listing what it owns", (t) => {
  const env = makeHome(t, "registry-owned");
  makeProject(t, env, "alpha");
  saveDecision({ project: "alpha", title: "t", context: "c", decision: "d" }, env);
  const db = openDb(env);
  const alpha = registry.projectByName(db, "alpha");
  assert.deepEqual(registry.ownedRowCounts(db, { projectId: alpha.id }), [{ table: "decisions", total: 1 }]);
  assert.throws(() => registry.removeProject(db, alpha.id), /cannot remove project `alpha`: it still owns 1 decisions; nothing was removed/);
  assert.equal(registry.projectById(db, alpha.id).name, "alpha");
});

test("the read commands never create the database, and a write command does", (t) => {
  const { env } = makeHostEnv(t, "registry-read-no-db");
  const cwd = makeDir(t, "registry-read-no-db-cwd");
  const orgs = runCli(env, ["org", "list", "--json"], { cwd });
  assert.equal(orgs.status, 0, orgs.stderr);
  assert.deepEqual(JSON.parse(orgs.stdout), { defaultOrg: null, orgs: [] });
  const projects = runCli(env, ["project", "list"], { cwd });
  assert.equal(projects.status, 0, projects.stderr);
  assert.equal(projects.stdout.trim(), "no projects registered");
  runCli(env, ["doctor", "--json"], { cwd });
  assert.equal(existsSync(dbPath(env)), false, "a read command created the database");

  const added = runCli(env, ["org", "add", "acme"], { cwd });
  assert.equal(added.status, 0, added.stderr);
  assert.equal(existsSync(dbPath(env)), true, "a write command did not create the database");
  const listed = JSON.parse(runCli(env, ["org", "list", "--json"], { cwd }).stdout);
  assert.deepEqual(listed.orgs.map((org) => [org.name, org.isDefault, isId(org.id)]), [["default", true, true], ["acme", false, true]]);
});

test("project list prints a project known only from history without a path, and `project move --path` gives it one", (t) => {
  const env = makeHome(t, "registry-history");
  const db = openDb(env);
  registry.insertProject(db, { name: "legacy", path: null, orgId: registry.earliestOrg(db).id });
  const listed = runCli(env, ["project", "list"]);
  assert.equal(listed.status, 0, listed.stderr);
  assert.equal(listed.stdout.trim(), "legacy  (no path)  default");
  const checkout = makeDir(t, "registry-history-checkout");
  mkdirSync(join(checkout, ".git"));
  const moved = runCli(env, ["project", "move", "legacy", "--path", checkout]);
  assert.equal(moved.status, 0, moved.stderr);
  assert.match(moved.stdout, /^moved project `legacy` to path /);
  assert.equal(JSON.parse(runCli(env, ["project", "list", "--json"]).stdout).projects[0].exists, true);
});

// Source of a process that registers one repository at a shared instant and prints what happened.
function registrarSource() {
  return [
    `import { registerProject } from ${JSON.stringify(PROJECTS_URL)};`,
    `import { openStore } from ${JSON.stringify(STORE_URL)};`,
    `import { loadConfig } from ${JSON.stringify(CONFIG_URL)};`,
    "const [path, name, startAt] = process.argv.slice(2);",
    "while (Date.now() < Number(startAt)) {}",
    "try {",
    "  const { status } = await registerProject(openStore(process.env), loadConfig(process.env), { path, name });",
    '  process.stdout.write(JSON.stringify({ status, error: null, user: false }) + "\\n");',
    "} catch (err) {",
    '  process.stdout.write(JSON.stringify({ status: null, error: err.message, user: err.name === "UserError" || err.constructor?.name === "UserError" }) + "\\n");',
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

test("two processes registering the same name, or the same path, at once: one succeeds, the other is refused, nothing else is written", async (t) => {
  const script = join(makeDir(t, "registry-race-script"), "registrar.mjs");
  writeFileSync(script, registrarSource());
  const repo = (name) => {
    const dir = join(makeDir(t, `registry-race-${name}`), name);
    mkdirSync(join(dir, ".git"), { recursive: true });
    return dir;
  };
  for (const shape of ["name", "path"]) {
    const env = makeHome(t, `registry-race-${shape}`);
    openDb(env);
    const shared = repo("shared");
    const pairs = shape === "name" ? [[repo("one"), "api"], [repo("two"), "api"]] : [[shared, "api-a"], [shared, "api-b"]];
    const startAt = String(Date.now() + 400);
    const results = await Promise.all(pairs.map(([path, name]) => spawnRegistrar(env, script, [path, name, startAt])));
    const created = results.filter((result) => result.status === "created");
    const other = results.find((result) => result.status !== "created");
    assert.equal(created.length, 1, `${shape}: ${JSON.stringify(results)}`);
    if (other.error !== null) assert.match(other.error, /already (taken|registered)/, shape);
    else assert.equal(other.status, "unchanged", `${shape}: the same path in the same org is a no-op, never a second row`);
    assert.equal(registry.listProjects(openDb(env)).length, 1, `${shape}: a refused registration still wrote a row`);
  }
});
