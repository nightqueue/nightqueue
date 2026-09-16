import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runDir } from "../../src/config/paths.mjs";
import { makeHome } from "../../test-support/memory.mjs";

// H1: `record()` (src/queue/run-state.mjs) is a plain synchronous read-modify-write of the WHOLE
// state.json, with no lock. Its two real writers run in two different OS processes: the agent's MCP
// `run_phase_done` handler (tools.mjs) and the queue-runner's fire-and-forget fact capture
// (runner.mjs `captureFacts` -> `persistTierRaise` -> `recordRunFields`). This PoC drives the exact
// same exported functions those two real callers drive, from two real `node` child processes racing
// against the SAME state.json - never a hand-interleaved read/write inside one process.

const WORKER = fileURLToPath(new URL("./fixtures/run-state-race-worker.mjs", import.meta.url));
const RUN = { project: "alpha", slug: "fix-the-worker" };
const COUNT = 400;
const RACE_ATTEMPTS = 5;

// Spawns one real OS process running the worker script for the given writer role; resolves once it exits.
function spawnWriter(role, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [WORKER, role, RUN.project, RUN.slug, String(COUNT)], {
      env,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("exit", (code) => resolve({ code, stderr }));
  });
}

// Reads the state.json a race round left behind.
function readState(env) {
  return JSON.parse(readFileSync(join(runDir(RUN.project, RUN.slug, env), "state.json"), "utf8"));
}

test("the agent's phase writes and the runner's tier writes both survive a real two-process race", async (t) => {
  for (let attempt = 1; attempt <= RACE_ATTEMPTS; attempt += 1) {
    const env = makeHome(t, `run-state-race-${attempt}`);

    const [phases, fields] = await Promise.all([spawnWriter("phases", env), spawnWriter("fields", env)]);
    assert.equal(phases.code, 0, `attempt ${attempt}: the phases writer crashed (stderr: ${phases.stderr})`);
    assert.equal(fields.code, 0, `attempt ${attempt}: the fields writer crashed (stderr: ${fields.stderr})`);

    const state = readState(env);
    assert.equal(
      state.phases.length,
      COUNT,
      `attempt ${attempt}: only ${state.phases.length}/${COUNT} of the agent's \`run_phase_done\` appends survived - the runner's concurrent tier write clobbered the rest (lost update)`,
    );
    assert.equal(
      state.tierRaiseReason,
      `runner-${COUNT - 1}`,
      `attempt ${attempt}: the runner's own last tier write (\`runner-${COUNT - 1}\`) did not survive either - got \`${state.tierRaiseReason}\``,
    );
  }
});
