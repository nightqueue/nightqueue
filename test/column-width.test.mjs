import assert from "node:assert/strict";
import { test } from "node:test";
import { nameWidth as doctorWidth, reportLine } from "../src/cli/doctor.mjs";
import { nameWidth as statsWidth } from "../src/cli/memory.mjs";

test("doctor: a project name longer than the column never touches its detail", () => {
  const checks = [
    { status: "ok", name: "node", detail: "v24" },
    { status: "warn", name: "project acme-dashboard-b2b", detail: "worktree with uncommitted changes", hint: "inspect /x" },
  ];
  const width = doctorWidth(checks);
  assert.equal(width, "project acme-dashboard-b2b".length + 1);
  const lines = checks.map((check) => reportLine(check, width));
  assert.match(lines[1], /b2b worktree with uncommitted changes - inspect \/x$/);
  assert.equal(lines[0].indexOf("v24"), lines[1].indexOf("worktree"), "details start in the same column");
});

test("doctor: short names keep the historical width of 22", () => {
  assert.equal(doctorWidth([{ status: "ok", name: "node", detail: "" }]), 22);
  assert.equal(reportLine({ status: "ok", name: "node", detail: "v24" }), "ok    node                  v24");
});

test("memory stats: the project column grows with the longest name and never below 24", () => {
  assert.equal(statsWidth([{ project: "nightshift" }]), 24);
  assert.equal(statsWidth([{ project: "acme-new-dashboard-b2b-web" }]), 27);
  assert.equal(statsWidth([{ project: null }]), 24);
});
