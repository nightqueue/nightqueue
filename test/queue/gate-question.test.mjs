import assert from "node:assert/strict";
import { test } from "node:test";
import { gateQuestion, labelBlock, nestQuestionHeading, openQuestion, plainQuestion, questionDigest, saysNothing, unreadableQuestion } from "../../src/queue/gate-question.mjs";

const planWith = (body, heading = "## Requires user confirmation") => `## Implementation plan\n- x\n\n${heading}\n${body}\n\n## Assumptions\n- none\n`;

test("a placeholder or absent question reads as no question", () => {
  for (const value of ["", "None", "none.", "**None**", "`n/a`", "TBD", "TBD.", "todo", "-", "—", "...", "…", "<one concrete question>", "[the question]"]) {
    assert.equal(gateQuestion(planWith(`**Question:** ${value}`)), null, value);
  }
  assert.equal(gateQuestion("## Implementation plan\n- x\n"), null, "no section");
  assert.equal(gateQuestion(planWith("```md\n**Question:** approve?\n```")), null, "a fenced label");
  assert.equal(gateQuestion(`<!-- ${planWith("**Question:** approve?")} -->`), null, "a commented-out section");
  assert.equal(gateQuestion(`\`\`\`md\n${planWith("**Question:** approve?")}\`\`\`\n`), null, "a fenced section");
});

test("a filled question is read in every shape the plan may write it", () => {
  const shapes = [
    ["**Question:** approve the retry path?", "approve the retry path?"],
    ["- **Question:** approve the retry path?\n- **Options:** (A), (B)", "approve the retry path?"],
    ["**Question:**\napprove the retry path?\n\n**Options:** (A)", "approve the retry path?"],
    ["**Question:**\n\n- approve the retry path?\n\n**Options**: (A)", "approve the retry path?"],
    ["**Question:** approve the\nretry path?\n\n1. **Option A:** retry", "approve the retry path?"],
    ["**Question:** approve the retry path?\n### Detail\nmore", "approve the retry path?"],
    ["**Question:** approve the *n/a* path?", "approve the *n/a* path?"],
  ];
  for (const [body, expected] of shapes) assert.equal(gateQuestion(planWith(body)), expected, body);
  assert.equal(gateQuestion(planWith("**Question:** approve?", "### Requires user confirmation")), "approve?");
  assert.equal(gateQuestion(planWith("**Question:** approve?", "# requires USER confirmation")), "approve?");
});

test("a value that says nothing in another spelling reads as no question", () => {
  for (const value of ["None needed", "none required", "(none)", "No question", "no questions.", "nothing to ask", "N/A - decided above", "n/a — decided", "ｎｏｎｅ", "no​ne", "n/a­", "TBD: later", "None needed unless the column is dropped"]) {
    assert.equal(gateQuestion(planWith(`**Question:** ${value}`)), null, value);
  }
});

test("a value with a question mark is a question, whatever it opens with or is wrapped in", () => {
  const values = ["None needed?", "N/A or keep it?", "[Drop the column?]", "<Drop the column?>", "(keep the column?)"];
  for (const value of values) assert.equal(gateQuestion(planWith(`**Question:** ${value}`)), value, value);
});

test("a filled label with no question mark never pauses: its author is relaunched", () => {
  const values = ["No confirmation needed", "Not needed", "Nothing to decide", "Confirmation is not needed", "Keep the column or drop it", "[Option A] or [Option B]", "<retry path> or <column drop>", "(keep the column)", "nothingness wins"];
  for (const value of values) {
    const plan = planWith(`**Question:** ${value}`);
    assert.equal(gateQuestion(plan), null, value);
    assert.equal(unreadableQuestion(plan), true, value);
  }
});

test("a question mark with no word around it asks nothing", () => {
  for (const value of ["?", "???", "[?]", "<?>"]) {
    const plan = planWith(`**Question:** ${value}`);
    assert.equal(gateQuestion(plan), null, value);
    assert.equal(unreadableQuestion(plan), false, value);
  }
});

