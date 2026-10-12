import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { pluginDir } from "../src/queue/spawn.mjs";

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

test("the rubric names decision_save only inside the NEVER sentence", () => {
  const sentences = sentencesWith(RUBRIC, "decision_save");
  assert.equal(sentences.length, 1, sentences.join(" | "));
  assert.match(sentences[0], /NEVER saved with `decision_save` or `decision_update`/);
  for (const sentence of sentencesWith(RUBRIC, "decision_update")) assert.ok(sentence.includes("NEVER"), sentence);
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

test("the reflect skill documents that an interactive recurrence bumps attempts only, and never writes a decision", () => {
  assert.ok(SKILL.includes("In an interactive session a recurrence bumps the lesson's `attempts` only; the `violated` counter is bumped only inside a queued job"));
  assert.equal(SKILL.includes("decision_save"), false);
  assert.equal(SKILL.includes("decision_update"), false);
});

const AGENT_TEXT = readFileSync(join(pluginDir(), "agents/reflector.md"), "utf8");
const AGENT = AGENT_TEXT.replace(/\s+/g, " ");
const TEMPLATE = readFileSync(join(pluginDir(), "skills/resolve/references/prompts/reflector.md"), "utf8");

test("the reflector agent is granted exactly Read and the three lesson/memory tools", () => {
  const tools = /^tools: (.+)$/m.exec(AGENT_TEXT)?.[1];
  assert.deepEqual(tools?.split(", "), ["Read", "mcp__nightqueue__lesson_recall", "mcp__nightqueue__lesson_save", "mcp__nightqueue__memory_save"]);
  assert.match(AGENT_TEXT, /^name: reflector$/m);
});

test("the reflector reads every round and fix loop, never the job's stream or log, and saves on its own", () => {
  assert.ok(AGENT.includes("Never read the job's raw stream or log file"));
  assert.ok(AGENT.includes("every `## Round`") && AGENT.includes("every `### Fix loop` block"));
  assert.ok(AGENT.includes("`termination`") && AGENT.includes("`resumeCount`"));
  assert.ok(AGENT.includes("Save on your own, without asking for confirmation"));
  assert.ok(AGENT.includes("EXACT `title`"));
  assert.equal(AGENT.includes("decision_save"), false);
});

test("the reflector template has no artifact handoff and names the rubric, state.json, the timeline and the rounds rule", () => {
  assert.equal(TEMPLATE.includes("{{>_handoff}}"), false);
  assert.equal(TEMPLATE.includes("ARTIFACT_PATH"), false);
  assert.ok(TEMPLATE.includes("RUBRIC: {{PLUGIN_ROOT}}/skills/reflect/references/rubric.md"));
  assert.ok(TEMPLATE.includes("`state.json`"));
  assert.ok(TEMPLATE.includes("## Run timeline\n{{TIMELINE}}"));
  assert.ok(TEMPLATE.includes("## Lessons given to this run\n{{INJECTED_LESSONS}}"));
  assert.ok(TEMPLATE.includes("Read every round and every fix-loop block; never the job's stream/log."));
  assert.ok(TEMPLATE.includes("{{>_footer}}"));
});
