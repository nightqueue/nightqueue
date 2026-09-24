import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { classifyJobResult } from "../../src/queue/classify.mjs";

const FIXTURE = fileURLToPath(new URL("./fixtures/job-42/attempt2-bash-kill-tail.jsonl", import.meta.url));

// Job #42's real attempt 2: a subagent ran `find <worktree> ...; find / -path "*plugin/agents/explore.md" | head -5`,
// the CLI's Bash tool moved that foreground call to the background on its OWN 120s timeout, and the attempt's log ends right
// at the kill - no settling result ever followed it, so it is terminal: this stays a failure with the bug the hook now covers.
// The notice quotes the command's first 120 code points; there is no ceiling line here (the CLI never reached its own wait
// ceiling), so the wording says what the stream actually proves: the Bash tool's own timeout, not the CLI's.
test("job #42's real attempt-2 tail: a killed Bash task with no settling result classifies as failed, with the command and the auto-backgrounded hint", () => {
  const log = readFileSync(FIXTURE, "utf8");

  const outcome = classifyJobResult({ log, exitCode: 0 });

  assert.equal(outcome.status, "failed");
  assert.equal(
    outcome.noticeMd,
    'runtime: the CLI killed the background task "find ~/nightqueue/.claude/worktrees/feat+decisions-adr-log -path "*agents/explore.md" 2>/dev/null; find / -path "*plugin..."' +
      "; the run did not finish; the Bash tool had moved this foreground command to the background after its own timeout",
  );
});
