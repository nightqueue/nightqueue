import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough, Readable } from "node:stream";
import { test } from "node:test";
import { runsDir } from "../src/config/paths.mjs";
import { defaultContext, run } from "../src/cli/index.mjs";
import { openDb } from "../src/memory/db.mjs";
import { DATA_TABLES } from "../src/memory/ddl.mjs";
import { ensureProject, makeHome, makeOrg, orgIdOf } from "../test-support/memory.mjs";

// Terminal double answering the first question with the given line, or no terminal at all when the answer is null.
function terminal(answer) {
  if (answer === null) return { stdin: { isTTY: false }, stdout: new PassThrough() };
  const stdin = Readable.from([answer]);
  stdin.isTTY = true;
  return { stdin, stdout: new PassThrough() };
}

// Runs one CLI command against a home and answers its exit code, output lines and error text.
async function cli(env, argv, { answer = null } = {}) {
  const out = [];
  const err = [];
  const tty = terminal(answer);
  const ctx = { ...defaultContext(), env, out: (line) => out.push(line), err: (line) => err.push(line), stdin: tty.stdin, stdout: tty.stdout };
  const code = await run(argv, ctx);
  return { code, out, err: err.join("\n") };
}

// Gives a project one row in every table that owns rows by project id, plus the links that reach it from outside, all tagged with `tag`.
function seedProject(db, { id, orgId, tag, jobStatus = "cancelled", orgComment = true }) {
  const job = db.prepare("INSERT INTO jobs (project_id, prompt, status) VALUES (?, ?, ?) RETURNING id").get(id, `${tag} job`, jobStatus).id;
  db.prepare("INSERT INTO lessons (project_id, title, root_cause, solution, prevention) VALUES (?, ?, 'rc', 'sol', 'prev')").run(id, `${tag}lesson`);
  db.prepare("INSERT INTO memory (project_id, key, value) VALUES (?, 'k', ?)").run(id, `${tag}memory`);
  db.prepare("INSERT INTO project_index (project_id, path, responsibility) VALUES (?, 'a.mjs', 'r')").run(id);
  db.prepare("INSERT INTO project_libs (project_id, lib, version) VALUES (?, 'lib', '1')").run(id);
  const run = db.prepare("INSERT INTO pipeline_runs (project_id, slug, tier, outcome, job_id) VALUES (?, 's', 'small', 'ok', ?) RETURNING id").get(id, job).id;
  db.prepare("INSERT INTO pipeline_phases (run_id, seq, phase) VALUES (?, 1, 'coder')").run(run);
  db.prepare("INSERT INTO project_key_aliases (key, project_id) VALUES (?, ?)").run(`OLD${tag.toUpperCase()}`.slice(0, 5), id);
  const decision = db.prepare("INSERT INTO decisions (scope, project_id, number, title, context, decision, job_id) VALUES ('project', ?, 1, ?, 'c', 'd', ?) RETURNING id").get(id, `${tag}decision`, job).id;
  const orgDecision = db.prepare("INSERT INTO decisions (scope, org_id, title, context, decision, status, superseded_by) VALUES ('org', ?, ?, 'c', 'd', 'superseded', ?) RETURNING id").get(orgId, `${tag}orgdecision`, decision).id;
  const item = db.prepare("INSERT INTO issues (scope, project_id, number, title, position, decision_id, job_id) VALUES ('project', ?, 1, ?, 1, ?, ?) RETURNING id").get(id, `${tag}item`, decision, job).id;
  db.prepare("INSERT INTO issue_comments (item_id, kind, author, body) VALUES (?, 'note', 'operator', ?)").run(item, `${tag}comment`);
  const orgItem = db.prepare("INSERT INTO issues (scope, org_id, number, title, position) VALUES ('org', ?, ?, ?, 1) RETURNING id").get(orgId, tag === "a" ? 1 : 2, `${tag}orgitem`).id;
  db.prepare("INSERT INTO issue_projects (item_id, project_id, job_id) VALUES (?, ?, ?)").run(orgItem, id, job);
  if (orgComment) db.prepare("INSERT INTO issue_comments (item_id, kind, author, body, project_id) VALUES (?, 'note', 'operator', ?, ?)").run(orgItem, `${tag}orgcomment`, id);
  return { orgDecision, orgItem };
}