test("saysNothing tells an unfilled value from a filled one", () => {
  for (const value of ["", " none", "n/a", "-", "<what>", "[what]", "None needed", "(none)"]) assert.equal(saysNothing(value), true, value);
  for (const value of ["the login test fails", "no tests pass", "None?", "[a] or [b]"]) assert.equal(saysNothing(value), false, value);
});

test("an options table reads the row under a header whose cell asks nothing", () => {
  const table = "| Question | Options |\n| --- | --- |\n| Drop the column? | keep / drop |";
  assert.equal(gateQuestion(planWith(table)), "Drop the column?");
  assert.equal(gateQuestion(planWith("| Question | Options |\n| --- | --- |")), null, "a header with no row");
  assert.equal(unreadableQuestion(planWith("| Question | Options |\n| --- | --- |")), true, "a header with no row");
  assert.equal(unreadableQuestion(planWith("| Question | Options |\n| --- | --- |\n| Drop the column | keep |")), true, "a row that asks nothing");
});

test("a level-2 question heading right under the section stays in it, and only there", () => {
  assert.equal(gateQuestion(planWith("## Question\napprove?\n\n## Options\n- keep")), "approve?");
  assert.equal(gateQuestion(planWith("## Question:\napprove?")), "approve?");
  const later = "## Requires user confirmation\nnone\n\n## Implementation plan\n- x\n\n## Question\napprove?\n";
  assert.equal(gateQuestion(later), null, "a later section is not the confirmation section");
  assert.equal(nestQuestionHeading("## Question\n## Questions\n## Other\n"), "### Question\n## Questions\n## Other\n");
});

test("every label shape reads the question, and a blank table cell is no label", () => {
  const shapes = [
    ["**Question**: approve?", "approve?"],
    ["**Question :** approve?", "approve?"],
    ["__Question:__ approve?", "approve?"],
    ["**QUESTION:** approve?", "approve?"],
    ["Question: approve?", "approve?"],
    ["- Question: approve?", "approve?"],
    ["### Question\napprove?\n\n**Note:** ignored", "approve?"],
    ["### Question:\napprove?", "approve?"],
    ["| Question | approve? |\n| --- | --- |", "approve?"],
    ["| **Question:** | approve? |", "approve?"],
  ];
  for (const [body, expected] of shapes) assert.equal(gateQuestion(planWith(body)), expected, body);
  assert.equal(gateQuestion(planWith("| Question |  |\n| --- | --- |")), null, "a blank cell");
  assert.equal(gateQuestion(planWith("Some Question: approve?")), null, "a bare label not at the line start");
  assert.equal(gateQuestion(planWith("### Question of scope\napprove?")), null, "a heading with a longer title");
});

test("a section with no label is unreadable only when it asks", () => {
  for (const body of ["**Question for you:** approve?", "Which one is it?", "- Keep the column or drop it?", "| Question |  |\n| --- | --- |\n| approve? | |"]) {
    assert.equal(unreadableQuestion(planWith(body)), true, body);
  }
  for (const body of ["", "None", "- none", "n/a", "**Question:**", "**Question:** none", "Question: approve?", "```md\nanything?\n```", "- a trade-off.", "| Question |  |", "No confirmation needed.", "**Answered:** keep the column", "**Decision:** keep the old column"]) {
    assert.equal(unreadableQuestion(planWith(body)), false, body);
  }
  assert.equal(unreadableQuestion("## Implementation plan\n- x\n"), false, "no section");
});

test("a label whose own value says nothing is no question, whatever prose follows it", () => {
  const prose = "Why was this not needed? The ticket settles it.";
  const bodies = ["none", "n/a", "[one concrete question]", "TBD"].flatMap((value) => [`**Question:** ${value}\n${prose}`, `**Question:** ${value}\n\n${prose}`, `**Question:**\n${value}\n${prose}`, `### Question\n${value}\n\n${prose}`]);
  for (const body of [...bodies, "**Question:** none\nThe ticket settles it."]) {
    assert.equal(gateQuestion(planWith(body)), null, body);
    assert.equal(unreadableQuestion(planWith(body)), false, body);
  }
  assert.equal(gateQuestion(planWith(`**Question:** Keep the column?\n${prose}`)), `Keep the column? ${prose}`);
  assert.equal(gateQuestion(planWith("**Question:**\n\nKeep the column?")), "Keep the column?", "an empty value with the question below");
});

