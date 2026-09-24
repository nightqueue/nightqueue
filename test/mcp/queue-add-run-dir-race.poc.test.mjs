// H2 (05a-qa-analyst.md, tier-complex-set-by-the-operator) — TOCTOU race on `queue_add run_dir`'s
// duplicate-binding check. `operatorRunSeed` (src/mcp/tools.mjs:348) reads `jobs.openJobForRun`
// then, back in the `queue_add` handler (src/mcp/tools.mjs:791), calls `jobs.addJob` — the read and
// the write are two separate DB statements, not one transaction, and nothing in
// `src/memory/jobs.mjs`/`src/memory/db.mjs` enforces `UNIQUE(project, slug)`. Two `queue_add`
// calls for the SAME `run_dir` fired without serializing the awaits can both pass the "not already
// bound" check before either insert lands, binding two open jobs to one run.
//
// Connects an MCP client and the real tool server via an in-memory transport IN THIS TEST PROCESS
// (not a subprocess) so both `queue_add` calls run against the same `openStore(env)` handle and the
// same Node event loop the handler itself uses — a subprocess would only add unrelated I/O jitter,
// not the race itself, which lives entirely in the `await` boundary of `operatorRunSeed`.
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { runDir } from "../../src/config/paths.mjs";
import { openDb } from "../../src/memory/db.mjs";
import { createServer } from "../../src/mcp/tools.mjs";
import { recordPhaseDone, recordRunFields } from "../../src/queue/run-state.mjs";
import { makeHome, makeProject } from "../../test-support/memory.mjs";

const SLUG = "hunt-the-notice";
const PROMPT = "## Brief\nqueue status shows the same notice twice\n\n## Stages\n1) fix it\n";

// A temp home (standing decision #7: never the real `~/.nightqueue`) with the project `alpha` and
// an operator run recorded into it, eligible to seed a job via `run_dir`.
function makeOperatorRun(t, name) {
  const base = makeHome(t, name);
  const env = { ...base, HOME: dirname(base.NIGHTQUEUE_HOME), CLAUDE_CONFIG_DIR: join(dirname(base.NIGHTQUEUE_HOME), ".claude") };
  makeProject(t, env, "alpha");
  recordRunFields({ project: "alpha", slug: SLUG, fields: { origin: "operator", type: "bug/error", evidenceLevel: 3 }, env });
  recordPhaseDone({ project: "alpha", slug: SLUG, phase: "triage", artifact: "01-triage.md", verdict: "PROCEED", env });
  return env;
}

// The real tool server and a client wired together in-process, so both `queue_add` calls share the
// exact `openStore(env)` handle the handler opens — no subprocess, no stdio framing in between.
async function connectInProcess(t, env) {
  const server = createServer(env);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "nightqueue-tests-race", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  t.after(async () => {
    await client.close();
    await server.close();
  });
  return client;
}

// Every open (not `closed`) job bound to this run's slug.
function boundJobs(env) {
  return openDb(env).prepare("SELECT id, status FROM jobs WHERE project = ? AND slug = ? AND status <> 'closed'").all("alpha", SLUG);
}

test("two concurrent queue_add(run_dir) calls for the same run must not both bind a job to it", async (t) => {
  const env = makeOperatorRun(t, "queue-add-run-dir-race");
  const client = await connectInProcess(t, env);
  const dir = runDir("alpha", SLUG, env);

  // Fired WITHOUT awaiting the first call before starting the second: both requests land on the
  // server before either's `operatorRunSeed` resolves its `await jobs.openJobForRun(...)`, so both
  // read "not bound yet" before either write happens.
  const callA = client.callTool({ name: "queue_add", arguments: { project: "alpha", prompt: PROMPT, run_dir: dir } });
  const callB = client.callTool({ name: "queue_add", arguments: { project: "alpha", prompt: PROMPT, run_dir: dir } });
  await Promise.all([callA, callB]);

  // Correct behavior from the operator's point of view: a run can only ever back ONE open job —
  // that is the whole point of the "already runs from" refusal `operatorRunSeed` performs serially.
  // A second bound job means two agents will independently resume into and write the same run
  // directory / `state.json`, which is exactly the state-corruption scenario the refusal exists to
  // prevent.
  const bound = boundJobs(env);
  assert.equal(bound.length, 1, `expected exactly one job bound to run ${dir}, got ${bound.length}: ${JSON.stringify(bound)}`);
});
