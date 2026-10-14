import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { configPath, runsDir, secretsPath } from "../../src/config/paths.mjs";
import { loadConfig, saveConfig, saveSecrets } from "../../src/config/store.mjs";
import { actsOnOrigin } from "../../src/integrations/registry.mjs";
import { openDb } from "../../src/memory/db.mjs";
import { saveDecision } from "../../src/memory/decisions.mjs";
import { addJob, claimJobById } from "../../src/memory/jobs.mjs";
import { saveLesson } from "../../src/memory/lessons.mjs";
import { jobRef } from "../../src/memory/refs.mjs";
import { ownerByKey } from "../../src/memory/registry.mjs";
import { openStore } from "../../src/store/open.mjs";
import { initGitRepo } from "../../test-support/git.mjs";
import { ensureProject, makeDir, makeHome, makeOrg, orgIdOf } from "../../test-support/memory.mjs";
import { setIntegrations } from "../../test-support/origin-provider.mjs";
import { send, startStudio, studioCookie } from "../../test-support/studio.mjs";

const CLI = fileURLToPath(new URL("../../bin/nightqueue.mjs", import.meta.url));
const QUIET = { warn: () => {} };
const WEBHOOK = "https://discord.com/api/webhooks/9001/dlwWebhookSecretToken-0123456789";
const LINKED = { discord: { log: { connection: "dlw-log", events: ["closed"] } } };

// A home with a temp HOME holding fixture repositories, and a studio on it.
async function projectsHome(t, name) {
  const env = makeHome(t, name);
  env.HOME = realpathSync(makeDir(t, `${name}-user`));
  await openStore(env).connect();
  const studio = await startStudio(t, env);
  const call = async (method, path, body) => {
    const headers = { cookie: studioCookie(studio.port), origin: studio.origin, "content-type": "application/json" };
    const answer = await send(studio.port, { method, path, headers, body: body === undefined ? null : JSON.stringify(body) });
    let parsed = null;
    try {
      parsed = answer.body ? JSON.parse(answer.body) : null;
    } catch {
      parsed = { text: answer.body };
    }
    return { status: answer.status, body: parsed };
  };
  return { env, call, store: openStore(env), repo: (folder) => initGitRepo(join(env.HOME, folder)) };
}

// Runs the real CLI in its own process on the test's home.
function runCli(env, args) {
  return spawnSync(process.execPath, [CLI, ...args], { env, encoding: "utf8" });
}

// Asserts an answer's status and code, printing the body when they differ.
function assertCode(answer, status, code) {
  assert.deepEqual([answer.status, answer.body?.code], [status, code], JSON.stringify(answer.body));
}

// Binds the Discord connection `dlw-log` to org dlw straight in the files.
function bindDlwLog(env) {
  saveSecrets({ version: 1, connections: { "dlw-log": { type: "discord", url: WEBHOOK } } }, env);
  const config = loadConfig(env, QUIET);
  config.orgConnections = { ...(config.orgConnections ?? {}), [orgIdOf(env, "dlw")]: { discord: ["dlw-log"] } };
  saveConfig(config, env);
}

test("POST registers a repository with the row `nightqueue project add` makes, a worktree registering its main checkout", async (t) => {
  const home = await projectsHome(t, "projects-post");
  const repo = home.repo("api");
  const created = await home.call("POST", "/api/projects", { path: repo, key: "APX" });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const row = created.body.project;
  assert.deepEqual([row.name, row.key, row.path, row.org, row.exists, row.origin, row.integrations, row.runningJob], ["api", "APX", repo, "default", true, null, null, null]);
  assert.deepEqual(row.footprint, []);
  const twin = makeHome(t, "projects-post-twin");
  assert.equal(runCli(twin, ["project", "add", repo, "--key", "APX"]).status, 0);
  const listed = JSON.parse(runCli(twin, ["project", "list", "--json"]).stdout).projects[0];
  const { id: _a, ...fromCli } = listed;
  const { id: _b, origin: _o, integrations: _i, footprint: _f, runningJob: _r, unlinkedByMove: _u, ...fromStudio } = row;
  assert.deepEqual(fromStudio, fromCli);
  const main = home.repo("web");
  const worktree = join(home.env.HOME, "web-wt");
  spawnSync("git", ["-C", main, "worktree", "add", "-q", "--detach", worktree]);
  const fromWorktree = await home.call("POST", "/api/projects", { path: worktree });
  assert.equal(fromWorktree.status, 201, JSON.stringify(fromWorktree.body));
  assert.deepEqual([fromWorktree.body.project.path, fromWorktree.body.registeredFrom], [main, realpathSync(worktree)]);
});