test("a labelled answer trace quoting the question is not an unreadable question", () => {
  const traces = ["**Decision:** keep the old column (asked: drop it?)", "**Answered:** Q: drop the column? A: keep", "**Answer:** keep; the question was drop it?", "- **Decision**: keep (drop it?)", "__Answered:__ keep (drop it?)", "**Decision:** keep\n(asked: drop it?)"];
  for (const body of traces) assert.equal(unreadableQuestion(planWith(body)), false, body);
  const asks = ["**Decision:** keep\n\nWhich one is it?", "**Decision:** keep\n**Next:** which one is it?", "Which one is it?\n\n**Decision:** keep", "**Decision for you:** keep it?"];
  for (const body of asks) assert.equal(unreadableQuestion(planWith(body)), true, body);
});

test("a question mark inside a code span or a URL of a nothing statement asks nothing", () => {
  for (const value of ["None, see https://example.com/page?id=3", "None; `a?.b` is unchanged", "None; ``a?.b`` is unchanged", "N/A - see HTTP://example.com/?x=1"]) {
    assert.equal(gateQuestion(planWith(`**Question:** ${value}`)), null, value);
    assert.equal(unreadableQuestion(planWith(`**Question:** ${value}`)), false, value);
    assert.equal(saysNothing(value), true, value);
  }
  const questions = ["None?", "None; `a?.b` is unchanged?", "None, see https://example.com/page?", "`None needed?`", "Keep the column at https://example.com/page?id=3 or drop it?", "Is `a?.b` kept?"];
  for (const value of questions) assert.equal(gateQuestion(planWith(`**Question:** ${value}`)), value, value);
});

test("a question is open until the run records a pause on it", () => {
  const plan = planWith("**Question:** approve?");
  assert.equal(openQuestion(plan, {}), true);
  assert.equal(openQuestion(plan, undefined), true);
  assert.equal(openQuestion(plan, { gateQuestionDigest: questionDigest("another?") }), true);
  assert.equal(openQuestion(plan, { gateQuestionDigest: questionDigest("approve?") }), false);
  assert.equal(openQuestion(planWith("**Question:** none"), {}), false);
});

test("the plain form flattens a text's lines the way a question is flattened", () => {
  assert.equal(plainQuestion("- Keep **the**\n- `column`?\n"), "keep the column?");
  assert.equal(plainQuestion(undefined), "");
});

test("the digest ignores reformatting and invisible characters and tells a different question apart", () => {
  assert.equal(questionDigest("approve​ the retry path?"), questionDigest("approve the retry path?"));
  const digest = questionDigest("Approve the retry path?");
  assert.match(digest, /^[0-9a-f]{64}$/);
  for (const same of ["approve the retry path?", "  APPROVE   the\nretry path? ", "**Approve** the `retry` path?", "Approve the retry path?", "Approve the _retry_ path?", "Approve the “retry” path?", "Approve the retry path ?", "Approve the retry path?.", "Approve the\\\nretry path?"]) {
    assert.equal(questionDigest(same), digest, same);
  }
  assert.notEqual(questionDigest("Approve every path?"), digest);
  assert.notEqual(questionDigest("Keep the old column, or drop it?"), questionDigest("Drop the old column, or keep it?"));
});

test("a label block runs from the label to the next bold label, and is null without the label", () => {
  assert.deepEqual(labelBlock(["a", "**L:** b", "- c", "**M:** d"], "**L:**"), [" b", "- c"]);
  assert.equal(labelBlock(["a"], "**L:**"), null);
});
