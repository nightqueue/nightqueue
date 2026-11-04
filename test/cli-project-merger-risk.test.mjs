import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultContext, run } from "../src/cli/index.mjs";
import { homeDir } from "../src/config/paths.mjs";
import { withProviders } from "../src/integrations/registry.mjs";
import { openDb } from "../src/memory/db.mjs";
import { projectMergerRisk, setProjectMergerRisk } from "../src/memory/registry.mjs";
import { DEFAULT_MERGER_RISK } from "../src/queue/merger-risk.mjs";
import { makeHome, makeProject, projectIdOf } from "../test-support/memory.mjs";
import { bindTrackerConnection, originProviders, trackerProvider } from "../test-support/origin-provider.mjs";

const MIGRATIONS = "src/memory/migration/**";

// A test provider with one boolean setting, so `project integrations` has something to store beside the risk list.
function settingsProviders() {
  return [originProviders()[0], { ...trackerProvider(), settings: { reply: { type: "boolean", default: true } } }];
}

// A temp home with the project `alpha`, its org bound to the tracker connection.
function makeRiskHome(t, name) {
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

test("`project merger-risk` lists the default, adds to it, removes from it and stores the result under `merger.risk`", async (t) => {
  const { env, projectId } = makeRiskHome(t, "risk-round-trip");
  const listed = await runCli(env, ["project", "merger-risk", "alpha", "--list"]);
  assert.equal(listed.code, 0, listed.err.join("\n"));
  assert.deepEqual(listed.out, ["source: default", ...DEFAULT_MERGER_RISK]);
  assert.equal(storedSettings(env, projectId), null, "listing wrote something");

  const added = await runCli(env, ["project", "merger-risk", "alpha", "--add", "src/memory/schema.mjs", "--add", MIGRATIONS]);
  assert.equal(added.code, 0, added.err.join("\n"));
  assert.deepEqual(added.out, ["source: project", ...DEFAULT_MERGER_RISK, "src/memory/schema.mjs", MIGRATIONS]);
  assert.deepEqual(storedSettings(env, projectId), { merger: { risk: [...DEFAULT_MERGER_RISK, "src/memory/schema.mjs", MIGRATIONS] } });

  const removed = await runCli(env, ["project", "merger-risk", "alpha", "--remove", "package.json", "--add", MIGRATIONS]);
  assert.equal(removed.code, 0, removed.err.join("\n"));
  assert.equal(removed.out.includes("package.json"), false, removed.out.join("\n"));
  assert.ok(removed.out.includes(MIGRATIONS));

  const json = JSON.parse((await runCli(env, ["project", "merger-risk", "alpha", "--json"])).out[0]);
  assert.equal(json.project, "alpha");
  assert.equal(json.source, "project");
  assert.deepEqual(json.risk, [...DEFAULT_MERGER_RISK.filter((pattern) => pattern !== "package.json"), "src/memory/schema.mjs", MIGRATIONS]);
});

test("a remove of a pattern not on the list or an invalid pattern is refused, naming it, and nothing is stored", async (t) => {
  const { env, projectId } = makeRiskHome(t, "risk-refusals");
  const cases = [
    [["--remove", "nope"], "`nope` is not on the merger risk list"],
    [["--add", "/abs"], "must be relative to the repository"],
    [["--add", "../x"], "cannot carry a .. segment"],
    [["--add", ""], "cannot be empty"],
  ];
  for (const [flags, message] of cases) {
    const refused = await runCli(env, ["project", "merger-risk", "alpha", "--add", MIGRATIONS, ...flags]);
    assert.equal(refused.code, 1, `${flags.join(" ")} was accepted`);
    assert.ok(refused.err.join("\n").includes(message), `${flags.join(" ")}: ${refused.err.join("\n")}`);
  }
  assert.equal(storedSettings(env, projectId), null, "a refused batch wrote its valid part");
  assert.equal((await runCli(env, ["project", "merger-risk", "nope"])).code, 1);
});

test("the CLI refuses a risk list change from inside a job, while listing still answers", async (t) => {
  const { env, projectId } = makeRiskHome(t, "risk-in-job");
  const inJob = { ...env, NIGHTQUEUE_JOB_ID: "9", NIGHTQUEUE_JOB_HOME: homeDir(env) };
  const refused = await runCli(inJob, ["project", "merger-risk", "alpha", "--add", MIGRATIONS]);
  assert.equal(refused.code, 1);
  assert.ok(refused.err.join("\n").includes("from inside J-9"), refused.err.join("\n"));
  assert.equal(storedSettings(env, projectId), null);
  const shown = await runCli(inJob, ["project", "merger-risk", "alpha"]);
  assert.equal(shown.code, 0, shown.err.join("\n"));
});

test("`project integrations` never shows the risk list and never drops it; `project models` keeps it too", async (t) => {
  const { env, projectId } = makeRiskHome(t, "risk-beside-integrations");
  await withProviders(settingsProviders(), async () => {
    await runCli(env, ["project", "merger-risk", "alpha", "--add", MIGRATIONS]);
    const json = JSON.parse((await runCli(env, ["project", "integrations", "alpha", "show", "--json"])).out[0]);
    assert.equal(JSON.stringify(json).includes("merger"), false, JSON.stringify(json));

    const set = await runCli(env, ["project", "integrations", "alpha", "set", "tracker.reply=false"]);
    assert.equal(set.code, 0, set.err.join("\n"));
    assert.deepEqual(storedSettings(env, projectId).merger.risk.at(-1), MIGRATIONS);
    await runCli(env, ["project", "integrations", "alpha", "unset", "tracker.reply"]);
    await runCli(env, ["project", "models", "alpha", "--set", "coder=sonnet"]);
    const stored = storedSettings(env, projectId);
    assert.deepEqual(stored.merger.risk, [...DEFAULT_MERGER_RISK, MIGRATIONS]);
    assert.deepEqual(stored.agents, { coder: { model: "sonnet" } });
  });
});

test("the registry stores an empty list as given, removes the list on null and refuses a malformed stored value", (t) => {
  const { env, projectId } = makeRiskHome(t, "risk-registry");
  const db = openDb(env);
  assert.equal(projectMergerRisk(db, projectId), null);
  assert.deepEqual(setProjectMergerRisk(db, { id: projectId, value: [" a.lock ", "a.lock"] }), ["a.lock"]);
  assert.deepEqual(setProjectMergerRisk(db, { id: projectId, value: [] }), []);
  assert.equal(setProjectMergerRisk(db, { id: projectId, value: null }), null);
  assert.equal(storedSettings(env, projectId), null);
  assert.throws(() => setProjectMergerRisk(db, { id: projectId, value: "a.lock" }), /must be a list of globs/);
  assert.throws(() => setProjectMergerRisk(db, { id: "nope", value: [] }), /unknown project id `nope`/);
  db.prepare("UPDATE projects SET integrations = ? WHERE id = ?").run(JSON.stringify({ merger: { risk: "x" } }), projectId);
  assert.throws(() => projectMergerRisk(db, projectId), /is not a list of globs/);
});
