import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultContext, run } from "../src/cli/index.mjs";
import { homeDir } from "../src/config/paths.mjs";
import { withProviders } from "../src/integrations/registry.mjs";
import { openDb } from "../src/memory/db.mjs";
import { projectAgents, projectIntegrations, setProjectAgents, setProjectIntegrations } from "../src/memory/registry.mjs";
import { AGENT_MODELS } from "../src/queue/routing.mjs";
import { makeHome, makeProject, projectIdOf } from "../test-support/memory.mjs";
import { bindTrackerConnection, originProviders, trackerProvider } from "../test-support/origin-provider.mjs";

// A test provider with one boolean setting, so `project integrations` has something to store beside the agents.
function settingsProviders() {
  return [originProviders()[0], { ...trackerProvider(), settings: { reply: { type: "boolean", default: true } } }];
}

// A temp home with the project `alpha`, its org bound to the tracker connection.
function makeModelsHome(t, name) {
  const env = makeHome(t, name);
  makeProject(t, env, "alpha");
  const projectId = projectIdOf(env, "alpha");
  bindTrackerConnection(env, projectId);
  return { env, projectId };
}

// The raw settings column of a project, parsed, or null.
function storedSettings(env, projectId) {
  const text = openDb(env).prepare("SELECT integrations FROM projects WHERE id = ?").get(projectId).integrations;
  return text === null ? null : JSON.parse(text);
}

// Runs the CLI in this process, collecting what it printed.
async function runCli(env, argv) {
  const out = [];
  const err = [];
  const code = await run(argv, { ...defaultContext(), env, out: (line) => out.push(line), err: (line) => err.push(line) });
  return { code, out, err };
}

// The lines `project models` prints with every agent on its default, but the ones given.
function modelLines(overrides = {}) {
  return Object.entries(AGENT_MODELS).map(([agent, model]) => (overrides[agent] ? `${agent}=${overrides[agent]} (project)` : `${agent}=${model} (default)`));
}

test("`project models` shows every agent on its default, sets and unsets an override, and stores it under `agents`", async (t) => {
  const { env, projectId } = makeModelsHome(t, "models-round-trip");
  const shown = await runCli(env, ["project", "models", "alpha"]);
  assert.equal(shown.code, 0, shown.err.join("\n"));
  assert.deepEqual(shown.out, modelLines());

  const set = await runCli(env, ["project", "models", "alpha", "--set", "coder=sonnet", "--set", "verifier=opus"]);
  assert.equal(set.code, 0, set.err.join("\n"));
  assert.deepEqual(set.out, modelLines({ coder: "sonnet", verifier: "opus" }));
  assert.deepEqual(storedSettings(env, projectId), { agents: { coder: { model: "sonnet" }, verifier: { model: "opus" } } });

  const json = await runCli(env, ["project", "models", "alpha", "--json"]);
  const answer = JSON.parse(json.out[0]);
  assert.equal(answer.project, "alpha");
  assert.deepEqual(answer.agents.coder, { model: "sonnet", source: "project" });
  assert.deepEqual(answer.agents.architect, { model: "opus", source: "default" });

  await runCli(env, ["project", "models", "alpha", "--unset", "coder"]);
  assert.deepEqual(storedSettings(env, projectId), { agents: { verifier: { model: "opus" } } });
  const cleared = await runCli(env, ["project", "models", "alpha", "--unset", "verifier"]);
  assert.deepEqual(cleared.out, modelLines());
  assert.equal(storedSettings(env, projectId), null, "the last unset leaves the column NULL");
});

test("an unknown agent, the merger, a model outside the aliases or a bad assignment is refused, and nothing is stored", async (t) => {
  const { env, projectId } = makeModelsHome(t, "models-refusals");
  const cases = [
    [["--set", "nobody=opus"], "unknown agent `nobody`; accepted: triager, explore, architect, coder, qa-analyst, qa-prover, verifier, reflector"],
    [["--set", "merger=opus"], "unknown agent `merger`"],
    [["--set", "coder=gpt"], "unknown model `gpt`; accepted: opus, sonnet, haiku"],
    [["--set", "coder"], "`coder` is not <agent>=<model>"],
    [["--unset", "nobody"], "unknown agent `nobody`"],
  ];
  for (const [flags, message] of cases) {
    const refused = await runCli(env, ["project", "models", "alpha", "--set", "architect=sonnet", ...flags]);
    assert.equal(refused.code, 1, `${flags.join(" ")} was accepted`);
    assert.ok(refused.err.join("\n").includes(message), `${flags.join(" ")}: ${refused.err.join("\n")}`);
  }
  assert.equal(storedSettings(env, projectId), null, "a refused batch wrote its valid part");
  const unknown = await runCli(env, ["project", "models", "nope"]);
  assert.equal(unknown.code, 1);
});

