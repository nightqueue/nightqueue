import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { UserError } from "../src/config/errors.mjs";
import { addOrg } from "../src/config/orgs.mjs";
import {
  addProject,
  listProjects,
  moveProject,
  normalizePath,
  orgOf,
  projectByName,
  removeProject,
  repoSlugOf,
  resolveProject,
  slugFromRemote,
} from "../src/config/projects.mjs";
import { emptyConfig } from "../src/config/schema.mjs";

// Creates a temporary directory removed at the end of the test.
function makeDir(t, name) {
  const dir = mkdtempSync(join(tmpdir(), `nightshift-${name}-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// Creates a real git repository, without network or commits.
function makeRepo(t, name) {
  const dir = makeDir(t, name);
  execFileSync("git", ["init", "-q", dir]);
  return dir;
}

test("addProject registers the repository in the default org", (t) => {
  const repo = makeRepo(t, "api");
  const { config, status, project } = addProject(emptyConfig(), { path: repo, name: "api" });
  assert.equal(status, "created");
  assert.deepEqual(project, { name: "api", path: normalizePath(repo), org: "default" });
  assert.deepEqual(config.projects.api, { path: normalizePath(repo), org: "default" });
  assert.deepEqual(projectByName(config, "api"), project);
  assert.equal(orgOf(projectByName(config, "api")), "default");
  assert.equal(orgOf(projectByName(config, "nope")), null);
});

test("addProject derives a usable name from an awkward basename", (t) => {
  const base = makeDir(t, "base");
  const repo = join(base, "feat+config-org-based");
  mkdirSync(join(repo, ".git"), { recursive: true });
  const { project } = addProject(emptyConfig(), { path: repo });
  assert.equal(project.name, "feat-config-org-based");
});

test("addProject accepts a linked worktree, where .git is a file", (t) => {
  const repo = makeDir(t, "linked");
  writeFileSync(join(repo, ".git"), "gitdir: /elsewhere/.git/worktrees/x\n");
  const { status } = addProject(emptyConfig(), { path: repo, name: "linked" });
  assert.equal(status, "created");
});

test("addProject refuses a missing path and a directory without .git", (t) => {
  const plain = makeDir(t, "plain");
  assert.throws(() => addProject(emptyConfig(), { path: join(plain, "nope") }), (err) => {
    assert.ok(err instanceof UserError);
    assert.match(err.message, /path does not exist/);
    return true;
  });
  assert.throws(() => addProject(emptyConfig(), { path: plain, name: "plain" }), (err) => {
    assert.match(err.message, /not a git repository \(no \.git\)/);
    return true;
  });
});

test("a name already used by another path is refused citing that path", (t) => {
  const first = makeRepo(t, "first");
  const second = makeRepo(t, "second");
  const { config } = addProject(emptyConfig(), { path: first, name: "api" });
  assert.throws(() => addProject(config, { path: second, name: "api" }), (err) => {
    assert.equal(err.message, `project name \`api\` is already registered for ${normalizePath(first)}`);
    return true;
  });
});

test("the same path is a no-op in the same org and an error in another org", (t) => {
  const repo = makeRepo(t, "same");
  const config = addOrg(emptyConfig(), "acme");
  addProject(config, { path: repo, name: "api" });
  assert.equal(addProject(config, { path: repo, name: "api" }).status, "unchanged");
  assert.throws(() => addProject(config, { path: repo, name: "api", org: "acme" }), (err) => {
    assert.match(err.message, /is already registered as `api` in org `default`; use `shift project move api acme`/);
    return true;
  });
});

test("an unknown --org is refused and no org is created", (t) => {
  const repo = makeRepo(t, "org");
  const config = emptyConfig();
  assert.throws(() => addProject(config, { path: repo, name: "api", org: "ghost" }), (err) => {
    assert.match(err.message, /unknown org `ghost`; existing orgs: default/);
    return true;
  });
  assert.deepEqual(Object.keys(config.orgs), ["default"]);
  assert.deepEqual(Object.keys(config.projects), []);
});

test("listProjects reports whether the path still exists", (t) => {
  const repo = makeRepo(t, "list");
  const { config } = addProject(emptyConfig(), { path: repo, name: "api" });
  config.projects.gone = { path: join(repo, "gone"), org: "default" };
  assert.deepEqual(listProjects(config), [
    { name: "api", path: normalizePath(repo), org: "default", exists: true },
    { name: "gone", path: join(repo, "gone"), org: "default", exists: false },
  ]);
});

test("removeProject and moveProject validate their target", (t) => {
  const repo = makeRepo(t, "move");
  const config = addOrg(emptyConfig(), "acme");
  addProject(config, { path: repo, name: "api" });
  assert.throws(() => moveProject(config, "api", "ghost"), UserError);
  assert.equal(moveProject(config, "api", "acme").status, "moved");
  assert.equal(config.projects.api.org, "acme");
  assert.equal(moveProject(config, "api", "acme").status, "unchanged");
  assert.throws(() => removeProject(config, "nope"), UserError);
  removeProject(config, "api");
  assert.deepEqual(Object.keys(config.projects), []);
});

test("resolveProject picks the longest registered prefix", (t) => {
  const base = makeRepo(t, "outer");
  const inner = join(base, "packages", "inner");
  mkdirSync(join(inner, ".git"), { recursive: true });
  const sibling = join(base, "packages", "innerish");
  mkdirSync(join(sibling, ".git"), { recursive: true });
  mkdirSync(join(inner, "src"), { recursive: true });
  const config = emptyConfig();
  addProject(config, { path: base, name: "outer" });
  addProject(config, { path: inner, name: "inner" });
  assert.equal(resolveProject(config, { cwd: join(inner, "src") }).name, "inner");
  assert.equal(resolveProject(config, { cwd: base }).name, "outer");
  assert.equal(resolveProject(config, { cwd: sibling }).name, "outer");
  assert.equal(resolveProject(config, { cwd: tmpdir() }), null);
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