test("POST answers one code per refusal and registers nothing", async (t) => {
  const home = await projectsHome(t, "projects-post-codes");
  const repo = home.repo("api");
  assert.equal((await home.call("POST", "/api/projects", { path: repo, key: "APX" })).status, 201);
  const again = await home.call("POST", "/api/projects", { path: repo });
  assertCode(again, 409, "already-registered");
  assert.equal(again.body.project.name, "api");
  const twin = initGitRepo(join(makeDir(t, "other"), "api"));
  const nameTaken = await home.call("POST", "/api/projects", { path: twin });
  assertCode(nameTaken, 409, "name-taken");
  assert.deepEqual(nameTaken.body.project.path, repo);
  assertCode(await home.call("POST", "/api/projects", { path: twin, name: "api2", key: "APX" }), 409, "key-taken");
  assertCode(await home.call("POST", "/api/projects", { path: twin, name: "api2", key: "1x" }), 422, "key-invalid");
  assertCode(await home.call("POST", "/api/projects", { path: twin, name: "Bad Name" }), 422, "name-invalid");
  assertCode(await home.call("POST", "/api/projects", { path: twin, name: "all" }), 422, "name-invalid");
  assertCode(await home.call("POST", "/api/projects", { path: twin, name: "api2", org: "nope" }), 422, "org-unknown");
  mkdirSync(join(home.env.HOME, "plain"));
  assertCode(await home.call("POST", "/api/projects", { path: join(home.env.HOME, "plain") }), 422, "not-a-git-repo");
  assert.equal((await home.call("POST", "/api/projects", { path: 42 })).status, 400);
  assert.deepEqual((await home.store.projects.list()).map((project) => project.name), ["api"]);
});

test("PATCH applies each step alone; a key change keeps the old key resolving; same values are skipped", async (t) => {
  const home = await projectsHome(t, "projects-patch");
  const id = (await home.call("POST", "/api/projects", { path: home.repo("api"), key: "ALPHA" })).body.project.id;
  const renamed = await home.call("PATCH", `/api/projects/${id}`, { name: "api-v2" });
  assert.deepEqual([renamed.status, renamed.body.applied, renamed.body.project.name], [200, ["name"], "api-v2"]);
  const rekeyed = await home.call("PATCH", `/api/projects/${id}`, { key: "alphb" });
  assert.deepEqual([rekeyed.body.applied, rekeyed.body.project.key, rekeyed.body.project.aliases], [["key"], "ALPHB", ["ALPHA"]]);
  assert.deepEqual((await home.store.projects.keyAliases())[id], ["ALPHA"]);
  assert.equal(ownerByKey(openDb(home.env), "ALPHA")?.projectId, id);
  const same = await home.call("PATCH", `/api/projects/${id}`, { name: "api-v2", key: "ALPHB" });
  assert.deepEqual([same.status, same.body.applied], [200, []]);
  const moved = await home.call("PATCH", `/api/projects/${id}`, { path: home.repo("api-moved") });
  assert.deepEqual([moved.body.applied, moved.body.project.path], [["path"], join(home.env.HOME, "api-moved")]);
  const set = await home.call("PATCH", `/api/projects/${id}`, { integrations: { set: { "sentry.onClosed": "resolvedInNextRelease" } } });
  assert.deepEqual([set.body.applied, set.body.project.integrations], [["integrations"], { sentry: { onClosed: "resolvedInNextRelease" } }]);
  assertCode(await home.call("PATCH", "/api/projects/01J9Z00000000000000000000A", { name: "x" }), 404, "not-found");
  assert.equal((await home.call("PATCH", `/api/projects/${id}`, { color: "red" })).status, 400);
  assert.equal((await home.call("PATCH", `/api/projects/${id}`, { name: 3 })).status, 400);
});

