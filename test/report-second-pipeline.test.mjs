import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { run } from "../src/cli/index.mjs";
import { runDir } from "../src/config/paths.mjs";
import { openDb } from "../src/memory/db.mjs";
import { addJob } from "../src/memory/jobs.mjs";
import { readRunState, saveRunState } from "../src/queue/resume.mjs";
import { recordRunFields } from "../src/queue/run-state.mjs";
import { ensureProject, makeHome, makeProject } from "../test-support/memory.mjs";

const SLUG = "duo-run";

const DUO_MANIFEST = {
  name: "duo",
  phases: [
    { id: "draft", check: "01", artifact: "plan.md", sections: [], verdicts: ["OK"], agents: ["writer"] },
    { id: "ship", check: null, artifact: null, sections: [], verdicts: ["OK"], agents: [] },
  ],
  report: {
    rows: [
      { phase: "draft", step: "1 Draft", agent: "✏️ Writer" },
      { phase: "ship", step: "2 Ship", agent: "📦 Shipper" },
      { phase: null, step: "3 Report", agent: "🗂️ Report" },
    ],
  },
  gateArtifact: "plan.md",
};

// The report module of the fake pipeline: one fact file, one fact per line read, and no row rule of its own.
const DUO_REPORT = {
  FACT_FILES: ["notes.md"],
  facts: ({ texts }) => [`Note: ${texts["notes.md"].split("\n")[0]}`],
};

// A job bound to a run of the `duo` pipeline, with both phases recorded and their durations stamped on the entries.
function makeDuoRun(t) {
  const env = makeHome(t, "report-second-pipeline");
  makeProject(t, env, "alpha");
  const projectId = ensureProject(env, "alpha");
  const id = addJob({ projectId, prompt: "write and ship" }, env).id;
  openDb(env).prepare("UPDATE jobs SET slug = ? WHERE id = ?").run(SLUG, id);
  const target = { projectId, slug: SLUG, env };
  recordRunFields({ ...target, fields: { type: "feature/refactor" } });
  const phases = [
    { phase: "draft", verdict: "OK", note: "drafted", at: "2026-01-01T00:00:00Z", durationS: 61 },
    { phase: "ship", verdict: "OK", note: "shipped", at: "2026-01-01T00:02:00Z", durationS: 30 },
  ];
  saveRunState({ ...target, state: { ...readRunState(target), pipeline: { name: "duo" }, phases } });
  const dir = runDir(projectId, SLUG, env);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "notes.md"), "the duo notes\nsecond line\n");
  return { env, id };
}

// Runs `run report` as the job with the fake pipeline injected, answering its printed lines and the pipeline names it loaded.
async function duoReport({ env, id }, argv = []) {
  const out = [];
  const err = [];
  const loaded = [];
  const loadReport = async (name) => {
    loaded.push(name);
    return { manifest: DUO_MANIFEST, report: DUO_REPORT };
  };
  const code = await run(["run", "report", ...argv], { env: { ...env, NIGHTQUEUE_JOB_ID: String(id) }, out: (line) => out.push(line), err: (line) => err.push(line), stdout: { write: () => {} }, loadReport });
  assert.equal(code, 0, err.join("\n"));
  return { out, loaded };
}

test("a second pipeline's run is reported from its own layout and records: its rows, default icons and the entries' durations", async (t) => {
  const { out, loaded } = await duoReport(makeDuoRun(t));

  assert.deepEqual(loaded, ["duo"]);
  const rows = out.filter((line) => line.startsWith("| ") && !line.startsWith("| Step |") && !line.startsWith("|---"));
  assert.deepEqual(rows, [
    "| 1 Draft | ✏️ Writer | ✅ OK | drafted | 1m01s |",
    "| 2 Ship | 📦 Shipper | ✅ OK | shipped | 30s |",
    "| 3 Report | 🗂️ Report | ⏳ | this report | - |",
  ]);
  assert.equal(out.some((line) => /Triage|Commit\/PR|telemetry/.test(line)), false, out.join("\n"));
  const open = out.indexOf("## Open items");
  assert.equal(out[open + 2], "- none", out.join("\n"));
});

test("a second pipeline's facts are the ones its package states over its own fact files", async (t) => {
  const { out } = await duoReport(makeDuoRun(t), ["--facts"]);

  assert.deepEqual(out, ["## Facts for the report", "", "- Note: the duo notes"]);
});

// Runs `run report` as the job through the real package loader, answering its exit code and printed lines.
async function realReport({ env, id }, argv = []) {
  const out = [];
  const err = [];
  const code = await run(["run", "report", ...argv], { env: { ...env, NIGHTQUEUE_JOB_ID: String(id) }, out: (line) => out.push(line), err: (line) => err.push(line), stdout: { write: () => {} } });
  return { code, out, err };
}

test("a run pinned to a pipeline with no readable package is still reported, with the default layout and an open item naming why", async (t) => {
  const { code, out, err } = await realReport(makeDuoRun(t));

  assert.equal(code, 0, err.join("\n"));
  assert.ok(out.some((line) => line.startsWith("| ") && !line.startsWith("| Step |")), out.join("\n"));
  assert.ok(out.some((line) => /^- reported with the `resolve` layout: the pipeline `duo` has no readable package/.test(line)), out.join("\n"));
});

test("`run report --facts` of a run pinned to a pipeline with no readable package still prints its facts", async (t) => {
  const { code, out, err } = await realReport(makeDuoRun(t), ["--facts"]);

  assert.equal(code, 0, err.join("\n"));
  assert.equal(out[0], "## Facts for the report", out.join("\n"));
});
