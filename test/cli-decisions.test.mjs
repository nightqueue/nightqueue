import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { configPath, dbPath } from "../src/config/paths.mjs";
import { saveDecision } from "../src/memory/decisions.mjs";
import { addJob } from "../src/memory/jobs.mjs";
import { markRoadmapItemQueued, saveRoadmapItem } from "../src/memory/roadmap.mjs";
import { makeDir, makeHome, makeProject } from "../test-support/memory.mjs";

const CLI = fileURLToPath(new URL("../bin/nightshift.mjs", import.meta.url));

// Runs the real CLI in its own process, with the isolated home of the test.
function runCli(env, args, { cwd } = {}) {
  return spawnSync(process.execPath, [CLI, ...args], { env, cwd, encoding: "utf8" });
}

// A home with one registered project, and the path the commands resolve that project from.
function makeCliHome(t, name) {
  const env = makeHome(t, name);
  return { env, cwd: makeProject(t, env, "alpha") };
}

// Seeds the two decisions every listing test reads.
function seedDecisions(env) {
  const accepted = saveDecision(
    {
      project: "alpha",
      title: "Store everything in one SQLite file",
      context: "the runtime has several writers",
      decision: "open the database in WAL with a busy timeout",
      consequences: "no server to run, one file to back up",
      status: "accepted",
    },
    env,
  );
  saveDecision({ project: "alpha", title: "Ship a daemon", context: "polling is slow", decision: "run a resident process", status: "rejected" }, env);
  return accepted;
}

test("decision list prints a sensible line when the project has no decisions", (t) => {
  const { env, cwd } = makeCliHome(t, "decision-empty");
  const result = runCli(env, ["decision", "list"], { cwd });
  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), "no decisions for `alpha`");
});

test("decision list prints the number, the status and the title of every decision", (t) => {
  const { env, cwd } = makeCliHome(t, "decision-list");
  seedDecisions(env);
  const result = runCli(env, ["decision", "list"], { cwd });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /^NUMBER\s+STATUS\s+UPDATED\s+TITLE$/m);
  assert.match(result.stdout, /^#1\s+accepted\s+\d{4}-\d{2}-\d{2}\s+Store everything in one SQLite file$/m);
  assert.match(result.stdout, /^#2\s+rejected\s+\d{4}-\d{2}-\d{2}\s+Ship a daemon$/m);
});

test("decision list --status keeps only that status and refuses one outside the enum", (t) => {
  const { env, cwd } = makeCliHome(t, "decision-status");
  seedDecisions(env);
  const filtered = runCli(env, ["decision", "list", "--status", "rejected"], { cwd });
  assert.equal(filtered.status, 0);
  assert.ok(filtered.stdout.includes("Ship a daemon"));
  assert.ok(!filtered.stdout.includes("Store everything in one SQLite file"));
  const wrong = runCli(env, ["decision", "list", "--status", "maybe"], { cwd });
  assert.equal(wrong.status, 1);
  for (const status of ["proposed", "accepted", "superseded", "rejected"]) {
    assert.ok(wrong.stderr.includes(status), `\`${status}\` is missing from the refusal`);
  }
});

test("decision show prints the decision in full and refuses an unknown number", (t) => {
  const { env, cwd } = makeCliHome(t, "decision-show");
  seedDecisions(env);
  const result = runCli(env, ["decision", "show", "1"], { cwd });
  assert.equal(result.status, 0);
  assert.ok(result.stdout.includes("#1 Store everything in one SQLite file (accepted)"));
  assert.ok(result.stdout.includes("Context: the runtime has several writers"));
  assert.ok(result.stdout.includes("Decision: open the database in WAL with a busy timeout"));
  assert.ok(result.stdout.includes("Consequences: no server to run, one file to back up"));
  assert.ok(result.stdout.includes("project: alpha"));
  const unknown = runCli(env, ["decision", "show", "9"], { cwd });
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /unknown decision #9 for `alpha`/);
  assert.equal(runCli(env, ["decision", "show", "zero"], { cwd }).status, 1);
});

test("roadmap prints the three horizons in order, with the position, the linked decision and the job", (t) => {
  const { env, cwd } = makeCliHome(t, "roadmap-list");
  const decision = seedDecisions(env);
  const queued = saveRoadmapItem({ project: "alpha", horizon: "now", title: "Ship the queue", decision_id: decision.id }, env);
  saveRoadmapItem({ project: "alpha", horizon: "later", title: "Write the dashboard" }, env);
  const job = addJob({ project: "alpha", prompt: "ship the queue" }, env);
  assert.equal(markRoadmapItemQueued(queued.id, job.id, env), true);
  const result = runCli(env, ["roadmap"], { cwd });
  assert.equal(result.status, 0);
  assert.ok(result.stdout.indexOf("now:") < result.stdout.indexOf("next:"), "the horizons are out of order");
  assert.ok(result.stdout.indexOf("next:") < result.stdout.indexOf("later:"), "the horizons are out of order");
  assert.ok(result.stdout.includes("  1. Ship the queue  [queued]"));
  assert.ok(result.stdout.includes(`     decision #${decision.number}`));
  assert.ok(result.stdout.includes(`     job #${job.id} (pending)`));
  assert.ok(result.stdout.includes("  1. Write the dashboard  [open]"));
  assert.match(result.stdout, /^next:\n {2}\(empty\)$/m);
});

test("roadmap of a project with nothing planned prints every horizon as empty", (t) => {
  const { env, cwd } = makeCliHome(t, "roadmap-empty");
  const result = runCli(env, ["roadmap"], { cwd });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "now:\n  (empty)\nnext:\n  (empty)\nlater:\n  (empty)\n");
});

