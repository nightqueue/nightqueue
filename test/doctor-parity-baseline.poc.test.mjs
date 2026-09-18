import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

/**
 * H2 (05a-qa-analyst.md): the plan's own acceptance gate is a before/after `doctor --json` (and
 * friends) diff against the pre-refactor tree, run on the same throwaway home. This had never
 * actually been executed - only read about. This PoC builds the pre-refactor tree from `HEAD`
 * (the uncommitted working-tree diff under test IS the store-boundary refactor), runs `npm ci`
 * in it for real, and diffs a sequence of real CLI invocations against the current tree, modulo
 * only the temp paths that legitimately differ between two separate throwaway homes/projects.
 */

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const OWN_ENV_KEYS = [
  "NIGHTSHIFT_HOME",
  "NIGHTSHIFT_EMBED_DISABLED",
  "NIGHTSHIFT_EMBED_DEADLINE_MS",
  "NIGHTSHIFT_REFLECT",
  "NIGHTSHIFT_REFLECT_MODEL",
  "NIGHTSHIFT_CLAUDE_BIN",
  "NIGHTSHIFT_MODEL",
  "NIGHTSHIFT_SESSION_ID",
  "NIGHTSHIFT_JOB_ID",
  "NIGHTSHIFT_JOB_HOME",
  "NIGHTSHIFT_JOB_CLAUDE_DIR",
  "NIGHTSHIFT_NO_UPDATE_CHECK",
  "NIGHTSHIFT_NO_PR_CHECK",
];

