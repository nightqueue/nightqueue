import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runDir } from "../../src/config/paths.mjs";
import { makeHome } from "../../test-support/memory.mjs";

// H2: `renameRunDir` (src/queue/resume.mjs) checks `existsSync(target)` and only then calls `renameSync` -
// a check-then-act gap. Its real callers are two DIFFERENT runner processes, each adopting the slug ITS
// OWN job's agent declared (`adoptSlug`, runner.mjs), which can race when two jobs' agents both print
// `SLUG: same-name TYPE: ...`. This PoC drives the real exported `renameRunDir` from two real `node`
// child processes, synchronized on a barrier file so both pass their own `existsSync` check as close to
// simultaneously as two independent OS processes can get - never a hand-interleaved call inside one process.

const WORKER = fileURLToPath(new URL("./fixtures/rename-run-dir-race-worker.mjs", import.meta.url));
const PROJECT = "alpha";
const ROUNDS = 20;

// Spawns one real OS process running the worker script; resolves with its stdout lines and exit code once it prints "ready".
function spawnRacer(from, to, barrierPath, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [WORKER, PROJECT, from, to, barrierPath], { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let readyResolve;
    const ready = new Promise((r) => {
      readyResolve = r;
    });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (stdout.includes("ready\n")) readyResolve();
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    const exited = new Promise((resolveExit) => {
      child.on("exit", (code) => resolveExit(code));
    });
    resolve({ ready, exited, getStdout: () => stdout, getStderr: () => stderr });
  });
}

// Runs one race round: two real processes both rename a distinct `from` onto the SAME `to`, released by one barrier.
async function runRound(t, round) {
  const env = makeHome(t, `rename-run-dir-race-${round}`);
  const to = `same-name-${round}`;
  const fromA = `job-a-provisional-${round}`;
  const fromB = `job-b-provisional-${round}`;
  const dirA = runDir(PROJECT, fromA, env);
  const dirB = runDir(PROJECT, fromB, env);
  mkdirSync(dirA, { recursive: true });
  mkdirSync(dirB, { recursive: true });
  writeFileSync(join(dirA, "state.json"), JSON.stringify({ marker: "A", schemaVersion: 1, slug: fromA, phases: [] }));
  writeFileSync(join(dirB, "state.json"), JSON.stringify({ marker: "B", schemaVersion: 1, slug: fromB, phases: [] }));

  const barrierDir = mkdtempSync(join(tmpdir(), "nightqueue-rename-race-"));
  const barrierPath = join(barrierDir, "go");
  t.after(() => rmSync(barrierDir, { recursive: true, force: true }));

  const racerA = await spawnRacer(fromA, to, barrierPath, env);
  const racerB = await spawnRacer(fromB, to, barrierPath, env);
  await Promise.all([racerA.ready, racerB.ready]);
  writeFileSync(barrierPath, "go");

  const [codeA, codeB] = await Promise.all([racerA.exited, racerB.exited]);
  assert.equal(codeA, 0, `round ${round}: racer A crashed (stderr: ${racerA.getStderr()})`);
  assert.equal(codeB, 0, `round ${round}: racer B crashed (stderr: ${racerB.getStderr()})`);

  const resultA = JSON.parse(racerA.getStdout().split("\n").filter(Boolean)[1]);
  const resultB = JSON.parse(racerB.getStdout().split("\n").filter(Boolean)[1]);
  return { env, to, fromA, fromB, dirA, dirB, resultA, resultB };
}

test("two runners racing to adopt the SAME slug never both rename and never corrupt the loser's directory", async (t) => {
  for (let round = 1; round <= ROUNDS; round += 1) {
    const { env, to, dirA, dirB, resultA, resultB } = await runRound(t, round);
    const statuses = [resultA.status, resultB.status].sort();

    assert.deepEqual(
      statuses,
      ["kept", "renamed"],
      `round ${round}: expected exactly one racer to rename and the other to be refused, got A=${resultA.status} B=${resultB.status}`,
    );

    const winnerDir = runDir(PROJECT, to, env);
    const winnerState = JSON.parse(readFileSync(join(winnerDir, "state.json"), "utf8"));
    assert.ok(
      winnerState.marker === "A" || winnerState.marker === "B",
      `round ${round}: the target directory does not hold a clean single-writer state.json - got ${JSON.stringify(winnerState)}`,
    );

    const loserDir = resultA.status === "kept" ? dirA : dirB;
    const loserMarker = resultA.status === "kept" ? "A" : "B";
    assert.equal(existsSync(loserDir), true, `round ${round}: the loser's original run directory was removed instead of kept`);
    const loserState = JSON.parse(readFileSync(join(loserDir, "state.json"), "utf8"));
    assert.equal(
      loserState.marker,
      loserMarker,
      `round ${round}: the loser's own state.json was mutated by the race (expected marker ${loserMarker})`,
    );
  }
});
