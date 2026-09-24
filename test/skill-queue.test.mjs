import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const SKILL = readFileSync(new URL("../plugin/skills/queue/SKILL.md", import.meta.url), "utf8");
const MAX_LINES = 80;

// Frontmatter block of the skill, the part the host reads to discover it.
function frontmatter(content) {
  const [, block] = content.split("---");
  return block ?? "";
}

test("the queue skill is discoverable: frontmatter, a description and a size a host reads in one go", () => {
  const head = frontmatter(SKILL);
  assert.match(head, /^\s*name: queue$/m);
  assert.match(head, /^\s*description: >-$/m);
  assert.ok(head.includes("/nightqueue:queue"), head);
  assert.ok(SKILL.split("\n").length < MAX_LINES, `the skill is ${SKILL.split("\n").length} lines, over the ${MAX_LINES} allowed`);
});

test("the queue skill carries the three cutting rules of a job", () => {
  assert.ok(
    SKILL.includes("One job is one self-contained deliverable that can be reviewed and merged on\n  its own."),
    SKILL,
  );
  assert.ok(SKILL.includes("Large work is ONE job with numbered stages written in the prompt"), SKILL);
  assert.ok(
    SKILL.includes("Never queue a job whose precondition is another job's pull request being\n  merged"),
    SKILL,
  );
});

test("the queue skill resolves the project by the longest registered path prefix, and asks ONE question in both forms", () => {
  assert.ok(SKILL.includes("nightqueue project list --json"), SKILL);
  assert.ok(SKILL.includes("longest prefix of the current working"), SKILL);
  assert.ok(SKILL.includes('`Queue "<title>" for <project> as <tier>? [Y/n]`'), SKILL);
  assert.ok(SKILL.includes('`Queue "<title>" for <cwd> (register as <name>) as <tier>? [Y/n]`'), SKILL);
  assert.equal(SKILL.includes("Register <cwd> as <name> and queue the job?"), false, "the old registration question survived");
  assert.ok(SKILL.includes("`register: true`"), SKILL);
  assert.ok(SKILL.includes("One question, never more."), SKILL);
  assert.equal(SKILL.includes("nightqueue project add <path>"), false, "the skill still sends the user to `project add`");
});

test("the queue skill proposes a tier the user can override in that same answer, and repeats it in the report", () => {
  assert.ok(SKILL.includes("`tier` is your reading of the risk"), SKILL);
  for (const tier of ["`trivial`", "`simple`", "`complex`"]) {
    assert.ok(SKILL.includes(tier), `${tier} is missing from the tier bullet`);
  }
  assert.ok(SKILL.includes("the pipeline may raise it with evidence, never lower it"), SKILL);
  assert.ok(SKILL.includes("an\n  answer naming another tier queues it with that tier"), SKILL);
  assert.ok(SKILL.includes("the job id `queue_add` returned and the `tier` it was queued as"), SKILL);
});

test("the queue skill only records the job, never starts it, and knows `queue_add` has no `run` parameter", () => {
  assert.ok(SKILL.includes("There is no `run` parameter"), SKILL);
  assert.ok(
    SKILL.includes("Never start the job. Only when the user explicitly asks for that one job now"),
    SKILL,
  );
  assert.ok(SKILL.includes("`queue_add` only records the job; it never runs it."), SKILL);
});

test("the queue skill asks for an English, self-contained prompt inside the size range", () => {
  assert.ok(SKILL.includes("Write it in English, between 20 and 10000 characters, self-contained"), SKILL);
  for (const part of ["the area affected", "the expected result", "the constraints", "how the result is verified"]) {
    assert.ok(SKILL.includes(part), `${part} is missing from the prompt checklist`);
  }
});
