import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { configPath, dbPath } from "../src/config/paths.mjs";
import { getDecisionByNumber, saveDecision } from "../src/memory/decisions.mjs";
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
  saveDecision({ project: "alpha", title: "Deliver a daemon", context: "polling is slow", decision: "run a resident process", status: "rejected" }, env);
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
  assert.match(result.stdout, /^#2\s+rejected\s+\d{4}-\d{2}-\d{2}\s+Deliver a daemon$/m);
});

test("decision list --status keeps only that status and refuses one outside the enum", (t) => {
  const { env, cwd } = makeCliHome(t, "decision-status");
  seedDecisions(env);
  const filtered = runCli(env, ["decision", "list", "--status", "rejected"], { cwd });
  assert.equal(filtered.status, 0);
  assert.ok(filtered.stdout.includes("Deliver a daemon"));
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
  const queued = saveRoadmapItem({ project: "alpha", horizon: "now", title: "Deliver the queue", decision_id: decision.id }, env);
  saveRoadmapItem({ project: "alpha", horizon: "later", title: "Write the dashboard" }, env);
  const job = addJob({ project: "alpha", prompt: "deliver the queue" }, env);
  assert.equal(markRoadmapItemQueued(queued.id, job.id, env), true);
  const result = runCli(env, ["roadmap"], { cwd });
  assert.equal(result.status, 0);
  assert.ok(result.stdout.indexOf("now:") < result.stdout.indexOf("next:"), "the horizons are out of order");
  assert.ok(result.stdout.indexOf("next:") < result.stdout.indexOf("later:"), "the horizons are out of order");
  assert.ok(result.stdout.includes("  1. Deliver the queue  [queued]"));
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
  for (const line of ["  decision list", "  decision show", "  decision export", "  decision import", "  roadmap ["]) {
    assert.ok(result.stdout.includes(line), `\`${line}\` is missing from the help`);
  }
});

// Writes a hand-made decision file in a fresh directory and returns its path.
function writeDecisionFile(t, name, text) {
  const path = join(makeDir(t, name), `${name}.md`);
  writeFileSync(path, text);
  return path;
}

// The one file an export wrote into its directory.
function exportedFile(result, dir) {
  assert.equal(result.status, 0, result.stderr);
  const path = result.stdout.trim();
  assert.deepEqual(readdirSync(dir), [path.slice(dir.length + 1)]);
  return path;
}

// Exports decision #1 of a home into a fresh directory and imports that file into another fresh home, returning both files.
function roundTrip(t, name, seed) {
  const a = makeCliHome(t, `${name}-a`);
  saveDecision({ project: "alpha", status: "accepted", ...seed }, a.env);
  const firstDir = makeDir(t, `${name}-first`);
  const first = exportedFile(runCli(a.env, ["decision", "export", "1", "--dir", firstDir], { cwd: a.cwd }), firstDir);
  const firstText = readFileSync(first, "utf8");
  const b = makeCliHome(t, `${name}-b`);
  const imported = runCli(b.env, ["decision", "import", first, "--project", "alpha"], { cwd: b.cwd });
  assert.equal(imported.status, 0, imported.stderr);
  assert.equal(imported.stdout.trim(), "imported as #1");
  const secondDir = makeDir(t, `${name}-second`);
  const second = exportedFile(runCli(b.env, ["decision", "export", "1", "--dir", secondDir], { cwd: b.cwd }), secondDir);
  return { a, b, first, firstText, secondText: readFileSync(second, "utf8") };
}

test("export then import then export is byte-identical, and the imported row keeps every field and the date", (t) => {
  const seed = {
    title: "Store everything in one SQLite file",
    context: "the runtime has several writers\n\nand no server",
    decision: "open the database in WAL with a busy timeout",
    consequences: "no server to run, one file to back up",
  };
  const { a, b, first, firstText, secondText } = roundTrip(t, "round-trip", seed);
  assert.equal(secondText, firstText);
  assert.equal(readFileSync(first, "utf8"), firstText, "stamping the same pointer changed the file");
  const original = getDecisionByNumber({ project: "alpha", number: 1 }, a.env);
  const copy = getDecisionByNumber({ project: "alpha", number: 1 }, b.env);
  for (const field of ["title", "status", "context", "decision", "consequences"]) assert.equal(copy[field], original[field], field);
  assert.equal(copy.created_at.slice(0, 10), original.created_at.slice(0, 10));
  assert.ok(first.endsWith("0001-store-everything-in-one-sqlite-file.md"), first);
});

test("a round trip without consequences stays byte-identical and imports no consequences", (t) => {
  const seed = { title: "Deliver without a daemon", context: "polling is enough", decision: "poll every minute" };
  const { b, firstText, secondText } = roundTrip(t, "round-trip-bare", seed);
  assert.equal(secondText, firstText);
  assert.ok(!firstText.includes("## Consequences"));
  assert.equal(getDecisionByNumber({ project: "alpha", number: 1 }, b.env).consequences, null);
});

