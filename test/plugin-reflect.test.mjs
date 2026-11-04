import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { pluginDir } from "../src/queue/spawn.mjs";
import { phasePrompts } from "../test-support/skill-size.mjs";

const RUBRIC = readFileSync(join(pluginDir(), "skills/reflect/references/rubric.md"), "utf8").replace(/\s+/g, " ");
const SKILL_TEXT = readFileSync(join(pluginDir(), "skills/reflect/SKILL.md"), "utf8");
const SKILL = SKILL_TEXT.replace(/\s+/g, " ");

// The sentences of a whitespace-collapsed text that mention a word.
function sentencesWith(text, word) {
  return text.split(/(?<=[.:])\s+/).filter((sentence) => sentence.includes(word));
}

test("the rubric names the three kinds and the lesson fields", () => {
  for (const kind of ["`error`", "`correction`", "`decision`"]) assert.ok(RUBRIC.includes(kind), kind);
  for (const field of ["`title`", "`root_cause`", "`solution`", "`prevention`", "`target`", "`attempts`"]) {
    assert.ok(RUBRIC.includes(field), field);
  }
  assert.ok(RUBRIC.includes("`triager|architect|coder|qa|verifier`"));
});

test("the rubric saves a decision as a memory key/value under the one-sentence rule", () => {
  assert.ok(RUBRIC.includes("`key`") && RUBRIC.includes("`value`"));
  assert.ok(RUBRIC.includes("`memory_save`"));
  assert.ok(RUBRIC.includes("Each field is ONE short English sentence."));
});

test("the rubric recalls before proposing and re-saves a recurrence with the exact title", () => {
  assert.match(RUBRIC, /run `lesson_recall` with `query` = the candidate's title plus its prevention/);
  assert.ok(RUBRIC.includes("re-save it with that lesson's EXACT `title`"));
  assert.ok(RUBRIC.includes("`memory_recall`"));
  assert.ok(RUBRIC.includes("No candidate at all is a valid result."));
});

test("the rubric audits a QA skip: a later defect in the skipped area is a qa lesson, a skip that held saves nothing", () => {
  const section = RUBRIC.slice(RUBRIC.indexOf("## A QA skip"), RUBRIC.indexOf("## Dedup before proposing"));
  assert.ok(section.includes("`qaMode.mode` is `skip`"), section);
  assert.ok(section.includes("`source: qa-triage` round"), section);
  assert.match(section, /later defect in the skipped area .*`target: qa`/);
  assert.ok(section.includes("describes the misclassification"), section);
  assert.ok(section.includes("A skip that held is not a candidate: nothing is saved about it."), section);
});

test("the rubric names no decision tool: lessons and memories are its only outputs", () => {
  assert.equal(RUBRIC.includes("decision_save"), false);
  assert.equal(RUBRIC.includes("decision_update"), false);
});

test("the reflect skill is `reflect` and reads the rubric from its base directory", () => {
  assert.match(SKILL_TEXT, /^---\nname: reflect\n/);
  assert.ok(SKILL.includes("Read `references/rubric.md` from this skill's base directory."));
  assert.ok(SKILL.includes("/nightqueue:reflect"));
});

test("the reflect skill finds the project like the queue skill and registers only behind a yes", () => {
  assert.ok(SKILL.includes("`nightqueue project list --json`"));
  assert.ok(SKILL.includes("longest prefix of the current working directory"));
  const register = sentencesWith(SKILL, "`project_register`");
  assert.equal(register.length, 1, register.join(" | "));
  assert.match(register[0], /call it ONLY after an explicit yes/);
});

test("the reflect skill asks once, saves only confirmed candidates and reports the refs", () => {
  assert.ok(SKILL.includes("Ask once which ones to save. The default is none"));
  assert.ok(SKILL.includes("Save each confirmed candidate with `lesson_save` or `memory_save`"));
  assert.ok(SKILL.includes("Never save a candidate the person did not confirm."));
  assert.ok(SKILL.includes("`Saved: L<id>, M<id>, …`"));
});

test("the reflect skill documents that an interactive recurrence bumps attempts only, and names no decision tool", () => {
  assert.ok(SKILL.includes("In an interactive session a recurrence bumps the lesson's `attempts` only; the `violated` counter is bumped only inside a queued job"));
  assert.equal(SKILL.includes("decision_save"), false);
  assert.equal(SKILL.includes("decision_update"), false);
});

const AGENT_TEXT = readFileSync(join(pluginDir(), "agents/reflector.md"), "utf8");
const AGENT = AGENT_TEXT.replace(/\s+/g, " ");
const BLOCK = phasePrompts().blocks.reflector.join("\n").replace(/\s+/g, " ");

test("the reflector agent is granted exactly Read, the three lesson/memory tools and its run's context", () => {
  const tools = /^tools: (.+)$/m.exec(AGENT_TEXT)?.[1];
  assert.deepEqual(tools?.split(", "), ["Read", "mcp__nightqueue__lesson_recall", "mcp__nightqueue__lesson_save", "mcp__nightqueue__memory_save", "mcp__nightqueue__context_for_agent"]);
  assert.match(AGENT_TEXT, /^name: reflector$/m);
});

test("the reflector reads every round and fix loop, never the job's stream or log, and saves on its own", () => {
  assert.ok(AGENT.includes("Never read the job's raw stream or log file"));
  assert.ok(AGENT.includes("every `## Round`") && AGENT.includes("every `### Fix loop` block"));
  assert.ok(AGENT.includes("`termination`") && AGENT.includes("`answers`") && AGENT.includes("`lastClaim.attempt`"));
  assert.ok(AGENT.includes("Save on your own, without asking for confirmation"));
  assert.ok(AGENT.includes("EXACT `title`"));
  assert.equal(AGENT.includes("decision_save"), false);
});

test("the reflector's block has no artifact handoff and names the rubric, state.json and the rounds rule; its agent fetches the timeline", () => {
  assert.equal(BLOCK.includes("ARTIFACT_PATH"), false);
  assert.ok(BLOCK.includes("RUBRIC: <pluginRoot>/skills/reflect/references/rubric.md"));
  assert.ok(BLOCK.includes("state.json"));
  assert.ok(BLOCK.includes('`agent: "reflector"`') && AGENT.includes('`agent: "reflector"`'));
  assert.ok(AGENT.includes("`## Run timeline`"));
  assert.ok(AGENT.includes("`## Lessons given to this run`"));
  assert.ok(BLOCK.includes("Read every round and every fix-loop block; never the job's stream/log."));
});

test("the reflector's block names its run, its plugin root and its own return head", () => {
  const { blocks } = phasePrompts();
  for (const field of ["RUN_DIR: ", "PROJECT: ", "PLUGIN_ROOT: ", "RETURN-HEAD: REFLECTION: "]) {
    assert.ok(blocks.reflector.some((line) => line.startsWith(field)), `the reflector block lost ${field}`);
  }
});

test("the reflector's block reads qaMode and its agent points a QA skip to the rubric's rule", () => {
  assert.ok(BLOCK.includes("state.json — `termination`, `answers`, `lastClaim.attempt`, `qaMode`"), BLOCK);
  assert.ok(AGENT.includes("a QA skip follows the rubric's `## A QA skip`"), AGENT);
  assert.match(AGENT, /later defect in the skipped area is a lesson with `target: qa`, a skip that held saves nothing/);
});
