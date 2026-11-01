import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  AGENT_MODELS,
  MODEL_NAMES,
  OVERRIDABLE_AGENTS,
  PIPELINE_CONSTANTS,
  TRACK_SLOTS,
  agentGlyph,
  agentModels,
  modelFor,
  modelTable,
  phasesFor,
  requireAgent,
  requireModel,
  slotNumberOf,
} from "../../src/queue/routing.mjs";

const TABLE = readFileSync(new URL("../fixtures/skill-templates/routing-table.txt", import.meta.url), "utf8");
const RATIONALE = readFileSync(new URL("../fixtures/skill-templates/routing-rationale.txt", import.meta.url), "utf8");
const SOURCE = readFileSync(new URL("../../src/queue/routing.mjs", import.meta.url), "utf8");

test("every agent has its decided default model", () => {
  assert.deepEqual(AGENT_MODELS, {
    triager: "sonnet",
    explore: "haiku",
    architect: "opus",
    coder: "opus",
    "qa-analyst": "sonnet",
    "qa-prover": "haiku",
    verifier: "haiku",
    reflector: "haiku",
    merger: "sonnet",
  });
  assert.deepEqual(MODEL_NAMES, ["opus", "sonnet", "haiku"]);
  assert.deepEqual(OVERRIDABLE_AGENTS, ["triager", "explore", "architect", "coder", "qa-analyst", "qa-prover", "verifier", "reflector"]);
});

test("the printed model table reads exactly as the fixture", () => {
  assert.equal(modelTable(), TABLE.trim());
});

test("the model rationale is the header of the module, and the old sonnet-not-opus reasoning is gone", () => {
  const header = SOURCE.split("*/")[0]
    .split("\n")
    .map((line) => line.replace(/^ \* ?/, ""))
    .join("\n");
  for (const line of RATIONALE.split("\n").filter((text) => text.trim())) {
    assert.ok(header.includes(line), `the rationale line is missing from routing.mjs: ${line}`);
  }
  assert.doesNotMatch(header, /not `opus`/);
  assert.doesNotMatch(header, /\btier\b/);
});

test("a project override replaces the default of its agent, an invalid stored value falls back to the default", () => {
  assert.equal(modelFor("coder"), "opus");
  assert.equal(modelFor("coder", { coder: { model: "sonnet" } }), "sonnet");
  assert.equal(modelFor("coder", { coder: { model: "gpt" } }), "opus");
  assert.equal(modelFor("coder", { verifier: { model: "opus" } }), "opus");
  assert.equal(modelFor("triager", "not an object"), "sonnet");
  assert.throws(() => modelFor("nobody"), /no default model for agent `nobody`/);
  assert.throws(() => modelFor("constructor"), /no default model for agent `constructor`/);
  const models = agentModels({ verifier: { model: "sonnet" } });
  assert.equal(models.verifier, "sonnet");
  assert.equal(models.coder, "opus");
  assert.deepEqual(Object.keys(models), Object.keys(AGENT_MODELS));
  assert.match(modelTable({ coder: { model: "haiku" } }), /\| ⚙️ coder \| haiku \|/);
});

test("a stored merger override is ignored: the merger always runs on its default", () => {
  assert.equal(modelFor("merger", { merger: { model: "opus" } }), AGENT_MODELS.merger);
  assert.equal(agentModels({ merger: { model: "haiku" } }).merger, AGENT_MODELS.merger);
});

test("an agent or a model outside the accepted ones is refused, naming them", () => {
  assert.equal(requireAgent("coder"), "coder");
  assert.equal(requireModel("haiku"), "haiku");
  assert.throws(() => requireAgent("merger"), /unknown agent `merger`; accepted: triager, explore, architect, coder, qa-analyst, qa-prover, verifier, reflector/);
  assert.throws(() => requireModel("gpt"), /unknown model `gpt`; accepted: opus, sonnet, haiku/);
});

test("every run goes through every phase, and an unknown type is refused", () => {
  const every = ["triage", "explore", "architecture", "implementation", "qa", "verification", "runtime", "commit"];
  assert.deepEqual(phasesFor("bug/error"), every);
  assert.deepEqual(phasesFor("feature/refactor"), every);
  assert.deepEqual(phasesFor(null), every);
  assert.deepEqual(phasesFor(), every);
  assert.throws(() => phasesFor("chore"), /unknown type `chore`; accepted: bug\/error, feature\/refactor/);
});

test("the pipeline constants are the same for every run", () => {
  assert.equal(PIPELINE_CONSTANTS.maxFixIterations, 2);
  assert.equal(PIPELINE_CONSTANTS.verifierScope, "the project's real checks (typecheck, lint, build, tests) + the QA's PoCs");
  assert.match(PIPELINE_CONSTANTS.qaMethods, /^automated;/);
});

test("the glyph of an agent is read from its own map", () => {
  assert.equal(agentGlyph("coder"), "⚙️");
  assert.equal(agentGlyph("Explore"), "🧭");
  assert.equal(agentGlyph("qa-guardian"), "🛡️");
  assert.equal(agentGlyph("triager"), "🔍");
  assert.equal(agentGlyph("architect"), "📐");
  assert.equal(agentGlyph("verifier"), "✅");
  assert.equal(agentGlyph("orchestrator"), null);
  assert.equal(agentGlyph("reflector"), null);
  assert.equal(agentGlyph("constructor"), null);
  assert.equal(agentGlyph(""), null);
  assert.equal(agentGlyph(null), null);
});

test("the studio track has nine slots in order, each with its agent, the agent whose model it shows and its canonical phase", () => {
  assert.deepEqual(
    TRACK_SLOTS.map((slot) => [slot.number, slot.name, slot.agent, slot.modelAgent, slot.phase]),
    [
      [0, "brief", null, null, null],
      [1, "triager", "triager", "triager", "triage"],
      [2, "explore", "explore", "explore", "explore"],
      [3, "architect", "architect", "architect", "architecture"],
      [4, "coder", "coder", "coder", "implementation"],
      [5, "qa-guardian", "qaGuardian", "qa-analyst", "qa"],
      [6, "verifier", "verifier", "verifier", "verification"],
      [7, "runtime", null, null, "runtime"],
      [8, "commit · PR", null, null, "commit"],
    ],
  );
  assert.deepEqual([slotNumberOf("verification"), slotNumberOf("runtime"), slotNumberOf("commit")], [6, 7, 8]);
  assert.throws(() => slotNumberOf("nope"), /no track slot for phase "nope"/);
  for (const slot of TRACK_SLOTS.filter((candidate) => candidate.modelAgent)) assert.ok(slot.modelAgent in AGENT_MODELS, `${slot.modelAgent} is an agent with a model`);
});