test("importing the same file again is refused as already imported, and nothing is saved", (t) => {
  const seed = { title: "Store everything in one SQLite file", context: "c", decision: "d" };
  const { b, first } = roundTrip(t, "reimport", seed);
  const again = runCli(b.env, ["decision", "import", first, "--project", "alpha"], { cwd: b.cwd });
  assert.equal(again.status, 1);
  assert.match(again.stderr, /already imported as #1 \(Store everything in one SQLite file\); nothing imported/);
  assert.equal(getDecisionByNumber({ project: "alpha", number: 2 }, b.env), null);
});

test("--superseded-by imports a superseded row pointing at the successor, and stamps the file", (t) => {
  const { env, cwd } = makeCliHome(t, "import-superseded");
  const successor = seedDecisions(env);
  const file = writeDecisionFile(
    t,
    "0003-old-rule",
    "# 0003 - Widgets live on one shelf\n\nStatus: Accepted (2026-01-05), later narrowed\nwhen shelves became configurable.\n\n## Context\n\nShelves hold widgets.\n\n## Decision\n\nOne shelf per widget.\n",
  );
  const result = runCli(env, ["decision", "import", file, "--superseded-by", "1"], { cwd });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "imported as #3");
  const row = getDecisionByNumber({ project: "alpha", number: 3 }, env);
  assert.equal(row.status, "superseded");
  assert.equal(row.superseded_by, successor.id);
  assert.equal(row.superseded_by_number, 1);
  assert.equal(row.created_at, "2026-01-05 00:00:00");
  assert.ok(readFileSync(file, "utf8").startsWith("# 0003 - Widgets live on one shelf\n\nDecision #3 in the alpha store.\n\nStatus: Accepted"));
  const conflict = runCli(env, ["decision", "import", file, "--superseded-by", "1", "--status", "accepted"], { cwd });
  assert.equal(conflict.status, 1);
  assert.match(conflict.stderr, /conflicts with `--status accepted`/);
});

test("--status overrides the file's Status:, and a file without one needs it", (t) => {
  const { env, cwd } = makeCliHome(t, "import-status");
  const file = writeDecisionFile(t, "0006-studio", "# 0006 - A studio for gizmos\n\nStatus: Proposed (2026-03-01).\n\n## Context\n\nGizmos are edited by hand.\n\n## Decision\n\nBuild a studio.\n\n## Pros\n\nFaster edits.\n");
  const result = runCli(env, ["decision", "import", file, "--status", "accepted"], { cwd });
  assert.equal(result.status, 0, result.stderr);
  const row = getDecisionByNumber({ project: "alpha", number: 1 }, env);
  assert.equal(row.status, "accepted");
  assert.equal(row.decision, "Build a studio.\n\n## Pros\n\nFaster edits.");
  const bare = writeDecisionFile(t, "no-status", "# Paint gadgets blue\n\n## Context\n\nc\n\n## Decision\n\nd\n");
  const refused = runCli(env, ["decision", "import", bare], { cwd });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /no `Status:` line .*pass --status <status>/);
});

test("an import that overlaps a decision lists the candidates, and --unrelated imports it", (t) => {
  const { env, cwd } = makeCliHome(t, "import-overlap");
  seedDecisions(env);
  const file = writeDecisionFile(t, "overlap", "# Store everything in one SQLite database\n\nStatus: Accepted (2026-02-02).\n\n## Context\n\nc\n\n## Decision\n\nd\n");
  const refused = runCli(env, ["decision", "import", file], { cwd });
  assert.equal(refused.status, 1);
  assert.ok(refused.stderr.includes("  #1 Store everything in one SQLite file (accepted)"), refused.stderr);
  assert.match(refused.stderr, /--supersedes <n,\.\.\.>.*--unrelated <n,\.\.\.>/);
  assert.equal(getDecisionByNumber({ project: "alpha", number: 3 }, env), null);
  assert.ok(!readFileSync(file, "utf8").includes("Decision #"), "a refused import stamped the file");
  const malformed = runCli(env, ["decision", "import", file, "--unrelated", "1,x"], { cwd });
  assert.equal(malformed.status, 1);
  assert.match(malformed.stderr, /`--unrelated` expects a positive integer decision number, got `x`/);
  const accepted = runCli(env, ["decision", "import", file, "--unrelated", "1"], { cwd });
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.equal(accepted.stdout.trim(), "imported as #3");
});

