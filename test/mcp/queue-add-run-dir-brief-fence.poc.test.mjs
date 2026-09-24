import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { runDir } from "../../src/config/paths.mjs";
import { openDb } from "../../src/memory/db.mjs";
import { recordPhaseDone, recordRunFields } from "../../src/queue/run-state.mjs";
import { makeHome, makeProject } from "../../test-support/memory.mjs";

// H1 — `withPriorRun`'s duplicate-block check (`src/queue/operator-run.mjs:87-90`) scans every
// line of the prompt for the exact trimmed heading `## PRIOR RUN (operator)`, with no fence
// awareness — unlike `briefEnd` two functions below it, which tracks a ``` / ~~~ fence and skips
// heading detection inside one. A legitimate operator brief that merely QUOTES the block format
// inside a fenced code block (e.g. documenting/describing it, never actually carrying a real
// prior-run block) trips the same false "already carries a block" refusal a real duplicate would.

const CLI = fileURLToPath(new URL("../../bin/nightqueue.mjs", import.meta.url));
const SLUG = "hunt-the-notice";

// The Brief quotes the block heading inside a fenced code block — documentation, not a real duplicate block.
const PROMPT = [
  "## Brief",
  "queue status shows the same notice twice; for reference, the prior-run block looks like this:",
  "",
  "```",
  "## PRIOR RUN (operator)",
  "RUN_DIR: ~/some/other/run",
  "```",
  "",
  "## Stages",
  "1) fix it",
  "",
].join("\n");

// A temp home whose HOME and CLAUDE_CONFIG_DIR are temp too, with the project `alpha` and an operator run recorded into it.
function makeOperatorRun(t, name) {
  const base = makeHome(t, name);
  const env = { ...base, HOME: dirname(base.NIGHTQUEUE_HOME), CLAUDE_CONFIG_DIR: join(dirname(base.NIGHTQUEUE_HOME), ".claude") };
  makeProject(t, env, "alpha");
  recordRunFields({ project: "alpha", slug: SLUG, fields: { origin: "operator", type: "bug/error", evidenceLevel: 3 }, env });
  recordPhaseDone({ project: "alpha", slug: SLUG, phase: "triage", artifact: "01-triage.md", verdict: "PROCEED", env });
  return env;
}

// Connects a real stdio client to `nightqueue mcp`, closed at the end of the test.
async function connect(t, env) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [CLI, "mcp"], env, stderr: "pipe" });
  const client = new Client({ name: "nightqueue-tests", version: "0.0.0" });
  await client.connect(transport);
  t.after(() => client.close());
  return client;
}

// Plain text of a tool result.
function textOf(result) {
  return result.content.map((block) => block.text).join("\n");
}

// Every job row, oldest first.
function jobRows(env) {
  return openDb(env).prepare("SELECT id, slug, prompt FROM jobs ORDER BY id").all();
}

test("queue_add with run_dir succeeds when the Brief only QUOTES the prior-run heading inside a fenced code block", async (t) => {
  const env = makeOperatorRun(t, "queue-add-run-dir-brief-fence");
  const client = await connect(t, env);
  const dir = runDir("alpha", SLUG, env);

  const result = await client.callTool({ name: "queue_add", arguments: { project: "alpha", prompt: PROMPT, run_dir: dir } });

  assert.notEqual(result.isError, true, textOf(result));
  assert.equal(jobRows(env).length, 1, "the job was not created: the fenced quote was wrongly treated as a real duplicate block");
  assert.equal(jobRows(env)[0].slug, SLUG);
});
