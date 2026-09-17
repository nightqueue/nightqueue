import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { classifyJobResult } from "../../src/queue/classify.mjs";

const FIXTURE = fileURLToPath(new URL("./fixtures/job-28-tail.jsonl", import.meta.url));

// Job #28's exact last 12 lines: the CLI's own 600s wait ceiling killed a background verifier
// task, printed the raw (non-JSON) ceiling line and exited 0 with an unrelated final `result`
// text ("Verifier running. Waiting for its verdict..."). On `main` this classifies as `gate`
// because that final text alone satisfies the old `reason ? "gate" : "failed"` rule; this test
// locks the fix: a runtime kill is always a failure, never a gate.
test("job #28's real tail: a run the CLI killed after its wait ceiling classifies as failed, not gate", () => {
  const log = readFileSync(FIXTURE, "utf8");

  const outcome = classifyJobResult({ log, exitCode: 0 });

  assert.equal(outcome.status, "failed");
  assert.equal(
    outcome.noticeMd,
    'runtime: the CLI killed the background task "a87e429d64f2ca0fd" after its wait ceiling; the run did not finish',
  );
});
