import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { dbPath } from "../src/config/paths.mjs";
import { closeDb, openDb, openDbReadOnly, schemaVersionOn } from "../src/memory/db.mjs";
import { openStore } from "../src/store/open.mjs";
import { FROM_LINE, FROM_URL, JOB_ID, REFUSAL_EXIT, TO_LINE, TO_URL, main } from "../scripts/repair-job-pr-attribution.mjs";
import { makeHome } from "../test-support/memory.mjs";

const SCRIPT = join(resolve(dirname(fileURLToPath(import.meta.url)), ".."), "scripts", "repair-job-pr-attribution.mjs");
const NOTICE_BEFORE = "Delivered the ship command.\n\nPR: " + FROM_URL + "\n\n" + FROM_LINE + "\n";
const SHIP_COLUMN = JSON.stringify({
  attempts: 1,
  steps: { preflight: { status: "done", note: "PR #71 is open" }, settle: { status: "done", note: `closing the job: ${FROM_LINE}` } },
  data: { prNumber: 71, headBranch: "scratch/ship-qa-20260921201325", noticeLine: FROM_LINE },
});

// Seeds a job-57-shaped row straight into a throwaway home, the shape the incident left behind.
function seedJob57(env, { prUrl = FROM_URL, notice = NOTICE_BEFORE } = {}) {
  openDb(env)
    .prepare(
      `INSERT INTO jobs (id, project, prompt, status, pr_url, notice_md, ship_status, ship, branch, slug)
       VALUES (?, 'nightshift', 'ship a done job', 'closed', ?, ?, 'shipped', ?, 'worktree-feat+queue-ship', 'queue-ship')`,
    )
    .run(JOB_ID, prUrl, notice, SHIP_COLUMN);
}

// The raw row of job 57, every column.
function rowOf(env) {
  return { ...openDb(env).prepare("SELECT * FROM jobs WHERE id = ?").get(JOB_ID) };
}

// An output sink that records what the script prints.
function capture() {
  const out = [];
  const err = [];
  return { out, err, io: { log: (line) => out.push(line), error: (line) => err.push(line) } };
}

// The report the script prints for the row the incident left, before its changes.
function expectedHeader(env) {
  return [
    `job 57 in ${dbPath(env)}`,
    `  pr_url: ${FROM_URL}`,
    `  Shipped line: ${FROM_LINE}`,
    "  ship column (the true log of what the ship merged; printed, never written):",
    "    prNumber: 71",
    "    headBranch: scratch/ship-qa-20260921201325",
    `    noticeLine: ${FROM_LINE}`,
    "changes:",
    `  pr_url: ${FROM_URL} -> ${TO_URL}`,
    `  notice line: ${FROM_LINE} -> ${TO_LINE}`,
  ];
}

test("a dry run prints the row, the ship column and the two changes, and writes nothing", async (t) => {
  const env = makeHome(t, "repair-attr-dry");
  seedJob57(env);
  const before = rowOf(env);
  const { out, err, io } = capture();
  assert.equal(await main(["--job", "57"], env, io), 0);
  assert.deepEqual(out, [...expectedHeader(env), "dry run: nothing written; re-run with --apply to write these two changes."]);
  assert.deepEqual(err, []);
  assert.deepEqual(rowOf(env), before);
});

test("--apply changes exactly pr_url and the one Shipped line, and leaves the ship column byte-identical", async (t) => {
  const env = makeHome(t, "repair-attr-apply");
  seedJob57(env);
  const before = rowOf(env);
  const { out, io } = capture();
  assert.equal(await main(["--job", "57", "--apply"], env, io), 0);
  assert.deepEqual(out, [...expectedHeader(env), "applied: pr_url and the one notice line written; the ship column is untouched."]);
  const after = rowOf(env);
  assert.equal(after.pr_url, TO_URL);
  assert.equal(after.notice_md, before.notice_md.replace(FROM_LINE, () => TO_LINE));
  assert.equal(after.notice_md, "Delivered the ship command.\n\nPR: " + FROM_URL + "\n\n" + TO_LINE + "\n");
  assert.equal(after.ship, before.ship);
  assert.deepEqual({ ...after, pr_url: before.pr_url, notice_md: before.notice_md }, before);
});