test("an ordered PATCH stops at the refused path step: name and key stay applied, integrations are not", async (t) => {
  const home = await projectsHome(t, "projects-patch-order");
  const id = (await home.call("POST", "/api/projects", { path: home.repo("api"), key: "APX" })).body.project.id;
  const body = { name: "n2", key: "NEWK", path: "/not/a/repo", integrations: { set: { "sentry.onClosed": "resolvedInNextRelease" } } };
  const refused = await home.call("PATCH", `/api/projects/${id}`, body);
  assertCode(refused, 422, "not-a-git-repo");
  assert.deepEqual([refused.body.step, refused.body.applied, refused.body.project.name], ["path", ["name", "key"], "n2"]);
  assert.equal(typeof refused.body.reason, "string");
  const row = await home.store.projects.byId(id);
  assert.deepEqual([row.name, row.key, row.path], ["n2", "NEWK", join(home.env.HOME, "api")]);
  assert.equal(await home.store.projects.integrations(id), null);
  const invalid = await home.call("PATCH", `/api/projects/${id}`, { integrations: { set: { "sentry.onClosed": "bogus" } } });
  assertCode(invalid, 422, "integration-invalid");
  assert.equal(invalid.body.step, "integrations");
  assert.equal(await home.store.projects.integrations(id), null);
  const other = (await home.call("POST", "/api/projects", { path: home.repo("web") })).body.project;
  assertCode(await home.call("PATCH", `/api/projects/${id}`, { name: "web" }), 409, "name-taken");
  assertCode(await home.call("PATCH", `/api/projects/${id}`, { path: other.path }), 409, "already-registered");
  assertCode(await home.call("PATCH", `/api/projects/${id}`, { key: other.key }), 409, "key-taken");
  assertCode(await home.call("PATCH", `/api/projects/${id}`, { org: "nope" }), 422, "org-unknown");
});

test("PATCH sets then unsets the only sentry setting: the integration is acted on, then stored as null and no longer acted on", async (t) => {
  const home = await projectsHome(t, "projects-patch-unset");
  const id = (await home.call("POST", "/api/projects", { path: home.repo("api"), key: "UNS" })).body.project.id;
  assert.equal(await home.store.projects.integrations(id), null);
  const set = await home.call("PATCH", `/api/projects/${id}`, { integrations: { set: { "sentry.onClosed": "resolved" } } });
  assert.equal(set.status, 200);
  assert.equal(actsOnOrigin("sentry", await home.store.projects.integrations(id)), true);
  const unset = await home.call("PATCH", `/api/projects/${id}`, { integrations: { unset: ["sentry.onClosed"] } });
  assert.equal(unset.status, 200);
  assert.equal(unset.body.project.integrations, null);
  assert.equal(await home.store.projects.integrations(id), null);
  assert.equal(actsOnOrigin("sentry", await home.store.projects.integrations(id)), false);
});

test("a move to an org that does not use the destination is previewed in GET and unlinks it on PATCH", async (t) => {
  const home = await projectsHome(t, "projects-move");
  const id = ensureProject(home.env, "a1", { org: "dlw" });
  makeOrg(home.env, "clareza");
  bindDlwLog(home.env);
  setIntegrations(home.env, id, LINKED);
  const clareza = orgIdOf(home.env, "clareza");
  const listed = await home.call("GET", "/api/projects");
  const row = listed.body.projects.find((project) => project.id === id);
  assert.deepEqual(row.unlinkedByMove[clareza], ["discord.log.connection"]);
  assert.deepEqual(row.integrations, LINKED);
  assert.ok(listed.body.providers.some((provider) => provider.kind === "discord"));
  const moved = await home.call("PATCH", `/api/projects/${id}`, { org: "clareza" });
  assert.deepEqual([moved.status, moved.body.applied, moved.body.unlinked, moved.body.project.org], [200, ["org"], ["discord.log.connection"], "clareza"]);
  assert.equal(await home.store.projects.integrations(id), null);
  const back = await home.call("PATCH", `/api/projects/${id}`, { org: orgIdOf(home.env, "dlw") });
  assert.deepEqual([back.body.applied, back.body.unlinked], [["org"], []]);
});

test("an unreadable config.json or secrets.json refuses a move before writing and previews no loss", async (t) => {
  const home = await projectsHome(t, "projects-move-unreadable");
  const id = ensureProject(home.env, "a1", { org: "dlw" });
  makeOrg(home.env, "clareza");
  bindDlwLog(home.env);
  const config = loadConfig(home.env, QUIET);
  config.orgConnections[orgIdOf(home.env, "clareza")] = { discord: ["dlw-log"] };
  saveConfig(config, home.env);
  setIntegrations(home.env, id, LINKED);
  writeFileSync(secretsPath(home.env), "{ not json");
  const refused = await home.call("PATCH", `/api/projects/${id}`, { org: "clareza" });
  assertCode(refused, 409, "refused");
  assert.deepEqual([refused.body.step, refused.body.applied], ["org", []]);
  assert.deepEqual([(await home.store.projects.byId(id)).org_id, await home.store.projects.integrations(id)], [orgIdOf(home.env, "dlw"), LINKED]);
  writeFileSync(configPath(home.env), "{ not json");
  const row = (await home.call("GET", "/api/projects")).body.projects.find((project) => project.id === id);
  assert.deepEqual(row.unlinkedByMove, {});
  assertCode(await home.call("PATCH", `/api/projects/${id}`, { org: "clareza" }), 409, "refused");
  assert.deepEqual(await home.store.projects.integrations(id), LINKED);
});

