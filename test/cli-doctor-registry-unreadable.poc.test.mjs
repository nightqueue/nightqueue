import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { test } from "node:test";
import { defaultContext, run } from "../src/cli/index.mjs";
import { runnersDir } from "../src/config/paths.mjs";
import { ensureHome } from "../src/config/store.mjs";
import { makeHome } from "../test-support/memory.mjs";

// Runs the diagnosis in process and returns the parsed report, the shape test/doctor.test.mjs already uses.
async function diagnose(env) {
  const out = [];
  const ctx = { ...defaultContext(), env, out: (line) => out.push(line), err: () => {} };
  const code = await run(["doctor", "--json"], ctx);
  return { code, report: JSON.parse(out[0]) };
}

test("doctor does not report an unreadable runner registry as an empty, never-used one", async (t) => {
  const env = makeHome(t, "doctor-registry-unreadable");
  ensureHome(env);
  writeFileSync(runnersDir(env), "not a directory");

  const { report } = await diagnose(env);
  const registryCheck = report.checks.find((check) => check.name === "runner registry");
  assert.ok(registryCheck, `no "runner registry" check in ${report.checks.map((check) => check.name).join(", ")}`);
  assert.notEqual(
    registryCheck.status,
    "ok",
    `doctor reported the unreadable registry as ok/"no runner registered": ${JSON.stringify(registryCheck)}`,
  );
});