test("a second --apply is a no-op that says there is nothing to do", async (t) => {
  const env = makeHome(t, "repair-attr-twice");
  seedJob57(env);
  assert.equal(await main(["--job", "57", "--apply"], env, capture().io), 0);
  const corrected = rowOf(env);
  const { out, err, io } = capture();
  assert.equal(await main(["--job", "57", "--apply"], env, io), 0);
  assert.equal(out.at(-1), "nothing to do: job 57 already records PR #72.");
  assert.deepEqual(err, []);
  assert.deepEqual(rowOf(env), corrected);
});

test("a row that is not the incident's is refused, printed and left untouched", async (t) => {
  const cases = [
    { name: "another pr_url", prUrl: "https://github.com/maykonVinicius/nightshift/pull/70" },
    { name: "no Shipped line", notice: "Delivered the ship command.\n" },
    { name: "the line twice", notice: `${FROM_LINE}\n\n${FROM_LINE}\n` },
    { name: "the line inside another line", notice: `note: ${FROM_LINE} (quoted)\n` },
  ];
  for (const { name, ...seed } of cases) {
    const env = makeHome(t, `repair-attr-refuse-${name.replaceAll(" ", "-")}`);
    seedJob57(env, seed);
    const before = rowOf(env);
    const { out, err, io } = capture();
    assert.equal(await main(["--job", "57", "--apply"], env, io), REFUSAL_EXIT, name);
    assert.equal(out[0], `job 57 in ${dbPath(env)}`, name);
    assert.match(err.join("\n"), /^refusing: job 57 does not hold the expected attribution/, name);
    assert.deepEqual(rowOf(env), before, name);
  }
});

test("a home without job 57 is refused and nothing is written", async (t) => {
  const env = makeHome(t, "repair-attr-missing");
  openDb(env);
  const { err, io } = capture();
  assert.equal(await main(["--job", "57", "--apply"], env, io), REFUSAL_EXIT);
  assert.match(err[0], /^refusing: job 57 is not in /);
  assert.equal(openDb(env).prepare("SELECT COUNT(*) AS total FROM jobs").get().total, 0);
});

test("a job other than 57 is refused before anything is opened", async (t) => {
  const env = makeHome(t, "repair-attr-other-job");
  await assert.rejects(main(["--job", "58"], env, capture().io), /only knows job 57/);
  await assert.rejects(main([], env, capture().io), /only knows job 57/);
});

test("the store's compare-and-swap refuses a moved URL, a missing line and a doubled line", async (t) => {
  const spec = { fromUrl: FROM_URL, toUrl: TO_URL, fromLine: FROM_LINE, toLine: TO_LINE };
  const cases = [
    { name: "moved url", seed: { prUrl: TO_URL } },
    { name: "missing line", seed: { notice: "nothing shipped\n" } },
    { name: "doubled line", seed: { notice: `${FROM_LINE}\n${FROM_LINE}\n` } },
  ];
  for (const { name, seed } of cases) {
    const env = makeHome(t, `repair-attr-cas-${name.replaceAll(" ", "-")}`);
    seedJob57(env, seed);
    const before = rowOf(env);
    assert.equal(await openStore(env).jobs.correctJobPrAttribution(JOB_ID, spec), false, name);
    assert.deepEqual(rowOf(env), before, name);
  }
});

test("a dry run on a database an older build wrote never migrates it", async (t) => {
  const env = makeHome(t, "repair-attr-older");
  seedJob57(env);
  const db = openDb(env);
  for (const column of ["ship_status", "ship", "ship_worker", "ship_lease_until"]) db.exec(`ALTER TABLE jobs DROP COLUMN ${column}`);
  db.exec("PRAGMA user_version = 14");
  closeDb(env);
  const { out, io } = capture();
  assert.equal(await main(["--job", "57"], env, io), 0);
  assert.equal(out.at(-1), "dry run: nothing written; re-run with --apply to write these two changes.");
  assert.ok(out.includes("    prNumber: (none)"));
  const readOnly = openDbReadOnly(env);
  t.after(() => readOnly.close());
  assert.equal(schemaVersionOn(readOnly), 14);
  const columns = readOnly.prepare("PRAGMA table_info(jobs)").all().map((column) => column.name);
  assert.equal(columns.includes("ship_status"), false);
});

test("the command line an operator types runs the dry run", (t) => {
  const env = makeHome(t, "repair-attr-cli");
  seedJob57(env);
  closeDb(env);
  const result = spawnSync(process.execPath, [SCRIPT, "--job", "57"], { env, encoding: "utf8", timeout: 30_000 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, [...expectedHeader(env), "dry run: nothing written; re-run with --apply to write these two changes."].join("\n") + "\n");
});
