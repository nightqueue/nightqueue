import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const PROMPTS = join(ROOT, "plugin/skills/resolve/references/prompts");
// An agent whose file holds only who it is and how it thinks (the triager, the explore); add the next ones as they migrate.
const INDEPENDENT = ["triager", "explore"];
const PIPELINE_TERMS = [
  "01-triage",
  "02-explore",
  "ARTIFACT_PATH",
  "orchestrator",
  "architect",
  "Phase ",
  "run check",
  "## Shell inside",
  "Related jobs",
  "index-save",
  "index_recall",
];

// A pipeline-independent agent names no phase, artifact, orchestrator, other agent, shell rule or runtime block.
test("each pipeline-independent agent file names nothing of the pipeline", () => {
  for (const agent of INDEPENDENT) {
    const text = readFileSync(join(ROOT, `plugin/agents/${agent}.md`), "utf8");
    for (const term of PIPELINE_TERMS) {
      assert.equal(text.includes(term), false, `${agent} names the pipeline: ${term}`);
    }
  }
});

// What the agent must deliver and how it returns lives in the request the pipeline renders.
test("each pipeline-independent agent's request owns the deliverable, the handoff and the shell rule", () => {
  for (const agent of INDEPENDENT) {
    const request = readFileSync(join(PROMPTS, `${agent}.md`), "utf8");
    for (const part of ["## Deliver", "{{>_handoff}}", "{{>_shell-rule}}"]) {
      assert.ok(request.includes(part), `the ${agent} request does not carry ${part}`);
    }
  }
});
