import assert from "node:assert/strict";
import { test } from "node:test";
import { DEPENDENT_PROMPT_REFUSAL, dependentPromptMatch } from "../../src/queue/dependent-prompt.mjs";

test("each documented phrase is found anywhere in the prompt, case-insensitively, and reported as written", () => {
  for (const [prompt, phrase] of [
    ["Add the export button after J-12.", "after J-12"],
    ["Start AFTER job j-7 is done", "AFTER job j-7"],
    ["Wire the column once PR #45 is merged into main.", "once PR #45 is merged"],
    ["Ship it once pull request #9 has been merged", "once pull request #9 has been merged"],
    ["do it once PR #3 gets merged", "once PR #3 gets merged"],
    ["This depends on J-3 for the schema.", "depends on J-3"],
    ["It depends on job 4's migration.", "depends on job"],
    ["Rename the flag when #88 lands.", "when #88 lands"],
    ["Rename the flag when PR #88\nlands.", "when PR #88 lands"],
  ]) {
    assert.equal(dependentPromptMatch(prompt), phrase, prompt);
  }
});

test("the first phrase of the text is the one reported", () => {
  assert.equal(dependentPromptMatch("when #2 lands, and only after J-1"), "when #2 lands");
});

test("a self-contained prompt, a bare reference or a tracker key never matches", () => {
  for (const prompt of [
    "Fix the crash reported in J-12.",
    "Follow up on ENG-123 after the review.",
    "Review PR #45 once it is open.",
    "After the refactor of the parser, rename the flag.",
    "the dependency on jobs is removed",
    "when #88 is ready",
    "",
    "   ",
    null,
  ]) {
    assert.equal(dependentPromptMatch(prompt), null, String(prompt));
  }
});

test("a phrase inside a fenced code block or a quoted comment thread never matches", () => {
  const fenced = "Fix the parser.\n\n```text\nthis runs after J-12\n```\n";
  const quoted = 'Fix the parser.\n<comment-thread author="ana">\nwe could do it once PR #4 is merged\n</comment-thread>\n';
  const unclosed = "Fix the parser.\n<comment-thread>\ndepends on J-3";
  assert.equal(dependentPromptMatch(fenced), null);
  assert.equal(dependentPromptMatch(quoted), null);
  assert.equal(dependentPromptMatch(unclosed), null);
  assert.equal(dependentPromptMatch(`${fenced}\nThen ship it after J-12.`), "after J-12");
});

test("the refusal carries the resolve skill's step 2.5 wording", () => {
  assert.equal(
    DEPENDENT_PROMPT_REFUSAL,
    "This brief depends on another job's pull request. A job must be self-contained: fold this work into that job (as a stage) or make it independent. Nothing was changed.",
  );
});
