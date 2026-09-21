import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyJobResult } from "../../src/queue/classify.mjs";
import { resultEvent, systemInitEvent, toNdjson, toolUseEvent } from "../../test-support/streams.mjs";

const TASK_ID = "bg_task";
const TOOL_USE_ID = "toolu_bash_kill";
const COMMAND = "node --test test/whatever.test.mjs";

const CEILING_LINE = "Background tasks still running after 600s; terminating. Set CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0 to wait indefinitely.";

// The `system` events of a killed Bash task: `task_started`, its listing and the kill itself; a settling result must be TERMINAL
// here (no state.json record and no notice-bearing result before it), so every case below only exercises the wording, never the status.
function killedBashEvents({ runInBackground = false, autoBackgrounded = false } = {}) {
  const events = [
    toolUseEvent({ id: TOOL_USE_ID, name: "Bash", input: { command: COMMAND, run_in_background: runInBackground } }),
    { type: "system", subtype: "task_started", task_id: TASK_ID, tool_use_id: TOOL_USE_ID, description: COMMAND, task_type: "local_bash" },
    { type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: TASK_ID, task_type: "local_bash", description: COMMAND }] },
  ];
  if (autoBackgrounded) events.push({ type: "system", subtype: "task_updated", task_id: TASK_ID, patch: { is_backgrounded: true } });
  events.push({ type: "system", subtype: "task_updated", task_id: TASK_ID, patch: { status: "killed" } });
  return events;
}

// A log whose last attempt kills the Bash task described above, with the ceiling line and the final result text given.
function killedBashStream({ ceiling = false, runInBackground = false, autoBackgrounded = false, resultText = "" } = {}) {
  const lines = [toNdjson([systemInitEvent(), ...killedBashEvents({ runInBackground, autoBackgrounded })]).trimEnd()];
  if (ceiling) lines.push(CEILING_LINE);
  lines.push(toNdjson([resultEvent({ text: resultText })]).trimEnd());
  return lines.join("\n");
}

test("the ceiling clause is said only when the raw ceiling line is in the log", () => {
  const withCeiling = classifyJobResult({ log: killedBashStream({ ceiling: true }), exitCode: 0 });
  assert.match(withCeiling.noticeMd, / after its wait ceiling/);

  const withoutCeiling = classifyJobResult({ log: killedBashStream({ ceiling: false }), exitCode: 0 });
  assert.doesNotMatch(withoutCeiling.noticeMd, / after its wait ceiling/);
});

test("the run_in_background hint is said only when the killed Bash call was launched with run_in_background: true", () => {
  const withHint = classifyJobResult({ log: killedBashStream({ ceiling: true, runInBackground: true }), exitCode: 0 });
  assert.match(withHint.noticeMd, /background Bash is kept in the foreground from this version; if you see this, the hook did not run/);

  const withoutHint = classifyJobResult({ log: killedBashStream({ ceiling: true, runInBackground: false }), exitCode: 0 });
  assert.doesNotMatch(withoutHint.noticeMd, /if you see this, the hook did not run/);
});

test("the auto-backgrounded wording replaces the hook hint when the Bash tool's own timeout moved the call to the background", () => {
  const outcome = classifyJobResult({ log: killedBashStream({ ceiling: true, autoBackgrounded: true }), exitCode: 0 });
  assert.match(outcome.noticeMd, /the Bash tool had moved this foreground command to the background after its own timeout/);
  assert.doesNotMatch(outcome.noticeMd, /if you see this, the hook did not run/);
});

test("`; the run did not finish` is said only when no result event carrying a `## Notice` follows the kill", () => {
  const noNotice = classifyJobResult({ log: killedBashStream({ ceiling: true, resultText: "Verifier running." }), exitCode: 0 });
  assert.match(noNotice.noticeMd, /; the run did not finish/);

  const withNotice = classifyJobResult({
    log: killedBashStream({ ceiling: true, resultText: "## Notice\n\nDone, the checks passed." }),
    exitCode: 0,
  });
  assert.doesNotMatch(withNotice.noticeMd, /; the run did not finish/);
});
