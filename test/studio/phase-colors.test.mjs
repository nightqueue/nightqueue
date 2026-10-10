import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { PHASE_HEX, phaseHex, phaseRole, phaseVar } from "../../studio/src/lib/phase-colors.ts";

const STYLES = new URL("../../studio/src/styles.css", import.meta.url);
const NON_IDENTITY_HEX = ["#8cc8a0", "#a3d6b3", "#ff8f88", "#da3633", "#e5534b", "#f2c25c"];

test("each phase role has its own hex", () => {
  assert.deepEqual(PHASE_HEX, {
    triager: "#3987e5",
    explore: "#d95926",
    architect: "#199e70",
    coder: "#c98500",
    "qa-guardian": "#d55181",
    verifier: "#9085e9",
    system: "#4b5568",
  });
});

test("an agent name is normalised to its role, and anything that is not an agent is system", () => {
  for (const name of ["qaGuardian", "qa_guardian", "QA-Guardian", "qa-guardian"]) assert.equal(phaseRole(name), "qa-guardian", name);
  for (const name of [null, undefined, "brief", "runtime", "commit", "orchestrator", ""]) assert.equal(phaseRole(name), "system", String(name));
  assert.equal(phaseVar("architect"), "var(--ph-architect)");
  assert.equal(phaseHex("coder"), "#c98500");
});

test("no phase role uses an accent, red or amber token", () => {
  for (const hex of Object.values(PHASE_HEX)) assert.equal(NON_IDENTITY_HEX.includes(hex.toLowerCase()), false, hex);
});

test("styles.css declares every --ph-<role> with exactly the hex of PHASE_HEX", () => {
  const css = readFileSync(STYLES, "utf8");
  for (const [role, hex] of Object.entries(PHASE_HEX)) {
    const declared = new RegExp(`--ph-${role}:\\s*(#[0-9a-fA-F]{6})\\s*;`).exec(css);
    assert.ok(declared, `--ph-${role} is not declared`);
    assert.equal(declared[1].toLowerCase(), hex, `--ph-${role}`);
  }
});
