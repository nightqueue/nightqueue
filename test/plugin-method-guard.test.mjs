import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { COMMIT_TYPES } from "../src/queue/branch-name.mjs";
import { DEPENDENT_PROMPT_REFUSAL } from "../src/queue/dependent-prompt.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const FROZEN = join(ROOT, "test/fixtures/method-guard/main");
const { sentences, moved } = JSON.parse(readFileSync(join(ROOT, "test/fixtures/method-guard/sentences.json"), "utf8"));
const FROZEN_FILE_COUNT = 24;
const DESTINATION = /^(block|fetch|dropped):\S/;

// A text with every run of whitespace collapsed, so a wrapped line reads as one sentence.
function normalized(text) {
  return text.replace(/\s+/g, " ").trim();
}

// One frozen file of main, whitespace normalized.
function frozenText(file) {
  return normalized(readFileSync(join(FROZEN, file), "utf8"));
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
function frozenLines(file) {
  const lines = readFileSync(join(FROZEN, file), "utf8").split("\n").map(normalized);
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
  for (const { file, sentence, phrase, agents } of sentences) {
    assert.ok(frozenText(file).includes(sentence), `${file} never had: ${sentence}`);
    assert.ok(sentence.includes(phrase), `the phrase is not of its sentence: ${phrase}`);
    assert.ok(Array.isArray(agents) && agents.length > 0, `no agent carries: ${sentence}`);
  }
  for (const { file, line, to } of moved) {
    assert.ok(frozenText(file).includes(line), `${file} never had: ${line}`);
    assert.match(to, DESTINATION, `${file}: a moved line names no destination: ${line}`);
  }
});

// The guard itself: each method sentence of main keeps its key instruction in the agent that took it over.
test("the key phrase of every method sentence is in each agent that took it over", () => {
  const texts = new Map();
  for (const { file, agents, phrase } of sentences) {
    for (const agent of agents) {
      if (!texts.has(agent)) texts.set(agent, agentText(agent));
      assert.ok(texts.get(agent).includes(phrase), `${agent} lost, from ${file}: ${phrase}`);
    }
  }
  assert.equal(texts.size, 7, "the method did not reach the seven agents of a run");
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
