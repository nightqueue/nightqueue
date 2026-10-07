import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { dbPath } from "../src/config/paths.mjs";
import { closeDb } from "../src/memory/db.mjs";
import { saveDecision } from "../src/memory/decisions.mjs";
import { buildLegacyHome, legacyConfig } from "../test-support/legacy-home.mjs";
import { DOWNGRADE_TO_V5, makeDir, makeHome, makeOrg, makeProject, orgIdOf, projectIdOf } from "../test-support/memory.mjs";
import { migrateTestHome } from "../test-support/migrate.mjs";

const CLI = fileURLToPath(new URL("../bin/nightqueue.mjs", import.meta.url));
const LONG_ORG = "acme-platform-group";

// Runs the real CLI in its own process, with the isolated home of the test.
function runCli(env, args, { cwd } = {}) {
  return spawnSync(process.execPath, [CLI, ...args], { env, cwd, encoding: "utf8" });
}

// A home with one project of `acme`, one project of `orbit`, and one decision at each level.
function makeOrgHome(t, name) {
  const env = makeHome(t, name);
  const cwd = makeProject(t, env, "acme-mobile-app", { org: "acme" });
  makeProject(t, env, "orbit-app", { org: "orbit" });
  saveDecision({ projectId: projectIdOf(env, "acme-mobile-app"), title: "the app owns its cache", context: "c", decision: "d", status: "accepted" }, env);
  saveDecision({ orgId: orgIdOf(env, "acme"), title: "one queue per product", context: "c", decision: "d", status: "accepted" }, env);
  saveDecision({ orgId: orgIdOf(env, "orbit"), title: "orbit decides alone", context: "c", decision: "d", status: "accepted" }, env);
  return { env, cwd };
}

// A home whose database is exactly what the build before the owner scope wrote: three decisions, one issue, no `scope`/`org` column, user_version 5.
function makeV5Home(t, name) {
  const env = makeHome(t, name);
  const cwd = makeDir(t, `${name}-alpha`);
  mkdirSync(join(cwd, ".git"));
  const config = legacyConfig({ orgs: { acme: null }, projects: { alpha: { path: realpathSync(cwd), org: "acme" } } });
  buildLegacyHome(env, {
    version: 5,
    config,
    mutate(db) {
      for (const number of [1, 2, 3]) {
        db.prepare("INSERT INTO decisions (project, number, title, context, decision) VALUES (?, ?, ?, ?, ?)").run(
          "alpha",
          number,
          `legacy decision ${number}`,
          "old context",
          `old decision ${number}`,
        );
      }
      db.prepare("INSERT INTO roadmap_items (project, title, position) VALUES (?, ?, 1)").run("alpha", "legacy issue");
      db.exec(DOWNGRADE_TO_V5);
      assert.equal(
        db.prepare("PRAGMA table_info(decisions)").all().some((column) => column.name === "scope"),
        false,
        "the fixture kept the scope column, so it is not a v5 database",
      );
    },
  });
  return { env, cwd };
}

test("the read commands refuse a database written before the owner scope until `nightqueue update` migrates it, then read it", (t) => {
  const { env, cwd } = makeV5Home(t, "decision-v5-read");
  const before = readFileSync(dbPath(env));

  const refused = runCli(env, ["decision", "list", "--project", "alpha"], { cwd });
  assert.equal(refused.status, 1, refused.stdout);
  assert.match(refused.stderr, /database at v5, this nightqueue expects v24: run `nightqueue update`/);
  assert.ok(readFileSync(dbPath(env)).equals(before), "a refused read wrote to the database");
  assert.match(runCli(env, ["doctor"], { cwd }).stdout, /warn\s+database\s+schema v5, this nightqueue expects v24/);

  migrateTestHome(env);
  closeDb(env);

  const listed = runCli(env, ["decision", "list", "--project", "alpha"], { cwd });
  assert.equal(listed.status, 0, listed.stderr);
  for (const number of [1, 2, 3]) {
    assert.match(listed.stdout, new RegExp(`^D-${number}\\s+accepted\\s+\\d{4}-\\d{2}-\\d{2}\\s+legacy decision ${number}$`, "m"));
  }

  const shown = runCli(env, ["decision", "show", "2", "--project", "alpha"], { cwd });
  assert.equal(shown.status, 0, shown.stderr);
  assert.ok(shown.stdout.includes("D-2 legacy decision 2 (accepted)"), shown.stdout);

  assert.match(runCli(env, ["doctor"], { cwd }).stdout, /ok\s+database\s+schema v24/);
});

test("a read-only v5 database answers with the update message, never with a raw missing column", (t) => {
  const { env, cwd } = makeV5Home(t, "decision-v5-readonly");
  const path = dbPath(env);
  chmodSync(path, 0o444);
  t.after(() => existsSync(path) && chmodSync(path, 0o644));

  const listed = runCli(env, ["decision", "list", "--project", "alpha"], { cwd });
  assert.equal(listed.status, 1, listed.stdout);
  assert.match(listed.stderr, /database at v5, this nightqueue expects v24: run `nightqueue update`/);
  assert.equal(listed.stderr.includes("no such column"), false, listed.stderr);
});

