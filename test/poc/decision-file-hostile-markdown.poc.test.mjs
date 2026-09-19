import assert from "node:assert/strict";
import { test } from "node:test";
import { parseDecisionFile, renderDecisionFile } from "../../src/memory/decision-file.mjs";

// Vector 1: an HTML comment mentioning a status word sits in the header zone, ahead of the real `Status:` line.
const DECOY_STATUS_COMMENT = `# 0001 - Runner leases jobs eagerly

<!-- Status: rejected, an editor TODO left behind before this was proposed -->
Status: Proposed (2026-01-01). Decision #1 in the alpha store.

## Context

Runners used to grab any job.

## Decision

Runners lease jobs one at a time.
`;

test("Vector 1: a decoy Status inside an HTML comment must not shadow the real Status line", () => {
  const parsed = parseDecisionFile(DECOY_STATUS_COMMENT);
  assert.equal(parsed.status, "proposed", `parseHeader must ignore the HTML comment and read the real "Status: Proposed" line, but it returned ${JSON.stringify(parsed.status)}`);
});

// Vector 2: the decision text documents this very file's own ADR format, fenced, including an embedded "## Context" line.
function rowWithFencedExample() {
  return {
    scope: "project",
    project: "alpha",
    org: null,
    number: 12,
    title: "Document the ADR file format inside a decision",
    context: "Operators sometimes need to see the file shape while writing a lesson.",
    decision:
      "Show the shape by example:\n\n```\n# 0099 - Example decision\n\nStatus: Accepted (2026-01-01). Decision #99 in the alpha store.\n\n## Context\n\nfoo\n\n## Decision\n\nbar\n```\n\nThat fenced block is illustrative only, not a real section boundary.",
    consequences: null,
    status: "accepted",
    created_at: "2026-06-01 00:00:00",
  };
}

test("Vector 2: export -> import round trip must survive a fenced code block that quotes '## Context'", () => {
  const original = rowWithFencedExample();
  const exported = renderDecisionFile(original);
  const imported = parseDecisionFile(exported, "roundtrip.md");

  assert.equal(imported.decision, original.decision, "the fenced '## Context' line inside the Decision field must not split the field");
  assert.equal(imported.context, original.context, "text that trails the fenced block must stay inside Decision, not bleed into Context");

  const reExported = renderDecisionFile({ ...original, context: imported.context, decision: imported.decision, consequences: imported.consequences });
  assert.equal(reExported, exported, "export -> import -> export must be byte-identical (Stage 4 acceptance criterion)");
});