test("export refuses an existing file unless --force, and defaults to docs/decisions of the current directory", (t) => {
  const { env, cwd } = makeCliHome(t, "export-force");
  seedDecisions(env);
  const first = runCli(env, ["decision", "export", "1"], { cwd });
  assert.equal(first.status, 0, first.stderr);
  assert.equal(first.stdout.trim(), join(realpathSync(cwd), "docs", "decisions", "0001-store-everything-in-one-sqlite-file.md"));
  const again = runCli(env, ["decision", "export", "1"], { cwd });
  assert.equal(again.status, 1);
  assert.match(again.stderr, /already exists; pass --force to overwrite it/);
  assert.equal(runCli(env, ["decision", "export", "1", "--force"], { cwd }).status, 0);
});

test("export never creates the database nor a file when the home has none", (t) => {
  const { env, cwd } = makeCliHome(t, "export-no-database");
  const dir = makeDir(t, "export-no-database-dir");
  const result = runCli(env, ["decision", "export", "1", "--dir", dir], { cwd });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /unknown decision #1 for `alpha`/);
  assert.equal(existsSync(dbPath(env)), false, "export created the database");
  assert.deepEqual(readdirSync(dir), []);
});

test("decision update accepts or rejects a proposed decision, printing it like show", (t) => {
  const { env, cwd } = makeCliHome(t, "decision-update");
  saveDecision({ project: "alpha", title: "Store everything in one SQLite file", context: "c", decision: "d", status: "proposed" }, env);
  saveDecision({ project: "alpha", title: "Deliver a daemon", context: "c", decision: "d", status: "proposed" }, env);

  const accepted = runCli(env, ["decision", "update", "1", "--status", "accepted"], { cwd });
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.ok(accepted.stdout.includes("#1 Store everything in one SQLite file (accepted)"));
  assert.ok(accepted.stdout.includes("project: alpha"));
  assert.equal(getDecisionByNumber({ project: "alpha", number: 1 }, env).status, "accepted");

  const rejected = runCli(env, ["decision", "update", "2", "--status", "rejected"], { cwd });
  assert.equal(rejected.status, 0, rejected.stderr);
  assert.ok(rejected.stdout.includes("#2 Deliver a daemon (rejected)"));
  assert.equal(getDecisionByNumber({ project: "alpha", number: 2 }, env).status, "rejected");
});

test("decision update --status superseded requires --superseded-by, and never touches the row without it", (t) => {
  const { env, cwd } = makeCliHome(t, "decision-update-superseded");
  saveDecision({ project: "alpha", title: "Store everything in one SQLite file", context: "c", decision: "d", status: "proposed" }, env);
  saveDecision({ project: "alpha", title: "Split into two databases", context: "c", decision: "d", status: "accepted" }, env);

  const refused = runCli(env, ["decision", "update", "1", "--status", "superseded"], { cwd });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /a `superseded` decision needs the decision that replaced it: pass --superseded-by <number>/);
  assert.equal(getDecisionByNumber({ project: "alpha", number: 1 }, env).status, "proposed");

  const conflict = runCli(env, ["decision", "update", "1", "--status", "accepted", "--superseded-by", "2"], { cwd });
  assert.equal(conflict.status, 1);
  assert.match(conflict.stderr, /conflicts with `--status accepted`/);

  const settled = runCli(env, ["decision", "update", "1", "--status", "superseded", "--superseded-by", "2"], { cwd });
  assert.equal(settled.status, 0, settled.stderr);
  assert.ok(settled.stdout.includes("#1 Store everything in one SQLite file (superseded)"));
  const row = getDecisionByNumber({ project: "alpha", number: 1 }, env);
  assert.equal(row.status, "superseded");
  assert.equal(row.superseded_by_number, 2);
});

test("decision update refuses an unknown decision number and an unknown successor, naming the owner", (t) => {
  const { env, cwd } = makeCliHome(t, "decision-update-unknown");
  saveDecision({ project: "alpha", title: "Store everything in one SQLite file", context: "c", decision: "d", status: "proposed" }, env);

  const unknownRow = runCli(env, ["decision", "update", "9", "--status", "accepted"], { cwd });
  assert.equal(unknownRow.status, 1);
  assert.match(unknownRow.stderr, /unknown decision #9 for `alpha`/);

  const unknownSuccessor = runCli(env, ["decision", "update", "1", "--status", "superseded", "--superseded-by", "9"], { cwd });
  assert.equal(unknownSuccessor.status, 1);
  assert.match(unknownSuccessor.stderr, /unknown decision #9 for `alpha`/);
  assert.equal(getDecisionByNumber({ project: "alpha", number: 1 }, env).status, "proposed");
});

test("export never writes the database", (t) => {
  const { env, cwd } = makeCliHome(t, "export-read-only");
  seedDecisions(env);
  const before = readFileSync(dbPath(env));
  const result = runCli(env, ["decision", "export", "1", "--dir", makeDir(t, "export-read-only-dir")], { cwd });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(readFileSync(dbPath(env)), before, "export wrote to the database");
});