test("PATCH with an empty or blank path is refused and the checkout is unchanged, even when HOME is a repository", async (t) => {
  const home = await projectsHome(t, "projects-patch-empty-path");
  initGitRepo(home.env.HOME);
  const repo = home.repo("api");
  const id = (await home.call("POST", "/api/projects", { path: repo })).body.project.id;
  for (const path of ["", "   "]) {
    const refused = await home.call("PATCH", `/api/projects/${id}`, { path });
    assertCode(refused, 422, "not-a-git-repo");
    assert.equal(refused.body.step, "path");
    assert.equal((await home.store.projects.byId(id)).path, repo);
  }
});

test("DELETE refuses a project with rows or a running job, purges exactly its footprint and run dir, and removes an empty one", async (t) => {
  const home = await projectsHome(t, "projects-delete");
  const doomed = ensureProject(home.env, "doomed");
  const kept = ensureProject(home.env, "kept");
  for (const projectId of [doomed, kept]) {
    addJob({ projectId, prompt: "fix it" }, home.env);
    saveDecision({ projectId, title: "a rule", context: "c", decision: "d", status: "accepted" }, home.env);
    saveLesson({ projectId, title: "a lesson", root_cause: "r", solution: "s", prevention: "p" }, home.env);
  }
  mkdirSync(join(runsDir(home.env), doomed, "slug"), { recursive: true });
  const footprint = await home.store.projects.footprint(doomed);
  const keptBefore = await home.store.projects.footprint(kept);
  const owns = await home.call("DELETE", `/api/projects/${doomed}`);
  assertCode(owns, 409, "owns-rows");
  assert.deepEqual(owns.body.footprint, footprint);
  const purged = await home.call("DELETE", `/api/projects/${doomed}?purge=1`);
  assert.equal(purged.status, 200, JSON.stringify(purged.body));
  assert.deepEqual([purged.body.removed.name, purged.body.purged], ["doomed", footprint]);
  assert.equal(await home.store.projects.byId(doomed), null);
  assert.equal(existsSync(join(runsDir(home.env), doomed)), false);
  assert.deepEqual(await home.store.projects.footprint(kept), keptBefore);
  const busy = ensureProject(home.env, "busy");
  const job = addJob({ projectId: busy, prompt: "work" }, home.env);
  claimJobById(job.id, { worker: "host:1", cap: null }, home.env);
  const listed = (await home.call("GET", "/api/projects")).body.projects.find((project) => project.id === busy);
  assert.deepEqual(listed.runningJob, { ref: jobRef(job.id) });
  const running = await home.call("DELETE", `/api/projects/${busy}?purge=1`);
  assertCode(running, 409, "job-running");
  assert.equal(running.body.ref, jobRef(job.id));
  const empty = ensureProject(home.env, "empty");
  const removed = await home.call("DELETE", `/api/projects/${empty}`);
  assert.deepEqual([removed.status, removed.body.purged], [200, []]);
  assertCode(await home.call("DELETE", `/api/projects/${empty}`), 404, "not-found");
});

test("orgs are listed, created, renamed, re-keyed, made default and removed, each refusal with its code", async (t) => {
  const home = await projectsHome(t, "projects-orgs");
  const listed = await home.call("GET", "/api/orgs");
  assert.deepEqual(listed.body.orgs.map((org) => [org.name, org.isDefault]), [["default", true]]);
  const created = await home.call("POST", "/api/orgs", { name: "acme" });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const acme = created.body.org;
  assert.deepEqual([acme.name, acme.isDefault, acme.projects], ["acme", false, 0]);
  assertCode(await home.call("POST", "/api/orgs", { name: "acme" }), 409, "name-taken");
  assertCode(await home.call("POST", "/api/orgs", { name: "Bad" }), 422, "name-invalid");
  assertCode(await home.call("POST", "/api/orgs", { name: "x1", key: "1" }), 422, "key-invalid");
  assertCode(await home.call("POST", "/api/orgs", { name: "x2", key: acme.key }), 409, "key-taken");
  const patched = await home.call("PATCH", `/api/orgs/${acme.id}`, { name: "acme2", key: "ACMZ" });
  assert.deepEqual([patched.body.applied, patched.body.org.name, patched.body.org.key, patched.body.org.aliases], [["name", "key"], "acme2", "ACMZ", [acme.key]]);
  assertCode(await home.call("PATCH", `/api/orgs/${acme.id}`, { name: "default" }), 409, "name-taken");
  const refused = await home.call("PATCH", `/api/orgs/${acme.id}`, { key: "ACMQ", name: "Bad" });
  assert.deepEqual([refused.body.code, refused.body.step, refused.body.applied], ["name-invalid", "name", []]);
  assert.equal((await home.call("PATCH", `/api/orgs/${acme.id}`, { isDefault: false })).status, 400);
  const made = await home.call("PATCH", `/api/orgs/${acme.id}`, { isDefault: true });
  assert.deepEqual([made.body.applied, made.body.org.isDefault], [["isDefault"], true]);
  assert.equal(loadConfig(home.env, QUIET).defaultOrg, acme.id);
  assertCode(await home.call("DELETE", `/api/orgs/${acme.id}`), 409, "is-default");
  ensureProject(home.env, "p1", { org: "busy" });
  const owning = await home.call("DELETE", `/api/orgs/${orgIdOf(home.env, "busy")}`);
  assertCode(owning, 409, "owns-projects");
  assert.deepEqual(owning.body.projects.map((project) => project.name), ["p1"]);
  const defaultId = orgIdOf(home.env, "default");
  assert.deepEqual((await home.call("DELETE", `/api/orgs/${defaultId}`)).body.removed.name, "default");
  assertCode(await home.call("DELETE", `/api/orgs/${defaultId}`), 404, "not-found");
});

