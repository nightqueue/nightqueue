import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { jobLogPath, homeDir } from "../../src/config/paths.mjs";
import { packageRoot } from "../../src/host/paths.mjs";
import {
  buildArgs,
  buildPrompt,
  cliEntrypoint,
  IDLE_TIMEOUT_S,
  mcpConfigArg,
  pluginDir,
  resolveClaudeBin,
  spawnClaude,
} from "../../src/queue/spawn.mjs";
import { makeDir, makeHome } from "../../test-support/memory.mjs";
import { argValue, FAKE_CLAUDE, fakeCalls, useFakeClaude } from "../../test-support/queue-fake.mjs";
import { doneStream, SESSION_ID } from "../../test-support/streams.mjs";

const JOB = { id: 7, project: "alpha", prompt: "fix the worker", timeout_s: 14400 };

// A home whose `claude` is the fake script, with the plan the fake plays.
function makeSpawnHome(t, name, attempts) {
  const env = makeHome(t, name);
  const planPath = useFakeClaude(env, makeDir(t, `${name}-plan`), attempts);
  return { env, planPath };
}

test("the command carries the plugin of this package and the nightshift MCP server, and never --strict-mcp-config", (t) => {
  const env = makeHome(t, "spawn-args");
  const args = buildArgs({ prompt: "do the work", env });

  assert.equal(args.includes("--strict-mcp-config"), false, "the argv fenced the child off from the host configuration");
  assert.deepEqual(args.slice(0, 8), ["-p", "do the work", "--permission-mode", "bypassPermissions", "--output-format", "stream-json", "--verbose", "--plugin-dir"]);
  assert.equal(argValue(args, "--plugin-dir"), pluginDir());
  assert.equal(pluginDir(), join(packageRoot(), "plugin"));
  assert.equal(existsSync(join(pluginDir(), "skills", "resolve", "SKILL.md")), true, "--plugin-dir does not point at the plugin of this package");

  const mcp = JSON.parse(argValue(args, "--mcp-config"));
  assert.deepEqual(Object.keys(mcp.mcpServers), ["nightshift"]);
  assert.equal(mcp.mcpServers.nightshift.command, process.execPath);
  assert.deepEqual(mcp.mcpServers.nightshift.args, [cliEntrypoint(), "mcp"]);
  assert.equal(cliEntrypoint(), join(packageRoot(), "bin", "nightshift.mjs"));
  assert.equal(existsSync(cliEntrypoint()), true, "the entrypoint handed to the child does not exist");
  assert.equal(mcp.mcpServers.nightshift.env.NIGHTSHIFT_HOME, homeDir(env));
});

test("the MCP server of an unattended child is pinned to the job it runs, and an operator session carries no job at all", (t) => {
  const env = makeHome(t, "spawn-mcp-job-scope");

  const owned = JSON.parse(mcpConfigArg(env, 7)).mcpServers.nightshift.env;
  assert.equal(owned.NIGHTSHIFT_JOB_ID, "7");
  assert.equal(owned.NIGHTSHIFT_HOME, homeDir(env));

  const operator = JSON.parse(mcpConfigArg(env)).mcpServers.nightshift.env;
  assert.equal("NIGHTSHIFT_JOB_ID" in operator, false, "an operator session pinned a job identity it does not have");

  const args = buildArgs({ prompt: "do the work", env, jobId: 7 });
  assert.equal(JSON.parse(argValue(args, "--mcp-config")).mcpServers.nightshift.env.NIGHTSHIFT_JOB_ID, "7");
  assert.equal(
    "NIGHTSHIFT_JOB_ID" in JSON.parse(argValue(buildArgs({ prompt: "p", env }), "--mcp-config")).mcpServers.nightshift.env,
    false,
  );
});

test("--resume is only appended for a session id that is safe as argv", (t) => {
  const env = makeHome(t, "spawn-resume");
  assert.equal(buildArgs({ prompt: "p", env }).includes("--resume"), false);
  assert.equal(argValue(buildArgs({ prompt: "p", resumeSessionId: SESSION_ID, env }), "--resume"), SESSION_ID);
  for (const unsafe of ["--dangerous", "short", "id.with.dots", null]) {
    assert.equal(buildArgs({ prompt: "p", resumeSessionId: unsafe, env }).includes("--resume"), false, `\`${String(unsafe)}\` became argv`);
  }
});

