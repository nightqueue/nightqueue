import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { TRACK_ROUTING, phasesFor, routingRow, routingTable, tasksFor } from "../../src/queue/routing.mjs";

const TABLE = readFileSync(new URL("../fixtures/skill-templates/routing-table.txt", import.meta.url), "utf8");
const RATIONALE = readFileSync(new URL("../fixtures/skill-templates/routing-rationale.txt", import.meta.url), "utf8");
const SOURCE = readFileSync(new URL("../../src/queue/routing.mjs", import.meta.url), "utf8");

// The rows of the old skill table as [label, trivial, simple, complex], the header and the separator dropped.
function oldRows() {
  return TABLE.trim()
    .split("\n")
    .slice(2)
    .map((line) => line.split("|").slice(1, -1).map((cell) => cell.trim()));
}

test("every cell of the routing module reads exactly as the table the skill carried", () => {
  const rows = TRACK_ROUTING.map(([label, cells]) => [label, ...cells]);
  assert.deepEqual(rows, oldRows());
});

test("the printed routing table carries every row of the table the skill carried, cell by cell", () => {
  const lines = routingTable().split("\n");
  assert.equal(lines[0], "| Routing | trivial | simple | complex |");
  const printed = lines.slice(2).map((line) => line.split("|").slice(1, -1).map((cell) => cell.trim()));
  assert.deepEqual(printed, oldRows());
});

test("the routing rationale moved verbatim into the header of the module", () => {
  const header = SOURCE.split("*/")[0]
    .split("\n")
    .map((line) => line.replace(/^ \* ?/, ""))
    .join("\n");
  for (const line of RATIONALE.split("\n").filter((text) => text.trim())) {
    assert.ok(header.includes(line), `the rationale line is missing from routing.mjs: ${line}`);
  }
});

test("the row of each tier answers the models, the limits and the rules the phases act on", () => {
  assert.deepEqual(routingRow("trivial").models, {
    triager: null,
    explore: null,
    architect: null,
    coder: "sonnet",
    qaGuardian: null,
    verifier: "haiku",
  });
  assert.deepEqual(routingRow("simple").models, {
    triager: "haiku",
    explore: null,
    architect: null,
    coder: "sonnet",
    qaGuardian: null,
    verifier: "haiku",
  });
  assert.deepEqual(routingRow("complex").models, {
    triager: "sonnet",
    explore: "sonnet",
    architect: "opus",
    coder: "opus",
    qaGuardian: "sonnet",
    verifier: "sonnet",
  });
  assert.equal(routingRow("simple").triagerBugOnly, true);
  assert.equal(routingRow("complex").triagerBugOnly, false);
  assert.deepEqual(
    ["trivial", "simple", "complex"].map((tier) => routingRow(tier).maxFixIterations),
    [1, 2, 2],
  );
  assert.deepEqual(
    ["trivial", "simple", "complex"].map((tier) => [routingRow(tier).claudeMd, routingRow(tier).indexRecall, routingRow(tier).contextForCoder]),
    [
      [false, false, false],
      [true, true, true],
      [true, true, true],
    ],
  );
  assert.equal(routingRow("simple").verifierScope, "tsc + lint + the project's FULL test suite (no QA PoCs in this tier)");
  assert.equal(routingRow("complex").track, "Standard");
});

test("the phases of a run follow its tier, and the simple tier triages a bug only", () => {
  assert.deepEqual(phasesFor("trivial", "bug/error"), ["implementation", "verification", "commit"]);
  assert.deepEqual(phasesFor("simple", "feature/refactor"), ["implementation", "verification", "commit"]);
  assert.deepEqual(phasesFor("simple", "bug/error"), ["triage", "implementation", "verification", "commit"]);
  assert.deepEqual(phasesFor("complex", "feature/refactor"), [
    "triage",
    "explore",
    "architecture",
    "implementation",
    "qa",
    "verification",
    "runtime",
    "commit",
  ]);
  assert.deepEqual(tasksFor("simple", "bug/error"), phasesFor("simple", "bug/error"));
});

test("an unknown tier or type is refused with the accepted values", () => {
  assert.throws(() => routingRow("huge"), /unknown tier `huge`; accepted: trivial, simple, complex/);
  assert.throws(() => phasesFor("simple", "chore"), /unknown type `chore`; accepted: bug\/error, feature\/refactor/);
});