test("the CLI and the Set-as-default PATCH write the same config.json defaultOrg", async (t) => {
  const home = await projectsHome(t, "projects-default");
  makeOrg(home.env, "acme");
  const acmeId = orgIdOf(home.env, "acme");
  assert.equal(runCli(home.env, ["org", "default", "acme"]).status, 0);
  const fromCli = loadConfig(home.env, QUIET).defaultOrg;
  assert.equal(runCli(home.env, ["org", "default", "default"]).status, 0);
  assert.equal((await home.call("PATCH", `/api/orgs/${acmeId}`, { isDefault: true })).status, 200);
  assert.deepEqual([fromCli, loadConfig(home.env, QUIET).defaultOrg], [acmeId, acmeId]);
});

test("the read helpers answer the folders of HOME, a repository's facts and a key suggestion", async (t) => {
  const home = await projectsHome(t, "projects-helpers");
  const repo = home.repo("api");
  const dirs = await home.call("GET", "/api/fs/dirs");
  assert.deepEqual([dirs.status, dirs.body.path, dirs.body.entries.map((entry) => [entry.name, entry.git])], [200, home.env.HOME, [["api", true]]]);
  assertCode(await home.call("GET", "/api/fs/dirs?path=%2F"), 403, "outside-home");
  const facts = await home.call("GET", `/api/fs/repo?path=${encodeURIComponent(repo)}`);
  assert.deepEqual([facts.body.mainCheckout, facts.body.suggested.name, typeof facts.body.suggested.key], [repo, "api", "string"]);
  const key = await home.call("GET", "/api/keys/suggest?kind=org&name=acme");
  assert.deepEqual([key.status, typeof key.body.key], [200, "string"]);
  assert.equal((await home.call("GET", "/api/keys/suggest?kind=job&name=x")).status, 400);
});

test("inside a job every write is refused before anything is written, and the reads still answer", async (t) => {
  const env = makeHome(t, "projects-job");
  const id = ensureProject(env, "a1");
  const jobEnv = { ...env, HOME: realpathSync(makeDir(t, "projects-job-user")), NIGHTQUEUE_JOB_ID: "7", NIGHTQUEUE_JOB_HOME: env.NIGHTQUEUE_HOME };
  const studio = await startStudio(t, jobEnv);
  const headers = { cookie: studioCookie(studio.port), origin: studio.origin, "content-type": "application/json" };
  const orgId = orgIdOf(env, "default");
  const writes = [
    ["POST", "/api/projects", { path: "/tmp" }],
    ["PATCH", `/api/projects/${id}`, { name: "x" }],
    ["DELETE", `/api/projects/${id}`, undefined],
    ["POST", "/api/orgs", { name: "acme" }],
    ["PATCH", `/api/orgs/${orgId}`, { isDefault: true }],
    ["DELETE", `/api/orgs/${orgId}`, undefined],
  ];
  for (const [method, path, body] of writes) {
    const answer = await send(studio.port, { method, path, headers, body: body === undefined ? null : JSON.stringify(body) });
    assert.equal(answer.status, 400, `${method} ${path} answered ${answer.status}: ${answer.body}`);
    assert.match(answer.body, /refused: /);
  }
  assert.equal(existsSync(configPath(env)), false);
  for (const path of ["/api/projects", "/api/orgs"]) assert.equal((await send(studio.port, { path, headers })).status, 200);
});
