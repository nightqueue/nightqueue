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
import { getDecision, listDecisions, saveDecision } from "../../src/memory/decisions.mjs";
import { addJob, claimJobById, finishJob, getJob } from "../../src/memory/jobs.mjs";
import * as registry from "../../src/memory/registry.mjs";
import { makeHostEnv } from "../../test-support/host.mjs";
import { makeDir, makeHome, makeOrg, makeProject, orgIdOf, projectIdOf } from "../../test-support/memory.mjs";

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

// How many rows the connection changed while the action ran.
function changesOf(db, action) {
  const before = db.prepare("SELECT total_changes() AS n").get().n;
  action();
  return db.prepare("SELECT total_changes() AS n").get().n - before;
}

test("an org rename and a project rename each change exactly one row, and every view reads the new name at once", (t) => {
  const env = makeHome(t, "registry-rename-one-row");
  makeProject(t, env, "alpha", { org: "acme" });
  const orgDecision = saveDecision({ orgId: orgIdOf(env, "acme"), title: "one queue per product", context: "c", decision: "d" }, env);
  const own = saveDecision({ projectId: projectIdOf(env, "alpha"), title: "the api owns its cache", context: "c", decision: "d" }, env);
  const job = addJob({ projectId: projectIdOf(env, "alpha"), prompt: "keep running" }, env);
  assert.ok(claimJobById(job.id, { worker: "w1", cap: null }, env), "setup: the job was not claimed");
  const db = openDb(env);
  const acme = registry.orgByName(db, "acme");
  const alpha = registry.projectByName(db, "alpha");

  assert.equal(changesOf(db, () => registry.renameOrg(db, { id: acme.id, name: "acme-inc" })), 1);
  assert.equal(changesOf(db, () => registry.renameProject(db, { id: alpha.id, name: "api" })), 1);
  assert.equal(getDecision(orgDecision.id, env).org, "acme-inc");
  assert.equal(getDecision(own.id, env).project, "api");
  assert.deepEqual(listDecisions({ projectId: alpha.id }, env).map((row) => [row.id, row.org ?? row.project]), [
    [orgDecision.id, "acme-inc"],
    [own.id, "api"],
  ]);
  assert.equal(getJob(job.id, env).project, "api", "the job view kept the old name");
  assert.equal(getJob(job.id, env).project_id, alpha.id, "the rename moved the running job to another owner");
  assert.ok(finishJob(job.id, { worker: "w1", status: "failed" }, env), "the running job could not finish after the rename");
  assert.equal(getJob(job.id, env).project_id, alpha.id);

  registry.insertProject(db, { name: "beta", path: null, orgId: acme.id });
  assert.throws(() => registry.renameProject(db, { id: alpha.id, name: "beta" }), /project name `beta` is already taken/);
  assert.throws(() => registry.renameOrg(db, { id: acme.id, name: "default" }), /org `default` already exists/);
});

test("a row naming an unknown project or org id is refused by the foreign key", (t) => {
  const env = makeHome(t, "registry-foreign-keys");
  const db = openDb(env);
  const ghost = "0".repeat(26);
  assert.throws(() => db.prepare("INSERT INTO decisions (scope, project_id, number, title, context, decision) VALUES ('project', ?, 1, 't', 'c', 'd')").run(ghost), /FOREIGN KEY/);
  assert.throws(() => db.prepare("INSERT INTO decisions (scope, org_id, number, title, context, decision) VALUES ('org', ?, 1, 't', 'c', 'd')").run(ghost), /FOREIGN KEY/);
  assert.throws(() => db.prepare("INSERT INTO roadmap_items (scope, org_id, number, title, position) VALUES ('org', ?, 1, 't', 1)").run(ghost), /FOREIGN KEY/);
  assert.throws(() => db.prepare("INSERT INTO roadmap_item_projects (item_id, project_id) VALUES (1, ?)").run(ghost), /FOREIGN KEY/);
  assert.throws(() => db.prepare("INSERT INTO roadmap_comments (item_id, kind, author, body, project_id) VALUES (1, 'note', 'operator', 'b', ?)").run(ghost), /FOREIGN KEY/);
  assert.throws(() => db.prepare("INSERT INTO lessons (project_id, title, root_cause, solution, prevention) VALUES (?, 't', 'r', 's', 'p')").run(ghost), /FOREIGN KEY/);
  assert.throws(
    () => db.prepare("INSERT INTO decisions (scope, project_id, org_id, number, title, context, decision) VALUES ('project', NULL, ?, 1, 't', 'c', 'd')").run(registry.earliestOrg(db).id),
    /CHECK constraint failed/,
  );
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

test("a project or an org that still owns rows is refused a removal by the foreign keys, listing what it owns", (t) => {
  const env = makeHome(t, "registry-owned");
  makeProject(t, env, "alpha");
  saveDecision({ projectId: projectIdOf(env, "alpha"), title: "t", context: "c", decision: "d" }, env);
  addJob({ projectId: projectIdOf(env, "alpha"), prompt: "p" }, env);
  makeOrg(env, "acme");
  saveDecision({ orgId: orgIdOf(env, "acme"), title: "t", context: "c", decision: "d" }, env);
  const db = openDb(env);
  const alpha = registry.projectByName(db, "alpha");
  const acme = registry.orgByName(db, "acme");
  assert.deepEqual(registry.ownedRowCounts(db, { projectId: alpha.id }), [
    { table: "jobs", total: 1 },
    { table: "decisions", total: 1 },
  ]);
  assert.throws(() => registry.removeProject(db, alpha.id), /cannot remove project `alpha`: it still owns 1 jobs, 1 decisions; nothing was removed/);
  assert.equal(registry.projectById(db, alpha.id).name, "alpha");
  assert.throws(() => registry.removeOrg(db, acme.id), /cannot remove org `acme`: it still owns 1 decisions; nothing was removed/);
  assert.equal(registry.orgById(db, acme.id).name, "acme");

  const removed = runCli(env, ["project", "remove", "alpha"]);
  assert.notEqual(removed.status, 0);
  assert.match(removed.stderr, /cannot remove project `alpha`: it still owns 1 jobs, 1 decisions; use --purge .*nothing was removed/);
  makeProject(t, env, "empty");
  assert.equal(runCli(env, ["project", "remove", "empty"]).status, 0);
  assert.equal(registry.projectByName(openDb(env), "empty"), null);
});

test("`project rename` renames the one registry row and refuses an unknown, a taken or an invalid name", (t) => {
  const env = makeHome(t, "registry-cli-rename");
  makeProject(t, env, "alpha");
  makeProject(t, env, "beta");
  const id = projectIdOf(env, "alpha");
  const renamed = runCli(env, ["project", "rename", "alpha", "api"]);
  assert.equal(renamed.status, 0, renamed.stderr);
  assert.equal(renamed.stdout.trim(), "renamed project `alpha` to `api`");
  assert.equal(projectIdOf(env, "api"), id);
  assert.match(runCli(env, ["project", "rename", "ghost", "x"]).stderr, /unknown project `ghost`; known projects: api, beta/);
  assert.match(runCli(env, ["project", "rename", "api", "beta"]).stderr, /project name `beta` is already taken/);
  assert.match(runCli(env, ["project", "rename", "api", "all"]).stderr, /`all` is reserved/);
  assert.notEqual(runCli(env, ["project", "rename", "api", "Bad Name!"]).status, 0);
  assert.equal(projectIdOf(env, "api"), id);
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
  assert.equal(listed.stdout.trim(), "legacy  LA  (no path)  default");
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
