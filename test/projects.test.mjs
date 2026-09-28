import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { UserError } from "../src/config/errors.mjs";
import { addOrg } from "../src/config/orgs.mjs";
import {
  normalizePath,
  projectContaining,
  registerProject,
  repoSlugOf,
  requireProject,
  resolveProjectRef,
  slugFromRemote,
  suggestName,
} from "../src/config/projects.mjs";
import { emptyConfig } from "../src/config/schema.mjs";
import { openStore } from "../src/store/open.mjs";
import { ensureProject, makeDir, makeHome } from "../test-support/memory.mjs";

// Creates a real git repository, without network or commits.
function makeRepo(t, name) {
  const dir = makeDir(t, name);
  execFileSync("git", ["init", "-q", dir]);
  return dir;
}

// The store of a fresh home, the registry every registration below lands in.
function freshStore(t) {
  const env = makeHome(t, "projects");
  return { env, store: openStore(env) };
}

// Registers a repository through the edge helper, with an empty config.
function register(store, spec) {
  return registerProject(store, emptyConfig(), spec);
}

test("registerProject registers the repository in the default org", async (t) => {
  const { store } = freshStore(t);
  const repo = makeRepo(t, "api");
  const { status, project } = await register(store, { path: repo, name: "api" });
  assert.equal(status, "created");
  assert.equal(project.name, "api");
  assert.equal(project.path, normalizePath(repo));
  assert.equal(project.org, "default");
  assert.equal((await store.projects.byName("api")).id, project.id);
  assert.equal(await store.projects.byName("nope"), null);
});

test("registerProject derives a usable name from an awkward basename", async (t) => {
  const { store } = freshStore(t);
  const base = makeDir(t, "base");
  const repo = join(base, "feat+config-org-based");
  mkdirSync(join(repo, ".git"), { recursive: true });
  const { project } = await register(store, { path: repo });
  assert.equal(project.name, "feat-config-org-based");
});

test("registerProject accepts a linked worktree, where .git is a file", async (t) => {
  const { store } = freshStore(t);
  const repo = makeDir(t, "linked");
  writeFileSync(join(repo, ".git"), "gitdir: /elsewhere/.git/worktrees/x\n");
  const { status } = await register(store, { path: repo, name: "linked" });
  assert.equal(status, "created");
});

test("registerProject refuses a missing path and a directory without .git", async (t) => {
  const { store } = freshStore(t);
  const plain = makeDir(t, "plain");
  await assert.rejects(register(store, { path: join(plain, "nope") }), (err) => {
    assert.ok(err instanceof UserError);
    assert.match(err.message, /path does not exist/);
    return true;
  });
  await assert.rejects(register(store, { path: plain, name: "plain" }), (err) => {
    assert.match(err.message, /not a git repository \(no \.git\)/);
    return true;
  });
});

test("a name already used by another path is refused citing that path", async (t) => {
  const { store } = freshStore(t);
  const first = makeRepo(t, "first");
  const second = makeRepo(t, "second");
  await register(store, { path: first, name: "api" });
  await assert.rejects(register(store, { path: second, name: "api" }), (err) => {
    assert.equal(err.message, `project name \`api\` is already registered for ${normalizePath(first)}`);
    return true;
  });
});