// The rows of every table that point at a project id.
function rowsOf(db, projectId) {
  const tables = [...DATA_TABLES, "project_key_aliases"].filter((table) => table !== "issue_comments");
  const counts = Object.fromEntries(tables.map((table) => [table, db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE project_id = ?`).get(projectId).n]));
  counts.issue_comments = db.prepare("SELECT COUNT(*) AS n FROM issue_comments WHERE project_id = ? OR item_id IN (SELECT id FROM issues WHERE project_id = ?)").get(projectId, projectId).n;
  counts.pipeline_phases = db.prepare("SELECT COUNT(*) AS n FROM pipeline_phases WHERE run_id IN (SELECT id FROM pipeline_runs WHERE project_id = ?)").get(projectId).n;
  return counts;
}

// A home with two projects, each seeded in every table and given a run directory.
function twoProjects(t, name, options = {}) {
  const env = makeHome(t, name);
  makeOrg(env, "acme");
  const orgId = orgIdOf(env, "acme");
  const db = openDb(env);
  const ids = { a: ensureProject(env, "alpha", { org: "acme" }), b: ensureProject(env, "beta", { org: "acme" }) };
  seedProject(db, { id: ids.a, orgId, tag: "a", ...options });
  seedProject(db, { id: ids.b, orgId, tag: "b" });
  for (const id of Object.values(ids)) {
    mkdirSync(join(runsDir(env), id, "slug"), { recursive: true });
    writeFileSync(join(runsDir(env), id, "slug", "state.json"), "{}");
  }
  return { env, db, ids };
}

// How many hits a word has in a full-text mirror.
function ftsHits(db, table, word) {
  return db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${table} MATCH ?`).get(word).n;
}

test("project remove --purge --yes deletes the project and every row it owns, and nothing of another project", async (t) => {
  const { env, db, ids } = twoProjects(t, "purge-all", { orgComment: false });
  const beforeB = rowsOf(db, ids.b);
  assert.ok(Object.values(rowsOf(db, ids.a)).every((n) => n > 0), "every table is seeded");

  const result = await cli(env, ["project", "remove", "alpha", "--purge", "--yes"]);

  assert.equal(result.code, 0, result.err);
  assert.match(result.out.join("\n"), /purging project `alpha` deletes:[\s\S]*1 jobs[\s\S]*purged project `alpha`/);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM projects WHERE id = ?").get(ids.a).n, 0);
  assert.ok(Object.values(rowsOf(db, ids.a)).every((n) => n === 0));
  assert.deepEqual(rowsOf(db, ids.b), beforeB);
  assert.equal(existsSync(join(runsDir(env), ids.a)), false);
  assert.equal(existsSync(join(runsDir(env), ids.b, "slug", "state.json")), true);
  for (const [table, word] of [["lessons_fts", "alesson"], ["memory_fts", "amemory"], ["decisions_fts", "adecision"], ["issues_fts", "aitem"], ["issue_comments_fts", "acomment"]]) {
    assert.equal(ftsHits(db, table, word), 0, `${table} keeps no ${word}`);
  }
  assert.equal(ftsHits(db, "lessons_fts", "blesson"), 1);
  assert.equal(ftsHits(db, "issue_comments_fts", "borgcomment"), 1);
  assert.equal(db.prepare("SELECT superseded_by FROM decisions WHERE title = 'aorgdecision'").get().superseded_by, null);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM issues WHERE title = 'aorgitem'").get().n, 1);
  assert.match(db.prepare("SELECT sql FROM sqlite_master WHERE name = 'issue_comments_no_delete'").get().sql, /RAISE/);
});

test("purge is refused while the project has a running or a closing job, and removes nothing", async (t) => {
  const running = twoProjects(t, "purge-running", { jobStatus: "running", orgComment: false });
  const refused = await cli(running.env, ["project", "remove", "alpha", "--purge", "--yes"]);
  assert.equal(refused.code, 1);
  assert.match(refused.err, /cannot purge project `alpha`: 1 job\(s\) are running or closing; nothing was removed/);
  assert.equal(rowsOf(running.db, running.ids.a).jobs, 1);
  assert.equal(existsSync(join(runsDir(running.env), running.ids.a)), true);

  const closing = twoProjects(t, "purge-closing", { orgComment: false });
  closing.db.prepare("UPDATE jobs SET status = 'done', close_status = 'closing' WHERE project_id = ?").run(closing.ids.a);
  const refusedClosing = await cli(closing.env, ["project", "remove", "alpha", "--purge", "--yes"]);
  assert.equal(refusedClosing.code, 1);
  assert.equal(rowsOf(closing.db, closing.ids.a).jobs, 1);
});

test("a plain remove of a project with history is refused with the counts and a --purge hint", async (t) => {
  const { env, db, ids } = twoProjects(t, "purge-hint");
  const result = await cli(env, ["project", "remove", "alpha"]);
  assert.equal(result.code, 1);
  assert.match(result.err, /cannot remove project `alpha`: it still owns .*1 lessons.*1 jobs.*; use --purge .*nothing was removed/);
  assert.equal(rowsOf(db, ids.a).jobs, 1);
});

test("a plain remove still unregisters a project that owns nothing", async (t) => {
  const env = makeHome(t, "purge-empty");
  ensureProject(env, "empty");
  const result = await cli(env, ["project", "remove", "empty"]);
  assert.equal(result.code, 0, result.err);
  assert.deepEqual(result.out, ["removed project `empty`"]);
});

test("--purge without --yes and without a terminal refuses and deletes nothing", async (t) => {
  const { env, db, ids } = twoProjects(t, "purge-no-tty", { orgComment: false });
  const result = await cli(env, ["project", "remove", "alpha", "--purge"]);
  assert.equal(result.code, 1);
  assert.match(result.err, /purge needs confirmation: run it on a terminal or pass --yes; nothing was removed/);
  assert.equal(rowsOf(db, ids.a).jobs, 1);
  assert.equal(existsSync(join(runsDir(env), ids.a)), true);
});

test("--purge on a terminal deletes on a yes and keeps everything on any other answer", async (t) => {
  const { env, db, ids } = twoProjects(t, "purge-tty", { orgComment: false });
  const declined = await cli(env, ["project", "remove", "alpha", "--purge"], { answer: "\n" });
  assert.equal(declined.code, 1);
  assert.match(declined.err, /purge cancelled; nothing was removed/);
  assert.equal(rowsOf(db, ids.a).jobs, 1);

  const accepted = await cli(env, ["project", "remove", "alpha", "--purge"], { answer: "y\n" });
  assert.equal(accepted.code, 0, accepted.err);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM projects WHERE id = ?").get(ids.a).n, 0);
  assert.equal(existsSync(join(runsDir(env), ids.a)), false);
});

test("purge of a project with a comment on an org item is refused and changes nothing, the guard included", async (t) => {
  const { env, db, ids } = twoProjects(t, "purge-kept");
  const tables = [...DATA_TABLES, "projects", "project_key_aliases", "pipeline_phases"];
  const snapshot = () => Object.fromEntries(tables.map((table) => [table, db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n]));
  const before = snapshot();
  const guard = () => db.prepare("SELECT sql FROM sqlite_master WHERE name = 'issue_comments_no_delete'").get()?.sql;
  const guardBefore = guard();

  const refused = await cli(env, ["project", "remove", "alpha", "--purge", "--yes"]);

  assert.equal(refused.code, 1);
  assert.match(refused.err, /cannot purge project `alpha`: it wrote 1 comment\(s\) on roadmap items it does not own.*D-44.*nothing was removed/);
  assert.deepEqual(snapshot(), before);
  assert.match(guardBefore, /RAISE/);
  assert.equal(guard(), guardBefore);
  assert.equal(existsSync(join(runsDir(env), ids.a)), true);
});
