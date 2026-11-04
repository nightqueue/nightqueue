import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { COMMIT_TYPES } from "../src/queue/branch-name.mjs";
import { DEPENDENT_PROMPT_REFUSAL } from "../src/queue/dependent-prompt.mjs";
import { phasePrompts } from "../test-support/skill-size.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const FROZEN = join(ROOT, "test/fixtures/method-guard/main");
const RUN_SECTIONS = join(ROOT, "test/fixtures/method-guard/run-sections");
const { sentences, moved } = JSON.parse(readFileSync(join(ROOT, "test/fixtures/method-guard/sentences.json"), "utf8"));
const runFixture = JSON.parse(readFileSync(join(ROOT, "test/fixtures/method-guard/run-sentences.json"), "utf8"));
const FROZEN_FILE_COUNT = 24;
const RUN_SECTION_COUNT = 7;
const DESTINATION = /^(block|fetch|dropped):\S/;

// A text with every run of whitespace collapsed, so a wrapped line reads as one sentence.
function normalized(text) {
  return text.replace(/\s+/g, " ").trim();
}

// One frozen file, whitespace normalized.
function frozenText(file, dir = FROZEN) {
  return normalized(readFileSync(join(dir, file), "utf8"));
}

// One launched block of `## Phase prompts`, its snippets written out, whitespace normalized.
function blockText(target) {
  const lines = phasePrompts().blocks[target];
  if (lines === undefined) throw new Error(`\`${target}\` is not a block of \`## Phase prompts\``);
  return normalized(lines.join("\n"));
}

// The destinations an entry names: each agent and each block that took its sentence over.
function destinationsOf({ agents = [], blocks = [] }) {
  return [...agents.map((agent) => ({ name: agent, text: () => agentText(agent) })), ...blocks.map((target) => ({ name: `block ${target}`, text: () => blockText(target) }))];
}

// Every listed sentence of a fixture must come from its frozen file, and its phrase from the sentence itself.
function assertEntriesFromFrozen(entries, dir) {
  for (const entry of entries) {
    const { file, sentence, phrase } = entry;
    assert.ok(frozenText(file, dir).includes(sentence), `${file} never had: ${sentence}`);
    assert.ok(sentence.includes(phrase), `the phrase is not of its sentence: ${phrase}`);
    assert.ok(destinationsOf(entry).length > 0, `no agent or block carries: ${sentence}`);
  }
}

// One agent definition, whitespace normalized.
function agentText(agent) {
  return normalized(readFileSync(join(ROOT, `plugin/agents/${agent}.md`), "utf8"));
}

// The paths of every frozen template, partial and deliverable, relative to the fixture.
function frozenFiles() {
  return ["prompts", "deliverables"].flatMap((dir) => readdirSync(join(FROZEN, dir)).map((name) => `${dir}/${name}`));
}

// The distinct non-blank lines of one frozen file, whitespace normalized.
function frozenLines(file, dir = FROZEN) {
  const lines = readFileSync(join(dir, file), "utf8").split("\n").map(normalized);
  return [...new Set(lines.filter((line) => line !== ""))];
}

// Every frozen line must be claimed by an entry, so a sentence cannot leave the guard by being left out of the list.
test("every non-blank line of every removed file is a listed sentence or a moved line with its destination", () => {
  const files = frozenFiles();
  assert.equal(files.length, FROZEN_FILE_COUNT, "the frozen copy of main is incomplete");
  for (const file of files) {
    const claimed = new Set([...sentences, ...moved].filter((entry) => entry.file === file).map((entry) => entry.sentence ?? entry.line));
    for (const line of frozenLines(file)) assert.ok(claimed.has(line), `${file}: no entry accounts for: ${line}`);
  }
});

// The entries are tied to the frozen text, so the list cannot prove a sentence main never had.
test("every entry comes from its frozen file and its phrase comes from its own sentence", () => {
  assertEntriesFromFrozen(sentences, FROZEN);
  for (const { file, line, to } of moved) {
    assert.ok(frozenText(file).includes(line), `${file} never had: ${line}`);
    assert.match(to, DESTINATION, `${file}: a moved line names no destination: ${line}`);
  }
});

// Every line of the frozen run sections must be claimed, so a sentence cannot leave the guard by being left out of the list.
test("every non-blank line of every frozen run section is a listed sentence or a dropped line with its reason", () => {
  const files = readdirSync(RUN_SECTIONS).filter((name) => name.endsWith(".md"));
  assert.equal(files.length, RUN_SECTION_COUNT, "the frozen run sections are incomplete");
  for (const file of files) {
    const entries = [...runFixture.sentences, ...runFixture.dropped].filter((entry) => entry.file === file);
    const claimed = new Set(entries.map((entry) => entry.sentence ?? entry.line));
    for (const line of frozenLines(file, RUN_SECTIONS)) assert.ok(claimed.has(line), `run-sections/${file}: no entry accounts for: ${line}`);
  }
});

// The run-section entries are tied to the frozen text, and a dropped line says why it has no home.
test("every run-section entry comes from its frozen section and every dropped line carries its reason", () => {
  assertEntriesFromFrozen(runFixture.sentences, RUN_SECTIONS);
  for (const { file, line, why } of runFixture.dropped) {
    assert.ok(frozenText(file, RUN_SECTIONS).includes(line), `run-sections/${file} never had: ${line}`);
    assert.ok(typeof why === "string" && why.trim() !== "", `run-sections/${file}: a dropped line names no reason: ${line}`);
  }
});

// The guard itself: each method sentence keeps its key instruction in the agent or the block that took it over.
test("the key phrase of every method sentence is in each agent or block that took it over", () => {
  const texts = new Map();
  for (const entry of [...sentences, ...runFixture.sentences]) {
    for (const { name, text } of destinationsOf(entry)) {
      if (!texts.has(name)) texts.set(name, text());
      assert.ok(texts.get(name).includes(entry.phrase), `${name} lost, from ${entry.file}: ${entry.phrase}`);
    }
  }
  const agents = [...texts.keys()].filter((name) => !name.startsWith("block "));
  assert.equal(agents.length, 7, "the method did not reach the seven agents of a run");
});

// A line said to have moved into the blocks must find its field there, so the destination cannot be invented.
test("every line moved to a block finds its field or target in `## Phase prompts`", () => {
  const skill = readFileSync(join(ROOT, "plugin/skills/resolve/SKILL.md"), "utf8");
  const section = skill.slice(skill.indexOf("## Phase prompts"));
  for (const { to } of moved.filter((entry) => entry.to.startsWith("block:"))) {
    assert.ok(section.includes(to.slice("block:".length)), `no block carries ${to}`);
  }
});

// The two fixed lists the renderer injected became text of the triager's definition.
test("the triager carries the commit types and the dependent-request refusal as literal text", () => {
  const triager = agentText("triager");
  assert.ok(triager.includes(COMMIT_TYPES.join(", ")), "the commit types are not those of the runtime");
  assert.ok(triager.includes(DEPENDENT_PROMPT_REFUSAL), "the refusal is not the runtime's");
});
