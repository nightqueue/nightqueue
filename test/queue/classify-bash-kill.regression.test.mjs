import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { classifyJobResult } from "../../src/queue/classify.mjs";

const FIXTURE = fileURLToPath(new URL("./fixtures/job-42/attempt2-bash-kill-tail.jsonl", import.meta.url));

// Job #42's real attempt 2: a subagent ran `find <worktree> ...; find / -path "*plugin/agents/explore.md" | head -5`,
// the CLI backgrounded that Bash call and killed it at its wait ceiling - the bug the foreground hook now covers.
// The notice quotes the command's first 120 code points and closes with the hint that the hook should have run.
test("job #42's real attempt-2 tail: a killed Bash task classifies as failed, with the command and the hook hint", () => {
  const log = readFileSync(FIXTURE, "utf8");

  const outcome = classifyJobResult({ log, exitCode: 0 });

  assert.equal(outcome.status, "failed");
  assert.equal(
    outcome.noticeMd,
    'runtime: the CLI killed the background task "find ~/nightshift/.claude/worktrees/feat+decisions-adr-log -path "*agents/explore.md" 2>/dev/null; f..." after its wait ceiling; the run did not finish' +
      "; background Bash is kept in the foreground from this version; if you see this, the hook did not run",
  );
});
