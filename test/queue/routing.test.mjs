import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { pipelineManifest } from "../../src/queue/pipeline-package.mjs";
import {
  defaultAgentModels,
  MODEL_NAMES,
  overridableAgents,
  pipelineConstants,
  trackSlots,
  agentGlyph,
  agentModels,
  modelFor,
  modelTable,
  phaseModelOf,
  phasesFor,
  requireAgent,
  requireModel,
  slotNumberOf,
} from "../../src/queue/routing.mjs";

const TABLE = readFileSync(new URL("../fixtures/skill-templates/routing-table.txt", import.meta.url), "utf8");
const RATIONALE = readFileSync(new URL("../fixtures/skill-templates/routing-rationale.txt", import.meta.url), "utf8");
const SOURCE = readFileSync(new URL("../../src/queue/routing.mjs", import.meta.url), "utf8");

test("every agent has its decided default model", () => {
  assert.deepEqual(defaultAgentModels(), {
    triager: "sonnet",
    explore: "haiku",
    architect: "opus",
    coder: "opus",
    "qa-triage": "sonnet",
    "qa-analyst": "sonnet",
    "qa-prover": "haiku",
    verifier: "haiku",
    reflector: "haiku",
    merger: "sonnet",
  });
  assert.deepEqual(MODEL_NAMES, ["opus", "sonnet", "haiku"]);
  assert.deepEqual(overridableAgents(), ["triager", "explore", "architect", "coder", "qa-triage", "qa-analyst", "qa-prover", "verifier", "reflector"]);
});

test("the printed model table reads exactly as the fixture", () => {
  assert.equal(modelTable(), TABLE.trim());
});

test("the model rationale lives in the runtime contract, and the old sonnet-not-opus reasoning is gone", () => {
  const header = SOURCE.split("*/")[0]
    .split("\n")
    .map((line) => line.replace(/^ \* ?/, ""))
    .join("\n");
  const doc = readFileSync(new URL("../../docs/runtime-contract.md", import.meta.url), "utf8");
  for (const line of RATIONALE.split("\n").filter((text) => text.trim())) {
    assert.ok(doc.includes(line), `the rationale line is missing from docs/runtime-contract.md: ${line}`);
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
  assert.deepEqual(Object.keys(models), Object.keys(defaultAgentModels()));
  assert.match(modelTable({ coder: { model: "haiku" } }), /\| ⚙️ coder \| haiku \|/);
});

test("a stored merger override is ignored: the merger always runs on its default", () => {
  assert.equal(modelFor("merger", { merger: { model: "opus" } }), defaultAgentModels().merger);
  assert.equal(agentModels({ merger: { model: "haiku" } }).merger, defaultAgentModels().merger);
});

test("an agent or a model outside the accepted ones is refused, naming them", () => {
  assert.equal(requireAgent("coder"), "coder");
  assert.equal(requireModel("haiku"), "haiku");
  assert.throws(() => requireAgent("merger"), /unknown agent `merger`; accepted: triager, explore, architect, coder, qa-triage, qa-analyst, qa-prover, verifier, reflector/);
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
  assert.equal(pipelineConstants().maxFixIterations, 2);
  assert.match(pipelineConstants().qaMethods, /^automated;/);
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
    trackSlots().map((slot) => [slot.number, slot.name, slot.agent, slot.modelAgent, slot.phase]),
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
  for (const slot of trackSlots().filter((candidate) => candidate.modelAgent)) assert.ok(slot.modelAgent in defaultAgentModels(), `${slot.modelAgent} is an agent with a model`);
});

test("the model a phase ran on is its track slot's model agent, else its first agent, with the project's override; a phase with no agent has none", () => {
  const manifest = pipelineManifest();
  assert.equal(phaseModelOf(manifest, "architecture"), defaultAgentModels().architect);
  assert.equal(phaseModelOf(manifest, "qa"), defaultAgentModels()["qa-analyst"]);
  assert.equal(phaseModelOf(manifest, "runtime"), defaultAgentModels().verifier);
  assert.equal(phaseModelOf(manifest, "commit"), null);
  assert.equal(phaseModelOf(manifest, "architecture", { architect: { model: "haiku" } }), "haiku");
  assert.equal(phaseModelOf(manifest, "architecture", { architect: { model: "gpt" } }), defaultAgentModels().architect);
});

test("a phase of another pipeline answers the model its own manifest names, or null for an agent with none, never a throw", () => {
  const manifest = { phases: [{ id: "draft", agents: ["writer"] }, { id: "ship", agents: ["shipper"] }], models: { writer: "sonnet" }, track: [] };
  assert.equal(phaseModelOf(manifest, "draft"), "sonnet");
  assert.equal(phaseModelOf(manifest, "ship"), null);
  assert.equal(phaseModelOf(manifest, "nope"), null);
  assert.equal(phaseModelOf(null, "draft"), null);
});