test("the prompt asks for the pipeline, the slug line and the gate, and carries the answer of the operator", () => {
  const prompt = buildPrompt({ job: { ...JOB, operator_note: "ship without the migration" } });
  assert.match(prompt, /^\/nightshift:resolve fix the worker\n/);
  assert.match(prompt, /job #7/);
  assert.match(prompt, /QUEUE_SLUG: <slug>/);
  assert.match(prompt, /OPERATOR ANSWER TO THE GATE: ship without the migration/);
  assert.equal(buildPrompt({ job: JOB }).includes("OPERATOR ANSWER TO THE GATE"), false);
  assert.equal(buildPrompt({ job: JOB }).includes("RESUME:"), false);

  const resumed = buildPrompt({ job: JOB, resume: { resume: true, lastPhase: "explore", fromPhase: "architecture" } });
  assert.match(resumed, /RESUME: a previous run of this job stopped after the `explore` phase\./);
  assert.match(resumed, /Resume from the `architecture` phase/);
});

test("the prompt carries the operator's tier only when the job has one", () => {
  const tiered = buildPrompt({ job: { ...JOB, tier: "simple" } });
  assert.ok(
    tiered.includes(
      "Tier: simple (set by the operator - the pipeline may only raise it, with evidence, never lower it)",
    ),
    tiered,
  );
  for (const tier of [null, undefined, "", "   "]) {
    assert.equal(
      buildPrompt({ job: { ...JOB, tier } }).includes("Tier:"),
      false,
      `\`${String(tier)}\` still produced a tier line`,
    );
  }
  assert.equal(buildPrompt({ job: JOB }).includes("Tier:"), false);
});

test("a spawned attempt streams every line, appends its own separator to the log and reports the exit code", async (t) => {
  const { env, planPath } = makeSpawnHome(t, "spawn-run", [{ stdout: doneStream(), exitCode: 0 }]);
  const logPath = jobLogPath(JOB.id, env);
  const lines = [];

  const result = await spawnClaude({ prompt: "run it", cwd: makeDir(t, "spawn-cwd"), timeoutS: 30, logPath, env, attempt: 2, jobId: JOB.id, onLine: (line) => lines.push(line) });

  assert.deepEqual({ exitCode: result.exitCode, timedOut: result.timedOut, stopped: result.stopped, spawnError: result.spawnError }, { exitCode: 0, timedOut: false, stopped: false, spawnError: null });
  assert.equal(lines.length, doneStream().trim().split("\n").length);
  assert.match(readFileSync(logPath, "utf8"), /^=== attempt 2 @ \d{4}-\d{2}-\d{2}T[\d:.]+Z ===$/m);
  assert.match(result.log, /"type":"result"/);

  const [call] = fakeCalls(planPath);
  assert.equal(call.jobId, String(JOB.id), "the child did not get NIGHTSHIFT_JOB_ID");
  assert.equal(argValue(call.argv, "--plugin-dir"), pluginDir());
  assert.equal(call.argv.includes("--strict-mcp-config"), false);
  assert.equal(JSON.parse(argValue(call.argv, "--mcp-config")).mcpServers.nightshift.command, process.execPath);
});

test("a run that says nothing for too long dies of the idle timeout, which defaults to twenty minutes", async (t) => {
  assert.equal(IDLE_TIMEOUT_S, 1200);
  const { env } = makeSpawnHome(t, "spawn-idle", [{ stdout: '{"type":"system"}\n', holdMs: 4000, exitCode: 0 }]);

  const result = await spawnClaude({ prompt: "run it", timeoutS: 30, idleTimeoutS: 0.4, logPath: jobLogPath(1, env), env });

  assert.equal(result.idleTimedOut, true, "the silent child was left running");
  assert.notEqual(result.exitCode, 0);
});

test("a run that never ends dies of the total timeout, however talkative it is", async (t) => {
  const { env } = makeSpawnHome(t, "spawn-timeout", [{ stdout: '{"type":"system"}\n', holdMs: 4000, exitCode: 0 }]);

  const result = await spawnClaude({ prompt: "run it", timeoutS: 0.4, idleTimeoutS: 30, logPath: jobLogPath(1, env), env });

  assert.deepEqual({ timedOut: result.timedOut, idleTimedOut: result.idleTimedOut }, { timedOut: true, idleTimedOut: false });
  assert.notEqual(result.exitCode, 0);
});

test("the ownership poll ends the child as soon as the job stops being ours", async (t) => {
  const { env } = makeSpawnHome(t, "spawn-stop", [{ stdout: '{"type":"system"}\n', holdMs: 4000, exitCode: 0 }]);
  let polls = 0;

  const result = await spawnClaude({
    prompt: "run it",
    timeoutS: 30,
    idleTimeoutS: 30,
    logPath: jobLogPath(1, env),
    env,
    stopPollMs: 500,
    stopSignalImpl: () => {
      polls += 1;
      return polls > 1;
    },
  });

  assert.deepEqual({ stopped: result.stopped, timedOut: result.timedOut }, { stopped: true, timedOut: false });
  assert.ok(polls >= 2, `the poll ran ${polls} times`);
});

test("a binary that is not there comes back as an actionable message, never as a crash", async (t) => {
  const env = makeHome(t, "spawn-missing");
  const logPath = jobLogPath(1, env);

  const result = await spawnClaude({ prompt: "run it", timeoutS: 30, logPath, env, resolveBinImpl: () => ({ bin: join(makeDir(t, "empty-bin"), "claude"), via: "env" }) });

  assert.equal(result.exitCode, -1);
  assert.match(result.spawnError, /NIGHTSHIFT_CLAUDE_BIN/);
  assert.match(readFileSync(logPath, "utf8"), /NIGHTSHIFT_CLAUDE_BIN/);
});

test("the environment override wins over the PATH, and a relative override is ignored", (t) => {
  const env = makeHome(t, "spawn-bin");
  env.NIGHTSHIFT_CLAUDE_BIN = FAKE_CLAUDE;
  assert.deepEqual(resolveClaudeBin(env), { bin: FAKE_CLAUDE, via: "env" });
  assert.notEqual(resolveClaudeBin({ ...env, NIGHTSHIFT_CLAUDE_BIN: "./claude" }).via, "env");
});
