import assert from "node:assert/strict";
import { test } from "node:test";
import { CLAUDE_COMMAND_NAMES, OPERATOR_MODE_AGENT, operatorArgs, operatorPrompt } from "../../src/host/operator.mjs";
import { makeHome } from "../../test-support/memory.mjs";

// The claude operands of an operator argv: whatever follows the `--settings <json>` pair.
function operands(args) {
  return args.slice(args.indexOf("--settings") + 2);
}

test("a prompt equal to a claude command name never reaches claude as that bare command, fresh or resumed", (t) => {
  const env = makeHome(t, "operator-prompt-command");
  for (const name of ["mcp", "update", "purge", "help", "plugins", "kill"]) {
    assert.ok(CLAUDE_COMMAND_NAMES.has(name), `${name} is missing from the claude command names`);
    const prompt = operatorPrompt(name, "usage");
    const fresh = operands(operatorArgs({ env, mode: OPERATOR_MODE_AGENT, prompt }));
    assert.deepEqual(fresh, [`${name} `]);
    const resumed = operands(operatorArgs({ env, mode: OPERATOR_MODE_AGENT, resumeSession: "abc-12345", prompt }));
    assert.deepEqual(resumed, ["--resume", "abc-12345", `${name} `]);
  }
});

test("any other prompt, one word included, goes to claude verbatim", (t) => {
  const env = makeHome(t, "operator-prompt-verbatim");
  for (const prompt of ["hi", "MCP", "mcp list", " mcp", "Analyse KEY-3: fix it"]) {
    assert.deepEqual(operands(operatorArgs({ env, mode: OPERATOR_MODE_AGENT, prompt })), [prompt]);
  }
});