// Exports the commit HEAD points to into a fresh directory - the pre-refactor tree, since the
// diff under test is this worktree's uncommitted changes.
function exportHeadTree(destDir) {
  const sha = execFileSync("git", ["-C", REPO_ROOT, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const archive = execFileSync("git", ["-C", REPO_ROOT, "archive", sha], { maxBuffer: 200 * 1024 * 1024 });
  const tar = spawnSync("tar", ["-x", "-C", destDir], { input: archive });
  assert.equal(tar.status, 0, `tar extraction of HEAD failed: ${tar.stderr}`);
  return sha;
}

// Installs real dependencies in the baseline tree and proves it reaches actual code, not
// `ERR_MODULE_NOT_FOUND` (lesson L265's trap).
function installBaseline(dir) {
  execFileSync("npm", ["ci"], { cwd: dir, stdio: "pipe", timeout: 120_000 });
}

// A throwaway `NIGHTSHIFT_HOME` for one CLI process, never the operator's real home.
function makeHome() {
  return join(mkdtempSync(join(tmpdir(), "nightshift-parity-home-")), "home");
}

// A throwaway git repository to register as a project - `project add` requires a real `.git`.
function makeProjectRepo() {
  const dir = mkdtempSync(join(tmpdir(), "nightshift-parity-proj-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "qa@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "qa"], { cwd: dir });
  writeFileSync(join(dir, "f.txt"), "hi\n");
  execFileSync("git", ["add", "f.txt"], { cwd: dir });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
  return dir;
}

// Runs one CLI invocation against a tree's `bin/nightshift.mjs`, capturing stdout/stderr/status
// the same way whether the process exits 0 or not.
function runCli(binDir, args, home) {
  const env = { ...process.env };
  for (const key of OWN_ENV_KEYS) delete env[key];
  env.NIGHTSHIFT_HOME = home;
  env.NIGHTSHIFT_NO_UPDATE_CHECK = "1";
  env.NIGHTSHIFT_NO_PR_CHECK = "1";
  const result = spawnSync(process.execPath, [join(binDir, "bin", "nightshift.mjs"), ...args], {
    encoding: "utf8",
    env,
    timeout: 20_000,
  });
  return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", status: result.status };
}

// Strips the substitutions that legitimately differ between two independent throwaway
// homes/projects (temp paths, including macOS's `/private` realpath prefix) - nothing else.
function normalize(text, substitutions) {
  let out = text;
  for (const [from, to] of substitutions) {
    out = out.split(from).join(to);
    out = out.split(`/private${from}`).join(to);
  }
  // The schema version is the one thing a tree is EXPECTED to raise over its baseline: every additive
  // migration bumps it on purpose, and pinning it here would turn each one into a parity failure.
  // The rate limit fields of `queue run --dry` are the other one: this tree answers WHICH reset a claim
  // would have to wait for, and a baseline that never read a pause cannot carry the two fields that say it.
  // So are its `cap` (no default ceiling since one job per runner) and `max` (the budget a baseline never reported).
  // The `hook PreToolUse` doctor check is the same kind of additive difference: a baseline exported before
  // the subagent-foreground hook landed never registers it, so it never reports the check either.
  // The last count key is `closed` since the `merged` status was retired, a rename a baseline before it cannot carry.
  return out
    .replace(/schema v\d+/g, "schema v<N>")
    .replace(/"cancelled":(\d+),"merged":/g, '"cancelled":$1,"closed":')
    .replace(/"pausedUntil":(?:null|"[^"]*"),"rateLimit":(?:null|\{[^{}]*\}),/g, "")
    .replace(/"cap":(?:null|\d+),(?:"max":(?:null|\d+),)?/g, "")
    .replace(/\{"name":"hook PreToolUse"[^{}]*\},?/g, "");
}

function assertParity(label, before, after, substitutionsBefore, substitutionsAfter) {
  const normBefore = normalize(before.stdout, substitutionsBefore);
  const normAfter = normalize(after.stdout, substitutionsAfter);
  assert.equal(normAfter, normBefore, `${label}: stdout diverged between pre-refactor and current tree`);
  assert.equal(after.status, before.status, `${label}: exit code diverged (before=${before.status}, after=${after.status})`);
}

test("doctor/queue/memory/org parity: pre-refactor tree vs current tree on fresh throwaway homes", { timeout: 180_000 }, (t) => {
  const baselineDir = mkdtempSync(join(tmpdir(), "nightshift-parity-baseline-"));
  t.after(() => rmSync(baselineDir, { recursive: true, force: true }));
  const sha = exportHeadTree(baselineDir);
  installBaseline(baselineDir);

  const homeBefore = makeHome();
  const homeAfter = makeHome();
  t.after(() => {
    rmSync(dirname(homeBefore), { recursive: true, force: true });
    rmSync(dirname(homeAfter), { recursive: true, force: true });
  });

  const subsBefore = [[homeBefore, "<HOME>"]];
  const subsAfter = [[homeAfter, "<HOME>"]];

  // Step 1: doctor --json on a home with no database yet.
  assertParity(
    "doctor --json (no db)",
    runCli(baselineDir, ["doctor", "--json"], homeBefore),
    runCli(REPO_ROOT, ["doctor", "--json"], homeAfter),
    subsBefore,
    subsAfter,
  );

  // Step 2: queue status on an empty queue.
  assertParity(
    "queue status (empty)",
    runCli(baselineDir, ["queue", "status"], homeBefore),
    runCli(REPO_ROOT, ["queue", "status"], homeAfter),
    subsBefore,
    subsAfter,
  );

  // Step 3: memory stats - this is also the step that creates nightshift.db in both homes.
  assertParity(
    "memory stats",
    runCli(baselineDir, ["memory", "stats"], homeBefore),
    runCli(REPO_ROOT, ["memory", "stats"], homeAfter),
    subsBefore,
    subsAfter,
  );

  // Step 4: doctor --json again, now that a database exists.
  assertParity(
    "doctor --json (with db)",
    runCli(baselineDir, ["doctor", "--json"], homeBefore),
    runCli(REPO_ROOT, ["doctor", "--json"], homeAfter),
    subsBefore,
    subsAfter,
  );

  // Step 5: project add + queue add + queue run --dry --json (the runner/claim code path,
  // without spawning a real, multi-minute `claude` pipeline invocation).
  const projBefore = makeProjectRepo();
  const projAfter = makeProjectRepo();
  t.after(() => {
    rmSync(projBefore, { recursive: true, force: true });
    rmSync(projAfter, { recursive: true, force: true });
  });
  const subsBefore5 = [...subsBefore, [projBefore, "<PROJ>"]];
  const subsAfter5 = [...subsAfter, [projAfter, "<PROJ>"]];

  assertParity(
    "project add",
    runCli(baselineDir, ["project", "add", projBefore, "--name", "qaparity"], homeBefore),
    runCli(REPO_ROOT, ["project", "add", projAfter, "--name", "qaparity"], homeAfter),
    subsBefore5,
    subsAfter5,
  );

  assertParity(
    "queue add",
    runCli(baselineDir, ["queue", "add", "qaparity", "echo hello (qa parity smoke test)"], homeBefore),
    runCli(REPO_ROOT, ["queue", "add", "qaparity", "echo hello (qa parity smoke test)"], homeAfter),
    subsBefore5,
    subsAfter5,
  );

  assertParity(
    "queue run --job 1 --dry --json",
    runCli(baselineDir, ["queue", "run", "--job", "1", "--dry", "--json"], homeBefore),
    runCli(REPO_ROOT, ["queue", "run", "--job", "1", "--dry", "--json"], homeAfter),
    subsBefore5,
    subsAfter5,
  );

  // Step 6: org rename (H1A's surface) and queue log --follow (H1B's surface), added because
  // the analyst flags the base scenario list alone does not exercise either.
  assertParity(
    "org rename default -> renamedorg",
    runCli(baselineDir, ["org", "rename", "default", "renamedorg"], homeBefore),
    runCli(REPO_ROOT, ["org", "rename", "default", "renamedorg"], homeAfter),
    subsBefore5,
    subsAfter5,
  );

  assertParity(
    "queue log 1 --follow (no log file yet)",
    runCli(baselineDir, ["queue", "log", "1", "--follow"], homeBefore),
    runCli(REPO_ROOT, ["queue", "log", "1", "--follow"], homeAfter),
    subsBefore5,
    subsAfter5,
  );

  assert.match(sha, /^[0-9a-f]{40}$/, "sanity: baseline was exported from a real commit sha");
});