test("decision list of a project prints its org's rows first, qualified, and never another org's", (t) => {
  const { env, cwd } = makeOrgHome(t, "decision-org-list");
  const result = runCli(env, ["decision", "list"], { cwd });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^AM\/D-1\s+accepted\s+\d{4}-\d{2}-\d{2}\s+one queue per product$/m);
  assert.match(result.stdout, /^D-1\s+accepted\s+\d{4}-\d{2}-\d{2}\s+the app owns its cache$/m);
  assert.ok(result.stdout.indexOf("AM/D-1") < result.stdout.indexOf("\nD-1  "), "the org row must come first");
  assert.equal(result.stdout.includes("orbit decides alone"), false, "a orbit decision reached a acme project");
});

test("decision list --org and decision show --org read one org alone, and --project with --org is refused", (t) => {
  const { env, cwd } = makeOrgHome(t, "decision-org-flag");
  const listed = runCli(env, ["decision", "list", "--org", "acme"], { cwd });
  assert.equal(listed.status, 0, listed.stderr);
  assert.ok(listed.stdout.includes("one queue per product"));
  assert.equal(listed.stdout.includes("the app owns its cache"), false, "a project row reached an org listing");

  const shown = runCli(env, ["decision", "show", "1", "--org", "acme"], { cwd });
  assert.equal(shown.status, 0, shown.stderr);
  assert.ok(shown.stdout.includes("AM/D-1 one queue per product (accepted)"));
  assert.ok(shown.stdout.includes("org: acme"));

  const both = runCli(env, ["decision", "list", "--project", "acme-mobile-app", "--org", "acme"], { cwd });
  assert.equal(both.status, 1);
  assert.match(both.stderr, /never both/);
  const unknown = runCli(env, ["decision", "list", "--org", "ghost"], { cwd });
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /unknown org `ghost`/);
});

test("a short org name stays in the NUMBER column and a long one is never glued to the status", (t) => {
  const { env, cwd } = makeOrgHome(t, "decision-org-width");
  const aligned = runCli(env, ["decision", "list", "--org", "acme"], { cwd });
  assert.equal(aligned.status, 0, aligned.stderr);
  const [head, short] = aligned.stdout.trim().split("\n");
  assert.equal(head.indexOf("STATUS"), short.indexOf("accepted"), `the columns drifted:\n${aligned.stdout}`);

  const wide = makeHome(t, "decision-org-width-long");
  const wideCwd = makeProject(t, wide, "alpha", { org: LONG_ORG });
  saveDecision({ orgId: orgIdOf(wide, LONG_ORG), title: "one queue per product", context: "c", decision: "d", status: "accepted" }, wide);
  const result = runCli(wide, ["decision", "list"], { cwd: wideCwd });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`^APG\/D-1\\s+accepted\\s+\\d{4}-\\d{2}-\\d{2}\\s+one queue per product$`, "m"));
});

test("the org read commands never create the database: a home with none has no org to read", (t) => {
  const env = makeHome(t, "decision-org-no-database");
  const cwd = makeDir(t, "decision-org-no-database-cwd");
  assert.equal(existsSync(dbPath(env)), false, "this home must start with no database at all");

  const listed = runCli(env, ["decision", "list", "--org", "acme"], { cwd });
  assert.equal(listed.status, 1, listed.stdout);
  assert.match(listed.stderr, /unknown org `acme`; existing orgs: \(none\)/);
  assert.equal(existsSync(dbPath(env)), false, "a read-only command created the database");
});

test("the org read commands of a home with a database read an empty org without opening it for writing", (t) => {
  const env = makeHome(t, "decision-org-empty");
  makeOrg(env, "acme");
  const cwd = makeProject(t, env, "alpha", { org: "acme" });
  closeDb(env);
  const listed = runCli(env, ["decision", "list", "--org", "acme"], { cwd });
  assert.equal(listed.status, 0, listed.stderr);
  assert.equal(listed.stdout.trim(), "no decisions for org `acme`");
});

test("org rename carries the decisions of the org with it", (t) => {
  const { env, cwd } = makeOrgHome(t, "org-rename-rows");
  const renamed = runCli(env, ["org", "rename", "acme", "acmeweb"], { cwd });
  assert.equal(renamed.status, 0, renamed.stderr);
  const listed = runCli(env, ["decision", "list", "--org", "acmeweb"], { cwd });
  assert.equal(listed.status, 0, listed.stderr);
  assert.ok(listed.stdout.includes("one queue per product"), listed.stdout);
  assert.equal(runCli(env, ["decision", "list", "--org", "acme"], { cwd }).status, 1);

  assert.ok(runCli(env, ["decision", "list", "--org", "orbit"], { cwd }).stdout.includes("orbit decides alone"));
});

test("an org with no project is still refused a removal while it owns decisions", (t) => {
  const { env, cwd } = makeOrgHome(t, "org-remove-rows");
  makeOrg(env, "solo");
  saveDecision({ orgId: orgIdOf(env, "solo"), title: "solo decides", context: "c", decision: "d" }, env);
  const refused = runCli(env, ["org", "remove", "solo"], { cwd });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /cannot remove org `solo`: it still owns 1 decisions/);
  assert.ok(runCli(env, ["org", "list"], { cwd }).stdout.includes("solo"), "the refused removal dropped the org anyway");
  assert.ok(runCli(env, ["decision", "list", "--org", "solo"], { cwd }).stdout.includes("solo decides"));
});
