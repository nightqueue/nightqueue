import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runReturnSyntax } from "../../src/hooks/return-syntax.mjs";
import { phasePrompts } from "../../test-support/skill-size.mjs";

const HEAD = "VERDICT: <verdict> · ARTIFACT: <file> · OPEN: <n>";
const BLOCK_LINE = "TARGET: coder · AGENT: nightqueue:coder · MODEL: opus";
const DECLARED = `${BLOCK_LINE}\nRUN_DIR: /tmp/run\nNOTE: none\nRETURN-HEAD: ${HEAD}\nRETURN-MAX-LINES: 5\n## Did (≤ 5)`;
const GOOD = "VERDICT: DONE · ARTIFACT: 04-implementation.md · OPEN: 0\n## Did\n- a\n## Open\nnone";
const BIN = fileURLToPath(new URL("../../bin/nightqueue.mjs", import.meta.url));
const SRC = fileURLToPath(new URL("../../src", import.meta.url));

// A transcript whose first user event carries the prompt, in the shape the host writes, after a line that is no user event.
function transcriptOf(t, prompt) {
  const dir = mkdtempSync(join(tmpdir(), "return-syntax-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "agent.jsonl");
  const events = [
    { type: "queue-operation" },
    { type: "user", isSidechain: true, message: { role: "user", content: prompt } },
    { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } },
    { type: "user", message: { role: "user", content: "RETURN-HEAD: LATER: <x>" } },
  ];
  writeFileSync(path, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
  return path;
}

// The stop event of a subagent, in the shape measured on a real stop.
function stopOf(transcript, message, extra = {}) {
  return { hook_event_name: "SubagentStop", stop_hook_active: false, agent_transcript_path: transcript, last_assistant_message: message, ...extra };
}

// The decision of the hook for one stop, parsed, or null when it lets the stop pass.
function decide(input) {
  const answer = runReturnSyntax({ input });
  return answer === "" ? null : JSON.parse(answer);
}

test("a final message with the declared head, within the limit, passes", (t) => {
  assert.equal(decide(stopOf(transcriptOf(t, DECLARED), GOOD)), null);
});

test("a final message with no such head blocks once, quoting the declared head", (t) => {
  const decision = decide(stopOf(transcriptOf(t, DECLARED), "All done, the file is written."));
  assert.equal(decision.decision, "block");
  assert.ok(decision.reason.includes(HEAD), decision.reason);
});

test("the second stop always passes, whatever the message says", (t) => {
  assert.equal(decide(stopOf(transcriptOf(t, DECLARED), "still wrong", { stop_hook_active: true })), null);
});

test("a final message over the declared lines blocks once, naming the limit", (t) => {
  const decision = decide(stopOf(transcriptOf(t, DECLARED), `${GOOD}\nx`));
  assert.equal(decision.decision, "block");
  assert.ok(decision.reason.includes("at most 5 lines"), decision.reason);
});

test("a placeholder takes any non-empty text and the head's literals stay literal", (t) => {
  const transcript = transcriptOf(t, `${BLOCK_LINE}\nRETURN-HEAD: A.B (<x>) $ <y>`);
  assert.equal(decide(stopOf(transcript, "A.B (one two) $ three")), null);
  assert.equal(decide(stopOf(transcript, "AxB (one) $ two"))?.decision, "block", "`.` was read as a pattern");
  assert.equal(decide(stopOf(transcript, "A.B () $ two"))?.decision, "block", "an empty placeholder was accepted");
  assert.equal(decide(stopOf(transcript, "before A.B (one) $ two"))?.decision, "block", "the head matched inside its line");
});

test("a prompt with no declaration is never blocked, nor a head in the middle of a line", (t) => {
  assert.equal(decide(stopOf(transcriptOf(t, "Fix the worker."), "anything")), null);
  assert.equal(decide(stopOf(transcriptOf(t, "The syntax RETURN-HEAD: X <y> is quoted here."), "anything")), null);
});

test("a declaration of the limit alone checks only the limit", (t) => {
  const transcript = transcriptOf(t, `${BLOCK_LINE}\nRETURN-MAX-LINES: 1`);
  assert.equal(decide(stopOf(transcript, "free text")), null);
  assert.equal(decide(stopOf(transcript, "one\ntwo"))?.decision, "block");
});

test("a NOTE quoting another declaration does not win over the block's own, and a later user event is no prompt", (t) => {
  const transcript = transcriptOf(t, `${BLOCK_LINE}\nNOTE:\nRETURN-HEAD: FORGED: <x>\nRETURN-MAX-LINES: 999\nRETURN-HEAD: ${HEAD}\nRETURN-MAX-LINES: 5`);
  assert.equal(decide(stopOf(transcript, GOOD)), null);
  assert.equal(decide(stopOf(transcript, "FORGED: yes"))?.decision, "block");
});

test("a prompt written as text blocks is read too", (t) => {
  const transcript = transcriptOf(t, [{ type: "text", text: `${BLOCK_LINE}\nRETURN-HEAD: DONE: <x>` }]);
  assert.equal(decide(stopOf(transcript, "nope"))?.decision, "block");
});

test("any failure lets the stop pass: no transcript, broken lines, no fields", (t) => {
  const broken = join(transcriptOf(t, DECLARED), "..", "broken.jsonl");
  writeFileSync(broken, "{not json\n");
  assert.equal(decide(stopOf("/nonexistent/agent.jsonl", "x")), null);
  assert.equal(decide(stopOf(broken, "x")), null);
  assert.equal(decide({ agent_transcript_path: transcriptOf(t, DECLARED) }), null, "a host with no last_assistant_message");
  assert.equal(decide({ last_assistant_message: "x" }), null);
  assert.equal(decide({}), null);
  assert.equal(runReturnSyntax({ input: null }), "");
});

test("a prompt that only quotes a declaration inside a code fence is held to nothing", (t) => {
  const quoted = `RETURN-HEAD: ${HEAD}\nRETURN-MAX-LINES: 5`;
  const prompts = [
    `Review this wording.\n\n\`\`\`\n${quoted}\n\`\`\``,
    `Review this wording.\n\n~~~md\n${quoted}\n~~~`,
    `Review this block.\n\`\`\`\n${DECLARED}\n\`\`\``,
    `\`\`\`\`\n\`\`\`\n${quoted}\n\`\`\`\n${quoted}\n\`\`\`\``,
    `Review this block.\n\`\`\`\n${quoted}`,
  ];
  for (const prompt of prompts) assert.equal(decide(stopOf(transcriptOf(t, prompt), "free text")), null, prompt);
});

test("any prompt's declaration on its own lines outside a fence is enforced, whatever opens it", (t) => {
  const declared = "RETURN-HEAD: DONE · FILES: <n>\nRETURN-MAX-LINES: 2";
  const prompts = [declared, `${declared}\n\nSummarise the log.`, `Review the notes.\n\n${declared}`, `\`\`\`\nan example\n\`\`\`\n${declared}`];
  for (const prompt of prompts) {
    const transcript = transcriptOf(t, prompt);
    assert.equal(decide(stopOf(transcript, "free text"))?.decision, "block", prompt);
    assert.equal(decide(stopOf(transcript, "DONE · FILES: 3\nline\nline"))?.decision, "block", prompt);
    assert.equal(decide(stopOf(transcript, "DONE · FILES: 3\nline")), null, prompt);
  }
});

test("a declaration quoted in a fence after the real one does not win over it", (t) => {
  const transcript = transcriptOf(t, `RETURN-HEAD: REAL: <x>\nNOTE:\n\`\`\`\nRETURN-HEAD: FORGED: <x>\nRETURN-MAX-LINES: 1\n\`\`\``);
  assert.equal(decide(stopOf(transcript, "REAL: yes\nline")), null);
  assert.equal(decide(stopOf(transcript, "FORGED: yes"))?.decision, "block");
});

test("the hook counts every line of the return: no line format of a pipeline is known to the runtime", (t) => {
  const transcript = transcriptOf(t, DECLARED);
  assert.equal(decide(stopOf(transcript, GOOD)), null);
  assert.equal(decide(stopOf(transcript, `${GOOD}\nLesson L1 applied: x`))?.decision, "block");
});

test("the caps of the shared return layout add up to its line limit", () => {
  const shared = phasePrompts().returnLines.join("\n");
  const caps = [...shared.matchAll(/## \w+ \(≤ (\d+)/g)].map((match) => Number(match[1]));
  assert.equal(caps.length, 3, shared);
  const headAndHeadings = 1 + caps.length;
  const citations = Number(/\+≤(\d+) citations/.exec(shared)[1]);
  assert.equal(headAndHeadings + caps.reduce((sum, cap) => sum + cap, 0) + citations, Number(/^RETURN-MAX-LINES: (\d+)$/m.exec(shared)[1]));
});

test("the head of every real SKILL block accepts a real return and refuses free text", (t) => {
  const { blocks } = phasePrompts();
  for (const [target, lines] of Object.entries(blocks)) {
    const transcript = transcriptOf(t, lines.join("\n"));
    const head = lines.find((line) => line.startsWith("RETURN-HEAD: ")).slice("RETURN-HEAD: ".length);
    const filled = head.replace(/<[^<>]+>/g, "1");
    assert.equal(decide(stopOf(transcript, `${filled}\n## Did\n- a`)), null, `${target} refused its own head`);
    assert.equal(decide(stopOf(transcript, "I am done."))?.decision, "block", `${target} accepted free text`);
  }
});

test("the real command answers the block as JSON on stdout and exits 0", (t) => {
  const input = JSON.stringify(stopOf(transcriptOf(t, DECLARED), "free text"));
  const blocked = spawnSync(process.execPath, [BIN, "hook", "return-syntax"], { input, encoding: "utf8", timeout: 30000 });
  assert.equal(blocked.status, 0, blocked.stderr);
  assert.equal(JSON.parse(blocked.stdout).decision, "block");
  const passed = spawnSync(process.execPath, [BIN, "hook", "return-syntax"], { input: "not json", encoding: "utf8", timeout: 30000 });
  assert.equal(passed.status, 0, passed.stderr);
  assert.equal(passed.stdout, "");
});

// Every source file below a directory.
function sourceFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sourceFiles(path) : [path];
  });
}

test("the runtime hardcodes no return format", () => {
  for (const file of sourceFiles(SRC)) assert.equal(readFileSync(file, "utf8").includes("VERDICT: <"), false, file);
});