test("--project names the project, the current directory resolves it, and neither command ever registers one", (t) => {
  const { env, cwd } = makeCliHome(t, "decision-project");
  seedDecisions(env);
  const outside = makeDir(t, "decision-outside");
  mkdirSync(join(outside, ".git"), { recursive: true });
  const named = runCli(env, ["decision", "list", "--project", "alpha"], { cwd: outside });
  assert.equal(named.status, 0);
  assert.ok(named.stdout.includes("Store everything in one SQLite file"));
  assert.equal(runCli(env, ["decision", "list", "--project", "ghost"], { cwd }).status, 1);
  const before = readFileSync(configPath(env), "utf8");
  const databaseBefore = readFileSync(dbPath(env));
  const unresolved = runCli(env, ["roadmap"], { cwd: outside });
  assert.equal(unresolved.status, 1);
  assert.match(unresolved.stderr, /no project registered for .*; run `nightshift init` here, or pass --project <name>/);
  assert.equal(readFileSync(configPath(env), "utf8"), before, "a read-only command registered a project");
  assert.deepEqual(readFileSync(dbPath(env)), databaseBefore, "a read-only command wrote to the database");
});

test("the three commands never create the database, and a home that has none reads as an empty one", (t) => {
  const { env, cwd } = makeCliHome(t, "decision-no-database");
  assert.equal(existsSync(dbPath(env)), false, "this home must start with no database at all");

  const list = runCli(env, ["decision", "list"], { cwd });
  assert.equal(list.status, 0, list.stderr);
  assert.equal(list.stdout.trim(), "no decisions for `alpha`");

  const json = runCli(env, ["decision", "list", "--json"], { cwd });
  assert.equal(json.status, 0, json.stderr);
  assert.deepEqual(JSON.parse(json.stdout), { project: "alpha", decisions: [] });

  const roadmap = runCli(env, ["roadmap"], { cwd });
  assert.equal(roadmap.status, 0, roadmap.stderr);
  assert.equal(roadmap.stdout, "now:\n  (empty)\nnext:\n  (empty)\nlater:\n  (empty)\n");

  const show = runCli(env, ["decision", "show", "1"], { cwd });
  assert.equal(show.status, 1);
  assert.match(show.stderr, /unknown decision #1 for `alpha`/);
  assert.equal(show.stderr.includes("SQLITE"), false, `a raw SQLite error reached the operator: ${show.stderr}`);

  assert.equal(existsSync(dbPath(env)), false, "a read-only command created the database");
});

test("--help lists the three read-only commands of the decisions and of the roadmap", (t) => {
  const { env } = makeCliHome(t, "decision-help");
  const result = runCli(env, ["--help"]);
  assert.equal(result.status, 0);
  for (const line of ["  decision list", "  decision show", "  roadmap ["]) {
    assert.ok(result.stdout.includes(line), `\`${line}\` is missing from the help`);
  }
});
