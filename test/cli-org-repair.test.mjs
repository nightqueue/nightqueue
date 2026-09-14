import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { orgRenamePendingPath } from "../src/config/paths.mjs";
import { ensureHome, loadConfig } from "../src/config/store.mjs";
import { closeDb, openDb } from "../src/memory/db.mjs";
import { saveDecision } from "../src/memory/decisions.mjs";
import { saveRoadmapItem } from "../src/memory/roadmap.mjs";
import { makeHome, makeProject } from "../test-support/memory.mjs";

const CLI = fileURLToPath(new URL("../bin/nightshift.mjs", import.meta.url));

function runCli(env, args, { cwd } = {}) {
  return spawnSync(process.execPath, [CLI, ...args], { env, cwd, encoding: "utf8" });
}

// A home with one project of `acme`, one org decision and one org roadmap item.
function makeOrgHome(t, name) {
  const env = makeHome(t, name);
  const cwd = makeProject(t, env, "alpha", { org: "acme" });
  saveDecision({ org: "acme", title: "one queue per product", context: "c", decision: "d" }, env);
  saveRoadmapItem({ org: "acme", horizon: "now", title: "raise the node version" }, env);
  return { env, cwd };
}

// Sets the org of every org row by hand, the way a rename that died halfway leaves them.
function setOrgRows(env, from, to) {
  const db = openDb(env);
  db.prepare("UPDATE decisions SET org = ? WHERE scope = 'org' AND org = ?").run(to, from);
  db.prepare("UPDATE roadmap_items SET org = ? WHERE scope = 'org' AND org = ?").run(to, from);
  closeDb(env);
}

function writePending(env, from, to) {
  ensureHome(env);
  writeFileSync(orgRenamePendingPath(env), JSON.stringify({ from, to, at: "2026-09-14T00:00:00Z" }));
}

function doctorLine(env, cwd, name) {
  const result = runCli(env, ["doctor", "--json"], { cwd });
  const report = JSON.parse(result.stdout);
  return report.checks.find((entry) => entry.name === name) ?? null;
}

test("a rename that died after the rows moved and before the config did is rolled back by `org repair`", (t) => {
  const { env, cwd } = makeOrgHome(t, "org-repair-rollback");
  writePending(env, "acme", "acmeweb");
  setOrgRows(env, "acme", "acmeweb");

  const hidden = runCli(env, ["decision", "list", "--project", "alpha"], { cwd });
  assert.equal(hidden.stdout.includes("one queue per product"), false, "the state under test hides the org decision");
  const doctor = doctorLine(env, cwd, "org rows");
  assert.equal(doctor?.status, "fail");
  assert.match(doctor.detail, /rename `acme` -> `acmeweb` interrupted/);

  const refused = runCli(env, ["org", "rename", "acme", "other"], { cwd });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /interrupted; run `nightshift org repair`/);

  const repair = runCli(env, ["org", "repair"], { cwd });
  assert.equal(repair.status, 0, repair.stderr);
  assert.match(repair.stdout, /rolled back the rename of org `acme` to `acmeweb`/);
  assert.equal(existsSync(orgRenamePendingPath(env)), false);

  const visible = runCli(env, ["decision", "list", "--project", "alpha"], { cwd });
  assert.match(visible.stdout, /acme#1 .*one queue per product/);
  assert.match(runCli(env, ["roadmap", "--org", "acme"], { cwd }).stdout, /raise the node version/);
  assert.equal(doctorLine(env, cwd, "org rows")?.status, "ok");
});

test("a rename that died after the config committed is finished forward by `org repair`, whether the rows moved or not", (t) => {
  for (const rowsMoved of [false, true]) {
    const { env, cwd } = makeOrgHome(t, `org-repair-forward-${rowsMoved}`);
    const renamed = runCli(env, ["org", "rename", "acme", "acmeweb"], { cwd });
    assert.equal(renamed.status, 0, renamed.stderr);
    if (!rowsMoved) setOrgRows(env, "acmeweb", "acme");
    writePending(env, "acme", "acmeweb");

    const repair = runCli(env, ["org", "repair"], { cwd });
    assert.equal(repair.status, 0, repair.stderr);
    assert.match(repair.stdout, /finished the rename of org `acme` to `acmeweb`/);
    assert.equal(existsSync(orgRenamePendingPath(env)), false);
    assert.match(runCli(env, ["decision", "list", "--org", "acmeweb"], { cwd }).stdout, /acmeweb#1 .*one queue per product/);
    assert.equal(doctorLine(env, cwd, "org rows")?.status, "ok");
  }
});

test("orphan rows with no rename record are reported by doctor and moved only where --to says", (t) => {
  const { env, cwd } = makeOrgHome(t, "org-repair-orphans");
  setOrgRows(env, "acme", "ghost");

  const doctor = doctorLine(env, cwd, "org rows");
  assert.equal(doctor?.status, "fail");
  assert.match(doctor.detail, /2 row\(s\) point to unknown org `ghost`/);

  const undirected = runCli(env, ["org", "repair"], { cwd });
  assert.notEqual(undirected.status, 0);
  assert.match(undirected.stderr, /2 row\(s\) point to unknown org `ghost`; move them with `nightshift org repair --to <org>`/);

  const unknownTarget = runCli(env, ["org", "repair", "--to", "nope"], { cwd });
  assert.notEqual(unknownTarget.status, 0);
  assert.match(unknownTarget.stderr, /unknown org `nope`/);

  const moved = runCli(env, ["org", "repair", "--to", "acme"], { cwd });
  assert.equal(moved.status, 0, moved.stderr);
  assert.match(moved.stdout, /moved 2 row\(s\) of `ghost` to org `acme`/);
  assert.match(runCli(env, ["decision", "list", "--org", "acme"], { cwd }).stdout, /one queue per product/);
  assert.equal(doctorLine(env, cwd, "org rows")?.status, "ok");
  assert.match(runCli(env, ["org", "repair"], { cwd }).stdout, /nothing to repair/);
});

test("a clean rename leaves no record behind and the config still names the org", (t) => {
  const { env, cwd } = makeOrgHome(t, "org-repair-clean");
  const renamed = runCli(env, ["org", "rename", "acme", "acmeweb"], { cwd });
  assert.equal(renamed.status, 0, renamed.stderr);
  assert.equal(existsSync(orgRenamePendingPath(env)), false);
  assert.ok(loadConfig(env, { warn: () => {} }).orgs.acmeweb);
  assert.equal(doctorLine(env, cwd, "org rows")?.status, "ok");
});
