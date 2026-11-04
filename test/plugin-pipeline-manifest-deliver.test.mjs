import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { deliverOf, phasePrompts, SKILL_DIR } from "../test-support/skill-size.mjs";

const MANIFEST = JSON.parse(readFileSync(join(SKILL_DIR, "pipeline", "manifest.json"), "utf8"));
const QA_ARTIFACT = "05-qa.md";
const QA_STAGE_OF = Object.freeze({ "qa-triage": "triage", "qa-analyst": "analyst" });
const PROVER = "qa-prover";
const OPTIONAL = Object.freeze({
  "01-triage.md": ["## Brief", "## Request critique", "## Intent signals", "## Diagnosis", "## Intent note", "## Depth note", "## Open items"],
  "02-explore.md": [],
  "03-plan.md": ["## Requires user confirmation", "## Decisions taken", "## Symptom coverage", "## Usage coverage"],
  "04-implementation.md": ["## Done", "## Left", "## How it was tested"],
  "05-qa.md": ["## Mapped rules", "## Suggestions", "## Access map (QA)", "## Prevention"],
  "06-verification.md": ["## Failures", "## Pre-existing failures", "## Runtime API Check"],
  "07-runtime.md": [],
});

// The manifest phase that writes one artifact, or undefined for a file no phase checks.
function phaseOf(artifact) {
  return MANIFEST.phases.find((phase) => phase.artifact === artifact);
}

// The mandatory sections of one artifact, every QA stage's sections included.
function manifestSections(artifact) {
  const phase = phaseOf(artifact);
  if (phase === undefined) return [];
  const stages = Object.values(phase.stages ?? {}).flatMap((stage) => stage.sections);
  return [...new Set([...phase.sections, ...stages])];
}

// The mandatory sections the run check reads from the deliverable one target writes.
function requiredSections(target, artifact) {
  const stage = QA_STAGE_OF[target];
  if (stage !== undefined) return phaseOf(QA_ARTIFACT).stages[stage].sections;
  return phaseOf(artifact)?.sections ?? [];
}

// Whether `wanted` appears in `headings` in the same order, other headings allowed in between.
function inOrder(wanted, headings) {
  let at = 0;
  for (const heading of headings) if (heading === wanted[at]) at += 1;
  return at === wanted.length;
}

// The blocks that declare a Deliver fence, each with its artifact (the prover's draft read as its QA round) and headings.
function deliveringBlocks() {
  return Object.entries(phasePrompts().blocks)
    .map(([target, lines]) => ({ target, ...deliverOf(lines) }))
    .filter(({ headings }) => headings.length > 0)
    .map((block) => (block.target === PROVER ? { ...block, artifact: QA_ARTIFACT, draft: true } : block));
}

test("a Deliver fence reads as its artifact and its heading names, parenthetical and template cut", () => {
  const lines = ["TARGET: x", "ARTIFACT_PATH: <runDir>/01-triage.md", "NOTE: none", "## Deliver — all mandatory", "~~~", "## Verdict: <PROCEED|STOP>", "Evidence level: <1-4>", "## Diagnosis  (bug only)", "### Stage <n>", "~~~", "## Found also lists x"];
  assert.deepEqual(deliverOf(lines), { artifact: "01-triage.md", headings: ["## Verdict", "## Diagnosis"] });
  assert.deepEqual(deliverOf(["TARGET: x", "NOTE: none"]), { artifact: null, headings: [] });
});

test("the optional headings are never mandatory ones, so a mandatory section cannot be excused as optional", () => {
  for (const [artifact, optional] of Object.entries(OPTIONAL)) {
    assert.ok(phaseOf(artifact), `${artifact} is no artifact of the manifest`);
    const mandatory = manifestSections(artifact);
    assert.deepEqual(optional.filter((heading) => mandatory.includes(heading)), [], `${artifact} lists a mandatory section as optional`);
  }
});

test("every block's Deliver carries the manifest sections of its artifact, in the manifest's order", () => {
  for (const { target, artifact, headings, draft } of deliveringBlocks()) {
    assert.ok(artifact, `the ${target} block has a Deliver but no ARTIFACT_PATH`);
    if (draft) continue;
    const wanted = requiredSections(target, artifact);
    assert.ok(inOrder(wanted, headings), `the ${target} Deliver of ${artifact} misses or reorders ${wanted.join(", ")}: ${headings.join(", ")}`);
  }
});

test("every heading of a block's Deliver is a manifest section or a listed optional one of its artifact", () => {
  for (const { target, artifact, headings } of deliveringBlocks()) {
    const known = new Set([...manifestSections(artifact), ...(OPTIONAL[artifact] ?? [])]);
    for (const heading of headings) assert.ok(known.has(heading), `the ${target} Deliver writes \`${heading}\`, which ${artifact} neither requires nor lists as optional`);
  }
});
