import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { JOB_STATUS_WRITERS } from "../../src/store/local.mjs";

const JOBS_SOURCE = readFileSync(new URL("../../src/memory/jobs.mjs", import.meta.url), "utf8");

// Job writers the store does not wrap in the roadmap follow, each with the reason it is safe.
const NOT_FOLLOWED = {
  addJob: "a new job has no linked item yet: queueRoadmapItem links it with linkRoadmapItemJob",
  sweepOrphans: "the store follows every drifted job right after the sweep (followDriftedJobs)",
};

// The SQL text of every top-level string constant of the module, so an interpolated assignment is read where it is used.
function stringConstants(source) {
  const pattern = /^const (\w+) =\s*(["`])([\s\S]*?)\2;/gm;
  return new Map([...source.matchAll(pattern)].map((match) => [match[1], match[3]]));
}

// The source of every exported function, from its signature to its closing brace at column 0.
function exportedFunctions(source) {
  return [...source.matchAll(/^export (?:async )?function (\w+)\(/gm)].map((match) => ({
    name: match[1],
    body: source.slice(match.index, source.indexOf("\n}\n", match.index)),
  }));
}

// Tells whether a function body inserts a job or assigns `status` inside the SET clause of an UPDATE.
function writesJobStatus(body, constants) {
  const sql = body.replace(/\$\{(\w+)\}/g, (whole, name) => constants.get(name) ?? whole);
  const inserted = /INSERT INTO jobs\b/.test(sql) || /\bINSERT_JOB\b/.test(body);
  const setClauses = [...sql.matchAll(/\bSET\b([\s\S]*?)(?:\bWHERE\b|$)/g)].map((match) => match[1]);
  return inserted || setClauses.some((clause) => /(?<![\w.])status\s*=/.test(clause));
}

test("every job writer that can move a status is followed by the roadmap, or excluded with a reason", () => {
  const constants = stringConstants(JOBS_SOURCE);
  const writers = exportedFunctions(JOBS_SOURCE)
    .filter((fn) => writesJobStatus(fn.body, constants))
    .map((fn) => fn.name);

  assert.ok(writers.includes("claimNextJob") && writers.includes("settleClose") && writers.includes("cancelOnClosedPr"), `the parser missed known writers: ${writers}`);
  const unfollowed = writers.filter((name) => !JOB_STATUS_WRITERS.includes(name) && !(name in NOT_FOLLOWED));
  assert.deepEqual(unfollowed, [], "a job-status writer is neither in JOB_STATUS_WRITERS nor excluded with a reason");
  const stale = JOB_STATUS_WRITERS.filter((name) => !writers.includes(name));
  assert.deepEqual(stale, [], "JOB_STATUS_WRITERS names a method that no longer writes a job status");
});