test("a name held by a project known only from history points at `project move --path`", async (t) => {
  const { env, store } = freshStore(t);
  ensureProject(env, "legacy");
  const repo = makeRepo(t, "legacy");
  await assert.rejects(register(store, { path: repo, name: "legacy" }), (err) => {
    assert.match(err.message, /`nightqueue project move legacy --path /);
    return true;
  });
});

test("`all` is reserved for the org target: refused by name and never derived nor suggested", async (t) => {
  const { store } = freshStore(t);
  const named = makeRepo(t, "named");
  await assert.rejects(register(store, { path: named, name: "all" }), (err) => {
    assert.ok(err instanceof UserError);
    assert.match(err.message, /project name `all` is reserved: it targets every project of an org/);
    return true;
  });
  const repo = join(makeDir(t, "reserved"), "all");
  mkdirSync(join(repo, ".git"), { recursive: true });
  await assert.rejects(register(store, { path: repo }), /project name `all` is reserved/);
  assert.equal(suggestName([], repo), "all-2");
  assert.equal(suggestName(["all-2"], repo), "all-3");
});

test("the same path is a no-op in the same org and an error in another org", async (t) => {
  const { store } = freshStore(t);
  const repo = makeRepo(t, "same");
  await addOrg(store, "acme");
  await register(store, { path: repo, name: "api" });
  assert.equal((await register(store, { path: repo, name: "api" })).status, "unchanged");
  await assert.rejects(register(store, { path: repo, name: "api", org: "acme" }), (err) => {
    assert.match(err.message, /is already registered as `api` in org `default`; use `nightqueue project move api acme`/);
    return true;
  });
});

test("an unknown --org is refused and no org nor project is created", async (t) => {
  const { store } = freshStore(t);
  const repo = makeRepo(t, "org");
  await assert.rejects(register(store, { path: repo, name: "api", org: "ghost" }), (err) => {
    assert.match(err.message, /unknown org `ghost`; existing orgs: default/);
    return true;
  });
  assert.deepEqual((await store.orgs.list()).map((org) => org.name), ["default"]);
  assert.deepEqual(await store.projects.list(), []);
});

test("requireProject and resolveProjectRef refuse an unknown name, naming the known projects; a path outside every checkout is global", async (t) => {
  const { store } = freshStore(t);
  const repo = makeRepo(t, "ref");
  mkdirSync(join(repo, "src"));
  await register(store, { path: repo, name: "api" });
  await assert.rejects(requireProject(store, "ghost"), /unknown project `ghost`; known projects: api/);
  await assert.rejects(resolveProjectRef(store, "ghost"), /unknown project `ghost`; known projects: api/);
  assert.equal((await resolveProjectRef(store, "api")).name, "api");
  assert.equal((await resolveProjectRef(store, join(repo, "src"))).name, "api");
  assert.equal(await resolveProjectRef(store, tmpdir()), null);
  assert.equal(await resolveProjectRef(store, ""), null);
});

test("moving and removing a project go through the registry", async (t) => {
  const { store } = freshStore(t);
  const repo = makeRepo(t, "move");
  const acme = await addOrg(store, "acme");
  const { project } = await register(store, { path: repo, name: "api" });
  const moved = await store.projects.move(project.id, { orgId: acme.id });
  assert.equal(moved.org, "acme");
  assert.equal(moved.path, project.path);
  await store.projects.remove(project.id);
  assert.deepEqual(await store.projects.list(), []);
});

test("projectContaining picks the longest registered prefix and skips path-less projects", (t) => {
  const base = makeRepo(t, "outer");
  const inner = join(base, "packages", "inner");
  mkdirSync(join(inner, ".git"), { recursive: true });
  const sibling = join(base, "packages", "innerish");
  mkdirSync(join(sibling, ".git"), { recursive: true });
  mkdirSync(join(inner, "src"), { recursive: true });
  const projects = [
    { name: "outer", path: base },
    { name: "inner", path: inner },
    { name: "history", path: null },
  ];
  assert.equal(projectContaining(projects, join(inner, "src")).name, "inner");
  assert.equal(projectContaining(projects, base).name, "outer");
  assert.equal(projectContaining(projects, sibling).name, "outer");
  assert.equal(projectContaining(projects, tmpdir()), null);
});

test("slugFromRemote covers https, ssh and trailing .git", () => {
  assert.equal(slugFromRemote("https://github.com/Owner/Repo.git"), "owner/repo");
  assert.equal(slugFromRemote("https://github.com/owner/repo"), "owner/repo");
  assert.equal(slugFromRemote("https://github.com/owner/repo/"), "owner/repo");
  assert.equal(slugFromRemote("git@github.com:owner/repo.git"), "owner/repo");
  assert.equal(slugFromRemote("ssh://git@github.com/owner/repo.git"), "owner/repo");
  assert.equal(slugFromRemote("https://user:pass@github.com/owner/repo.git"), "owner/repo");
  assert.equal(slugFromRemote("/local/path/repo"), null);
  assert.equal(slugFromRemote("https://github.com/owner/repo/extra"), null);
  assert.equal(slugFromRemote(""), null);
  assert.equal(slugFromRemote(null), null);
});

test("repoSlugOf reads the origin remote and tolerates its absence", (t) => {
  const repo = makeRepo(t, "slug");
  const project = { name: "api", path: repo, org: "default" };
  assert.equal(repoSlugOf(project), null);
  execFileSync("git", ["-C", repo, "remote", "add", "origin", "https://github.com/Owner/Repo.git"]);
  assert.equal(repoSlugOf(project), "owner/repo");
  assert.equal(repoSlugOf({ path: makeDir(t, "notgit") }), null);
  assert.equal(repoSlugOf(project, { gitRemoteImpl: () => { throw new Error("no git"); } }), null);
  assert.equal(repoSlugOf(null), null);
});
