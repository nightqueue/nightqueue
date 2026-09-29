import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { addJob, getJob } from "../../src/memory/jobs.mjs";
import { runDrain } from "../../src/queue/runner.mjs";
import { initGitRepo } from "../../test-support/git.mjs";
import { ensureProject, makeDir, makeHome, registerCheckout } from "../../test-support/memory.mjs";
import { useFakeClaude } from "../../test-support/queue-fake.mjs";
import { doneStream } from "../../test-support/streams.mjs";

const CLI = fileURLToPath(new URL("../../bin/nightqueue.mjs", import.meta.url));

// Git configuration that reads nothing of the machine's own ignore rules, so only each repository decides what is ignored.
const ISOLATED_GIT_VARS = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: "core.excludesFile",
  GIT_CONFIG_VALUE_0: "/dev/null",
};

// Runs real git in the isolated configuration, in the shape the runner's preflight takes.
function isolatedGit({ args, cwd }) {
  return execFileSync("git", args, { cwd, env: { ...process.env, ...ISOLATED_GIT_VARS }, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
}

// A home with two real repositories, `alpha` dirty with an untracked source file and `beta` clean, and one job on each.
function makeTwoProjectQueue(t, name, attempts) {
  const env = { ...makeHome(t, name), ...ISOLATED_GIT_VARS };
  const alpha = initGitRepo(makeDir(t, `${name}-alpha`));
  const beta = initGitRepo(makeDir(t, `${name}-beta`));
  registerCheckout(env, { path: alpha, name: "alpha" });
  registerCheckout(env, { path: beta, name: "beta" });
  writeFileSync(join(alpha, "a.mjs"), "export const a = 1;\n");
  useFakeClaude(env, makeDir(t, `${name}-plan`), attempts);
  const a = addJob({ projectId: ensureProject(env, "alpha"), prompt: "fix the worker" }, env).id;
  const b = addJob({ projectId: ensureProject(env, "beta"), prompt: "fix the linter" }, env).id;
  return { env, alpha, a, b };
}

// Runs the real CLI in its own process, with the isolated home of the test.
function runCli(env, args) {
  return spawnSync(process.execPath, [CLI, ...args], { env, encoding: "utf8" });
}

test("a drain over [A blocked, B clean] runs B in the same pass, leaves A at a gate with the block as notice, and a noteless retry runs A once fixed", async (t) => {
  const attempts = [1, 2].map(() => ({ stdout: doneStream(), exitCode: 0 }));
  const { env, alpha, a, b } = makeTwoProjectQueue(t, "preflight-gate-drain", attempts);
  const slept = [];

  const passes = await runDrain({ env, cycles: 3, deps: { gitImpl: isolatedGit, sleepImpl: async (ms) => slept.push(ms) } });

  assert.equal(passes.length, 1, "the drain did not finish in a single pass");
  assert.deepEqual(passes[0].processed.map((result) => [result.id, result.status, result.code ?? null]), [[a, "gated", "dirty-checkout"], [b, "done", null]]);
  assert.equal(passes[0].reason, "empty-queue");
  assert.deepEqual(slept, [], "a gated job made the drain sleep");
  const gated = getJob(a, env);
  assert.deepEqual({ status: gated.status, attempts: gated.attempts, blockedCode: gated.blocked_code, note: gated.operator_note }, { status: "gate", attempts: 0, blockedCode: "dirty-checkout", note: null });
  assert.match(gated.notice_md, /^dirty-checkout: .* has uncommitted changes \(a\.mjs\)/);
  assert.equal(JSON.parse(gated.result).blocked.code, "dirty-checkout");

  rmSync(join(alpha, "a.mjs"));
  const retried = runCli(env, ["queue", "retry", `J-${a}`]);
  assert.equal(retried.status, 0, retried.stderr);
  assert.equal(getJob(a, env).status, "pending");
  const again = await runDrain({ env, cycles: 1, deps: { gitImpl: isolatedGit, sleepImpl: async () => {} } });
  assert.deepEqual(again[0].processed.map((result) => [result.id, result.status]), [[a, "done"]]);
});

test("a foreground drain prints exactly one gated line for the blocked job, and still runs the other one", (t) => {
  const { env, a, b } = makeTwoProjectQueue(t, "preflight-gate-cli", [{ stdout: doneStream(), exitCode: 0 }]);

  const ran = runCli(env, ["queue", "run", "--foreground"]);

  assert.equal(ran.status, 0, ran.stderr);
  const gatedLines = ran.stdout.split("\n").filter((line) => /^J-\d+ gated /.test(line));
  assert.deepEqual(gatedLines, [`J-${a} gated dirty-checkout`]);
  assert.match(ran.stdout, new RegExp(`^J-${b} done`, "m"));
  assert.equal(getJob(a, env).status, "gate");
});