test("the CLI refuses a model change from inside a job, while showing still answers", async (t) => {
  const { env, projectId } = makeModelsHome(t, "models-in-job");
  const inJob = { ...env, NIGHTQUEUE_JOB_ID: "9", NIGHTQUEUE_JOB_HOME: homeDir(env) };
  const refused = await runCli(inJob, ["project", "models", "alpha", "--set", "coder=sonnet"]);
  assert.equal(refused.code, 1);
  assert.ok(refused.err.join("\n").includes("from inside J-9"), refused.err.join("\n"));
  assert.equal(storedSettings(env, projectId), null);
  const shown = await runCli(inJob, ["project", "models", "alpha"]);
  assert.equal(shown.code, 0, shown.err.join("\n"));
});

test("`project integrations` never shows the agents and never drops them on a set or an unset", async (t) => {
  const { env, projectId } = makeModelsHome(t, "models-beside-integrations");
  await withProviders(settingsProviders(), async () => {
    await runCli(env, ["project", "models", "alpha", "--set", "coder=sonnet"]);
    const empty = await runCli(env, ["project", "integrations", "alpha", "show"]);
    assert.equal(empty.out.some((line) => line.includes("agents") || line.includes("coder")), false, empty.out.join("\n"));
    const json = JSON.parse((await runCli(env, ["project", "integrations", "alpha", "show", "--json"])).out[0]);
    assert.equal(JSON.stringify(json).includes("agents"), false, JSON.stringify(json));

    const set = await runCli(env, ["project", "integrations", "alpha", "set", "tracker.reply=false"]);
    assert.equal(set.code, 0, set.err.join("\n"));
    assert.deepEqual(storedSettings(env, projectId), { tracker: { reply: false }, agents: { coder: { model: "sonnet" } } });
    const shown = await runCli(env, ["project", "integrations", "alpha", "show"]);
    assert.equal(shown.out.some((line) => line.includes("agents")), false, shown.out.join("\n"));

    await runCli(env, ["project", "integrations", "alpha", "unset", "tracker.reply"]);
    assert.deepEqual(storedSettings(env, projectId), { agents: { coder: { model: "sonnet" } } });
    const models = await runCli(env, ["project", "models", "alpha"]);
    assert.ok(models.out.includes("coder=sonnet (project)"), models.out.join("\n"));

    await runCli(env, ["project", "models", "alpha", "--unset", "coder"]);
    assert.equal(storedSettings(env, projectId), null);
  });
});

test("the registry keeps the agents and the integrations apart: each read sees only its own, each write keeps the other", (t) => {
  const { env, projectId } = makeModelsHome(t, "models-registry");
  const db = openDb(env);
  setProjectAgents(db, { id: projectId, value: { coder: { model: "sonnet" } } });
  assert.equal(projectIntegrations(db, projectId), null, "a project with only agents has no integrations");
  assert.deepEqual(projectAgents(db, projectId), { coder: { model: "sonnet" } });

  setProjectIntegrations(db, { id: projectId, value: { tracker: { reply: false }, agents: { coder: { model: "haiku" } } } });
  assert.deepEqual(projectIntegrations(db, projectId), { tracker: { reply: false } });
  assert.deepEqual(projectAgents(db, projectId), { coder: { model: "sonnet" } }, "an integrations write never changes the agents");

  setProjectAgents(db, { id: projectId, value: { verifier: { model: "opus", extra: true } } });
  assert.deepEqual(projectIntegrations(db, projectId), { tracker: { reply: false } }, "an agents write never drops the integrations");
  assert.deepEqual(projectAgents(db, projectId), { verifier: { model: "opus" } });

  setProjectIntegrations(db, { id: projectId, value: null });
  assert.deepEqual(storedSettings(env, projectId), { agents: { verifier: { model: "opus" } } });
  setProjectAgents(db, { id: projectId, value: {} });
  assert.equal(storedSettings(env, projectId), null);

  assert.throws(() => setProjectAgents(db, { id: projectId, value: { coder: { model: "gpt" } } }), /unknown model `gpt`/);
  assert.throws(() => setProjectAgents(db, { id: projectId, value: ["coder"] }), /project agents must be an object/);
  assert.throws(() => setProjectAgents(db, { id: "nope", value: null }), /unknown project id `nope`/);
});
