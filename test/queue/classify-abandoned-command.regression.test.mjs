import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { classifyJobResult } from "../../src/queue/classify.mjs";
import { extractNotice, extractResultText } from "../../src/queue/stream.mjs";

const FIXTURE = fileURLToPath(new URL("./fixtures/job-49/attempt1-abandoned-command-tail.jsonl", import.meta.url));

// Job #49's real attempt 1, trimmed: a subagent's foreground `node --test ... | tail -150` was moved to the background by
// the Bash tool's own 120s timeout, later killed by the CLI - but the run went on for hundreds more lines, opened PR #65
// and ended with a `result` event whose text carries the run's own `## Notice` starting "✅ Delivered". On `main` this
// classified as `failed` with a fixed, false notice ("the hook did not run") and the run's real notice was lost; this
// test locks the fix: a kill that did not end the run is never a failure, and the abandoned command is never hidden.
test("job #49's real attempt-1 tail: a kill that did not end the run stays done, with its PR and its own notice kept, and the abandoned command appended", () => {
  const log = readFileSync(FIXTURE, "utf8");
  const runNotice = extractNotice(extractResultText(log));

  const outcome = classifyJobResult({ log, exitCode: 0 });

  assert.equal(outcome.status, "done");
  assert.equal(outcome.prUrl, "https://github.com/nightqueue/nightqueue/pull/65");
  assert.ok(outcome.noticeMd.startsWith(runNotice), "the run's own whole notice was not kept in front of the abandoned-command line");
  assert.ok(
    outcome.noticeMd.endsWith("⚠️ a command was abandoned mid-run: node --test test/queue/window-run.test.mjs 2>&1 | tail -150"),
    "the abandoned-command line was not appended, or was truncated wrong",
  );
});
