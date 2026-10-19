import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runEasAsync } from "../../src/host/eas.mjs";
import { acquireClose, addJob, claimJobById, finishJob, getJob } from "../../src/memory/jobs.mjs";
import { CLOSE_STEPS, runClosePipeline } from "../../src/queue/close.mjs";
import { copyEnvFile, envFileNames } from "../../src/queue/close-deps.mjs";
import { openStore } from "../../src/store/open.mjs";
import { makeHome, makeProject, projectIdOf } from "../../test-support/memory.mjs";
import { setIntegrations } from "../../test-support/origin-provider.mjs";

const WORKER = "close:test:1:ota-abort";
const OTA_STEPS = CLOSE_STEPS.filter((step) => step.name === "ota");

// A done job of an Expo project with OTA on, holding its close lease.
function otaJob(t) {
  const env = makeHome(t, "ota-abort");
  const checkout = makeProject(t, env, "alpha");
  const projectId = projectIdOf(env, "alpha");
  setIntegrations(env, projectId, { expo: { ota: true } });
  const { id } = addJob({ projectId, prompt: "fix", origin: [] }, env);
  claimJobById(id, { worker: WORKER, cap: null }, env);
  finishJob(id, { worker: WORKER, status: "done", prUrl: "https://github.com/acme/app/pull/7" }, env);
  acquireClose(id, { worker: WORKER, leaseS: 720 }, env);
  return { env, checkout, id };
}

// Close deps whose eas update hangs until the close is aborted, whose git removal is slow, recording each event.
function abortingDeps(t, controller) {
  const events = [];
  const made = [];
  const hangingEas = (file, args, options, callback) => {
    events.push(`eas ${args[0]}`);
    if (args[0] !== "update") return setImmediate(() => callback(null, "", ""));
    options.signal.addEventListener("abort", () => callback(Object.assign(new Error("aborted"), { name: "AbortError", code: "ABORT_ERR" }), "", ""), { once: true });
    setTimeout(() => controller.abort(), 50);
  };
  const eas = (args, options = {}) => runEasAsync(args, { ...options, env: { PATH: "/usr/bin" }, execFileImpl: hangingEas });
  const git = async (args) => {
    if (args[0] === "worktree" && args[1] === "remove") await new Promise((resolve) => setTimeout(resolve, 20));
    return { ok: true, stdout: "", stderr: "" };
  };
  const makeTempDir = (prefix) => {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    made.push(dir);
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    return dir;
  };
  const removeDir = (dir) => {
    events.push("removeDir");
    rmSync(dir, { recursive: true, force: true });
  };
  const fs = { exists: () => true, makeTempDir, removeDir, linkNodeModules: () => false, envFileNames, copyEnvFile };
  return { events, made, deps: { eas: { whoami: async () => ({ installed: true, authenticated: true, login: "a", host: null }), update: eas, projectInfo: eas }, git, fs } };
}

// The required steps of a close that already merged, answering at once.
function mergedSteps() {
  const done = (note, data) => async () => ({ status: "done", note, data });
  return [
    { name: "preflight", run: done("ok", { title: "fix", baseBranch: "main" }) },
    { name: "conflict", run: async () => ({ status: "skipped", note: "m" }) },
    { name: "merge", run: done("merged", { merged: true, mergeSha: "abc1234def5678" }) },
    { name: "settle", run: done("r", { noticeLine: "Closed" }) },
  ];
}

test("a close aborted during eas update resolves only after the OTA step removed its throwaway worktree", async (t) => {
  const { env, checkout, id } = otaJob(t);
  const controller = new AbortController();
  const { events, made, deps } = abortingDeps(t, controller);
  await runClosePipeline({
    store: openStore(env), job: getJob(id, env), worker: WORKER, env, deps,
    timeoutS: 60, signal: controller.signal, onStep: () => {}, checkout, steps: [...mergedSteps(), ...OTA_STEPS],
  });
  assert.equal(made.length, 1, "the OTA worktree was never created");
  assert.equal(existsSync(made[0]), false, `the close resolved with the worktree still on disk; events: ${events.join(", ")}`);
  assert.ok(events.includes("removeDir"), `the cleanup had not run when the close resolved: ${events.join(", ")}`);
});

test("the ota close step waits a bounded time for its cleanup after an abort", () => {
  const [ota] = OTA_STEPS;
  assert.ok(Number.isFinite(ota.settleMs) && ota.settleMs > 0);
  assert.ok(ota.settleMs <= 60000);
});
