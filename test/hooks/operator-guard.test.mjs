import assert from "node:assert/strict";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { COMMAND_NAMES } from "../../src/cli/index.mjs";
import { idTime, newId } from "../../src/config/ids.mjs";
import { configPath, dbPath, homeDir, runsDir, secretsPath } from "../../src/config/paths.mjs";
import { runAgentForeground } from "../../src/hooks/agent-foreground.mjs";
import { operatorDecision, personMcpTool } from "../../src/hooks/operator-guard.mjs";
import { operatorSettings, desiredHooks } from "../../src/host/settings.mjs";
import { SUBCOMMAND_NAMES as PROJECT_SUBCOMMANDS } from "../../src/cli/project.mjs";
import { SUBCOMMAND_NAMES as QUEUE_SUBCOMMANDS } from "../../src/cli/queue.mjs";
import { registeredCheckouts } from "../../src/memory/registry-access.mjs";
import { recordConsent } from "../../src/queue/operator-consent.mjs";
import { OPERATOR_CLI_COMMANDS, OPERATOR_SUBCOMMANDS, PIPELINE_AGENTS, pipelineAgent } from "../../src/queue/operator-scope.mjs";
import { makeDir, makeHome, makeProject } from "../../test-support/memory.mjs";

// An operator session's env over a temporary home with one registered checkout and a session id of its own.
function operatorFixture(t) {
  const home = makeHome(t, "operator-guard");
  const checkout = makeProject(t, home, "alpha");
  const env = { ...home, NIGHTQUEUE_MODE: "operator", NIGHTQUEUE_OPERATOR_SESSION: newId() };
  return { env, checkout, elsewhere: makeDir(t, "operator-guard-elsewhere") };
}

// The PreToolUse payload of the operator's main thread.
function main(toolName, toolInput, cwd = "/") {
  return { hook_event_name: "PreToolUse", session_id: "s-1", cwd, tool_name: toolName, tool_input: toolInput };
}

// The PreToolUse payload of one subagent of the operator.
function sub(agentType, toolName, toolInput, cwd = "/") {
  return { ...main(toolName, toolInput, cwd), agent_id: "a1", agent_type: agentType };
}

// Records one consent of project alpha in the fixture's session.
function consent(env, { kind, scope, answer = "yes, go ahead" }) {
  const project = registeredCheckouts(env).find((row) => row.name === "alpha");
  return recordConsent({ session: env.NIGHTQUEUE_OPERATOR_SESSION, project, kind, scope, reason: "the person asked for it", answer, env });
}

// Withdraws one consent of project alpha in the fixture's session.
function revoke(env, { kind, scope }) {
  const project = registeredCheckouts(env).find((row) => row.name === "alpha");
  return recordConsent({ session: env.NIGHTQUEUE_OPERATOR_SESSION, project, kind, scope, revoke: true, env });
}

// The guard's answer to one call.
function decide(input, env) {
  return operatorDecision({ input, env });
}

// Asserts the call is denied with a one-line operator guard reason.
function assertDenied(input, env) {
  const reason = decide(input, env);
  assert.ok(typeof reason === "string" && reason.startsWith("operator guard: "), `${JSON.stringify(input.tool_input)} -> ${reason}`);
  assert.equal(reason.includes("\n"), false);
}

// Asserts the call is allowed.
function assertAllowed(input, env) {
  assert.equal(decide(input, env), null, JSON.stringify(input.tool_input));
}

// Asserts the call is refused in the never band.
function assertNever(input, env) {
  assert.match(decide(input, env) ?? "", /^operator guard: never \(/, JSON.stringify(input.tool_input));
}

// Asserts a list splits into allowed and refused with every name exactly once.
function assertClassified({ allowed, refused }, names, label) {
  assert.equal(allowed.filter((name) => refused.includes(name)).length, 0, label);
  assert.deepEqual([...allowed, ...refused].sort(), [...names].sort(), label);
}

test("every top-level CLI command is classified for the operator exactly once, so the allowlist never widens silently", () => {
  assertClassified(OPERATOR_CLI_COMMANDS, COMMAND_NAMES, "top-level commands");
});

test("every subcommand of a family that writes files or widens the scope is classified exactly once", () => {
  const families = { queue: QUEUE_SUBCOMMANDS, project: PROJECT_SUBCOMMANDS };
  assert.deepEqual(Object.keys(OPERATOR_SUBCOMMANDS).sort(), Object.keys(families).sort());
  for (const [family, names] of Object.entries(families)) {
    assert.ok(OPERATOR_CLI_COMMANDS.allowed.includes(family), family);
    assertClassified(OPERATOR_SUBCOMMANDS[family], names, family);
  }
});

test("the main thread refuses the subcommands and flags that write files, widen its scope or start the runner", (t) => {
  const { env, checkout } = operatorFixture(t);
  const allowed = [
    "nightqueue project list",
    "nightqueue queue add --project alpha fix-it",
    "nightqueue queue run",
    "nightqueue doctor",
  ];
  for (const command of allowed) assertAllowed(main("Bash", { command }), env);
  for (const command of [`nightqueue project add ${checkout}`, "nightqueue project move alpha --path /tmp/elsewhere", "nightqueue queue add --project alpha fix-it --run", "nightqueue queue add --run=true x", "nightqueue doctor --fix --follow"]) {
    assertNever(main("Bash", { command }), env);
  }
  for (const command of ["nightqueue queue", "nightqueue decision list", "nightqueue decision show D-1"]) assertDenied(main("Bash", { command }), env);
});

test("doctor --fix is consented as a run from any directory, only by a consent naming it, and only on the main thread", (t) => {
  const { env } = operatorFixture(t);
  const fromHome = (command) => main("Bash", { command }, homeDir(env));
  const needs = /^operator guard: needs consent \(run nightqueue doctor --fix\)/;
  assert.match(decide(fromHome("nightqueue doctor --fix"), env), needs);
  assert.ok(decide(main("Bash", { command: "npm test" }), env).includes("`doctor --fix` only after a `run` consent"), "the free list does not say doctor --fix needs a run consent");
  assertAllowed(fromHome("nightqueue doctor --json"), env);
  consent(env, { kind: "run", scope: "nightqueue doctor" });
  assert.match(decide(fromHome("nightqueue doctor --fix"), env), needs, "a doctor consent widened to --fix");
  consent(env, { kind: "run", scope: "nightqueue doctor --fix" });
  assertAllowed(fromHome("nightqueue doctor --fix"), env);
  assertAllowed(main("Bash", { command: "nightqueue doctor --fix --json" }), env);
  assertAllowed(main("Bash", { command: "timeout 120 nightqueue doctor --fix" }), env);
  assert.match(decide(fromHome("nq doctor --fix"), env), /^operator guard: needs consent \(run nq doctor --fix\)/);
  assertNever(fromHome("nightqueue doctor --fix --follow"), env);
  assertNever(sub("nightqueue:reviewer", "Bash", { command: "nightqueue doctor --fix" }, homeDir(env)), env);
  for (const command of ["/abs/bin/nightqueue doctor --fix", "bin/nightqueue.mjs doctor --fix", "timeout 30 /abs/nightqueue doctor --fix"]) {
    assert.match(decide(fromHome(command), env), /never \(`doctor --fix` is consented only as `nightqueue doctor --fix`\)/, command);
  }
});

test("a backslash never smuggles a refused word past the main thread or a subagent", (t) => {
  const { env, checkout } = operatorFixture(t);
  const vectors = [
    `git -C ${checkout} log --out\\put=/tmp/x`,
    `git -C ${checkout} log --ext\\-diff`,
    "nightqueue queue ses\\sion",
    "nightqueue queue status --fol\\low",
    "nq queue status --fore\\ground",
    "r\\m -rf x",
  ];
  for (const command of vectors) {
    assertDenied(main("Bash", { command }), env);
    assertDenied(sub("nightqueue:explore", "Bash", { command }), env);
  }
  assertNever(main("Bash", { command: "r\\m -rf x" }), env);
});

test("the main thread runs its free Bash list with no consent, and anything else is refused", (t) => {
  const { env, checkout } = operatorFixture(t);
  const allowed = [
    "nightqueue queue status",
    "nightqueue doctor --json",
    `git -C ${checkout} log --oneline -5`,
    `git -C ${checkout} --no-optional-locks status`,
    `git -C ${checkout} branch --list`,
    `git -C ${checkout} show HEAD:README.md`,
    `cd ${checkout} && git log --oneline -5`,
  ];
  for (const command of allowed) assertAllowed(main("Bash", { command }), env);
  const refused = [
    "nq issues",
    "nightqueue sandbox ls",
    "nightqueue run dir",
    "nightqueue open",
    "nightqueue queue session J-1",
    "nightqueue queue status --follow",
    "nightqueue queue run --foreground",
    "nightqueue queue status; rm -rf x",
    "/usr/local/bin/nightqueue queue status",
    "git -C /tmp/other log",
    `git -C ${checkout} diff --output=x`,
    `git -C ${checkout} diff --out=x`,
    `git -C ${checkout} diff --no-index a b`,
    `git -C ${checkout} branch new`,
    `git -C ${checkout} branch --list -D x`,
    `git -C ${checkout} status`,
    `git -C ${checkout} -c core.pager=x log`,
    `git -C ${checkout} commit -m x`,
    "ls",
    "npm test",
    "git log",
  ];
  for (const command of refused) assertDenied(main("Bash", { command }), env);
});

test("the main thread reads anything on disk but the secrets file and `.env*` files", (t) => {
  const { env, checkout, elsewhere } = operatorFixture(t);
  assertAllowed(main("Read", { file_path: join(checkout, "src", "app.mjs") }), env);
  assertAllowed(main("Read", { file_path: join(elsewhere, "x") }), env);
  assertAllowed(main("Grep", { pattern: "x", path: join(runsDir(env), "p") }), env);
  assertAllowed(main("Read", { file_path: configPath(env) }), env);
  assertAllowed(main("Read", { file_path: dbPath(env) }), env);
  assertAllowed(main("Read", { file_path: "/etc/hosts" }), env);
  assertAllowed(main("Read", { file_path: join(checkout, "src", "env.mjs") }), env);
  assertAllowed(main("Read", { file_path: join(checkout, ".envrc") }), env);
  assertAllowed(main("Glob", { pattern: "*" }, join(env.NIGHTQUEUE_HOME)), env);
  assertAllowed(main("Grep", { pattern: "x", path: join(env.NIGHTQUEUE_HOME, "logs") }), env);
  assertDenied(main("Read", { file_path: secretsPath(env) }), env);
  assertDenied(main("Read", { file_path: join(checkout, ".env") }), env);
  assertDenied(main("Read", { file_path: join(checkout, "apps", "web", ".env.local") }), env);
  assertDenied(main("Read", {}), env);
});

test("a Grep over the home or a parent of it is refused: the sweep would read the secrets file below", (t) => {
  const { env, checkout } = operatorFixture(t);
  assertDenied(main("Grep", { pattern: "x", path: env.NIGHTQUEUE_HOME }), env);
  assertDenied(main("Grep", { pattern: "x", path: join(env.NIGHTQUEUE_HOME, "..") }), env);
  assertDenied(main("Grep", { pattern: "x" }, env.NIGHTQUEUE_HOME), env);
  assertAllowed(main("Grep", { pattern: "x", path: checkout }), env);
  assertAllowed(main("Glob", { pattern: "**/*.json", path: env.NIGHTQUEUE_HOME }), env);
  assert.match(decide(main("Grep", { pattern: "x", path: env.NIGHTQUEUE_HOME }), env), /narrow `path`/);
});

test("an absolute Glob pattern or Grep glob is judged by its own prefix, whatever path the call names", (t) => {
  const { env, checkout } = operatorFixture(t);
  assertAllowed(main("Glob", { path: checkout, pattern: "src/**/*.mjs" }), env);
  assertAllowed(main("Glob", { path: checkout, pattern: `${checkout}/src/*.mjs` }), env);
  assertAllowed(main("Glob", { path: checkout, pattern: `${env.NIGHTQUEUE_HOME}/*` }), env);
  assertAllowed(main("Glob", { path: checkout, pattern: "/etc/*" }), env);
  assertDenied(main("Glob", { path: checkout, pattern: secretsPath(env) }), env);
  assertDenied(main("Grep", { path: checkout, pattern: "x", glob: `${checkout}/.env` }), env);
  assertDenied(main("Glob", { pattern: "../src/*.mjs", path: checkout }), env);
  assertDenied(sub("nightqueue:explore", "Glob", { path: checkout, pattern: secretsPath(env) }), env);
});

test("the subagents read exactly where the operator reads, so delegation never reaches the secrets or a `.env*` file", (t) => {
  const { env, checkout, elsewhere } = operatorFixture(t);
  for (const type of ["nightqueue:triager", "nightqueue:reviewer", "nightqueue:coder"]) {
    assertAllowed(sub(type, "Read", { file_path: join(checkout, "src", "app.mjs") }), env);
    assertAllowed(sub(type, "Grep", { pattern: "x", path: elsewhere }), env);
    assertAllowed(sub(type, "Read", { file_path: "/etc/hosts" }), env);
    assertAllowed(sub(type, "Read", { file_path: configPath(env) }), env);
    assertDenied(sub(type, "Read", { file_path: secretsPath(env) }), env);
    assertDenied(sub(type, "Read", { file_path: join(checkout, ".env.production") }), env);
    assertDenied(sub(type, "Grep", { pattern: "x", path: env.NIGHTQUEUE_HOME }), env);
  }
});

test("an edit, Bash or Agent call whose tool_input is not an object is refused", (t) => {
  const { env } = operatorFixture(t);
  for (const tool of ["Edit", "Write", "MultiEdit", "NotebookEdit", "Bash", "Agent", "Task"]) {
    for (const toolInput of [null, undefined, "x", 7, []]) {
      assertDenied(main(tool, toolInput), env);
      assertDenied(sub("nightqueue:coder", tool, toolInput), env);
    }
  }
});

test("with no record a write in a checkout needs consent, edit for an existing file and create for a new one", (t) => {
  const { env, checkout } = operatorFixture(t);
  const existing = join(checkout, "README.md");
  writeFileSync(existing, "x\n");
  for (const tool of ["Edit", "Write", "MultiEdit"]) {
    assert.equal(decide(main(tool, { file_path: existing }), env), `operator guard: needs consent (edit ${existing}): ask the person (what, where, how to undo it), record the answer with operator_consent, then retry`);
  }
  assert.match(decide(main("Write", { file_path: join(checkout, "new.mjs") }), env), /^operator guard: needs consent \(create .*new\.mjs\)/);
  assert.match(decide(main("Edit", { file_path: join(checkout, "missing.mjs") }), env), /^operator guard: needs consent \(edit /);
});

test("after a consent covering the path the write passes, for the main thread and for the coder subagent", (t) => {
  const { env, checkout } = operatorFixture(t);
  mkdirSync(join(checkout, "src"), { recursive: true });
  mkdirSync(join(checkout, "test"), { recursive: true });
  for (const file of ["src/a.mjs", "test/a.mjs"]) writeFileSync(join(checkout, file), "x\n");
  consent(env, { kind: "edit", scope: join(checkout, "src") });
  for (const tool of ["Edit", "Write", "MultiEdit"]) {
    assertAllowed(main(tool, { file_path: join(checkout, "src", "a.mjs") }), env);
    assertAllowed(sub("nightqueue:coder", tool, { file_path: join(checkout, "src", "a.mjs") }), env);
    assert.match(decide(sub("nightqueue:coder", tool, { file_path: join(checkout, "test", "a.mjs") }), env), /^operator guard: needs consent \(edit /);
  }
  assert.match(decide(main("Write", { file_path: join(checkout, "src", "new.mjs") }), env), /^operator guard: needs consent \(create /, "an edit consent covered a create");
  consent(env, { kind: "create", scope: join(checkout, "src") });
  assertAllowed(sub("nightqueue:coder", "Write", { file_path: join(checkout, "src", "new.mjs") }), env);
});

test("a create consent never covers an edit of an existing file, and a create outside a checkout names one file", (t) => {
  const { env, checkout, elsewhere } = operatorFixture(t);
  writeFileSync(join(checkout, "a.mjs"), "x\n");
  consent(env, { kind: "create", scope: checkout });
  assert.match(decide(main("Write", { file_path: join(checkout, "a.mjs") }), env), /^operator guard: needs consent \(edit /);
  const findings = join(elsewhere, "findings.md");
  consent(env, { kind: "create", scope: findings });
  assertAllowed(main("Write", { file_path: findings }), env);
  assertDenied(main("Write", { file_path: join(elsewhere, "other.md") }), env);
  assert.throws(() => consent(env, { kind: "create", scope: elsewhere }), /names one file/);
  assert.throws(() => consent(env, { kind: "edit", scope: findings }), /stays in the checkout/);
  assert.match(decide(main("Edit", { file_path: join(elsewhere, "x.md") }), env), /^operator guard: edits stay in a registered checkout/);
});

test("the never band refuses deletes, force pushes, the home, settings and secrets even with a record that would match", (t) => {
  const { env, checkout } = operatorFixture(t);
  consent(env, { kind: "edit", scope: checkout });
  consent(env, { kind: "run", scope: "npm test" });
  consent(env, { kind: "git-write", scope: "push" });
  consent(env, { kind: "git-write", scope: "branch" });
  const commands = [
    "rm x",
    `cd ${checkout} && rm -rf build`,
    `cd ${checkout} && sudo rm -rf build`,
    `cd ${checkout} && npm test; rm -rf build`,
    `cd ${checkout} && find . -name x -delete`,
    `cd ${checkout} && find . -exec rm {} +`,
    `cd ${checkout} && ls | xargs rm`,
    `bash -c "rm -rf ${checkout}"`,
    `echo "$(rm -rf x)"`,
    `git -C ${checkout} push --force`,
    `git -C ${checkout} push -f origin main`,
    "git push --force-with-lease",
    "git push origin :b",
    "git push origin +main",
    "git branch -D b",
    "git reset --hard",
    "git clean -fd",
    `git -C ${checkout} rm a.mjs`,
    "cat .env",
    `git -C ${checkout} show HEAD:.env`,
    `git -C ${checkout} show HEAD:config/secrets.json`,
    `cat ${secretsPath(env)}`,
    `cp x ${join(homeDir(env), "config.json")}`,
    "cat ~/.nightqueue/config.json",
    "ls $HOME",
    "nightqueue queue add --run x",
    "nightqueue sandbox worktree alpha",
  ];
  for (const command of commands) {
    assertNever(main("Bash", { command }), env);
    assertNever(sub("nightqueue:coder", "Bash", { command }), env);
  }
  assertNever(main("Write", { file_path: join(homeDir(env), "config.json") }), env);
  assertNever(sub("nightqueue:coder", "Write", { file_path: join(checkout, ".claude", "settings.local.json") }), env);
  assertNever(main("Edit", { file_path: join(checkout, ".env") }), env);
  assertNever(main("Write", { file_path: join(env.CLAUDE_CONFIG_DIR ?? join(env.HOME, ".claude"), "settings.json") }), env);
});

test("a symlink in a checkout that points into the home is judged by where it really points", (t) => {
  const { env, checkout } = operatorFixture(t);
  mkdirSync(homeDir(env), { recursive: true });
  writeFileSync(configPath(env), "{}\n");
  symlinkSync(configPath(env), join(checkout, "link.json"));
  consent(env, { kind: "edit", scope: checkout });
  assertNever(main("Write", { file_path: join(checkout, "link.json") }), env);
});

test("a never-band scope is never recorded", (t) => {
  const { env, checkout } = operatorFixture(t);
  assert.throws(() => consent(env, { kind: "edit", scope: join(homeDir(env), "config.json") }), /never band/);
  assert.throws(() => consent(env, { kind: "edit", scope: join(checkout, ".env") }), /never band/);
  assert.throws(() => consent(env, { kind: "run", scope: "rm -rf build" }), /never band/);
  assert.throws(() => consent(env, { kind: "git-write", scope: "push --force" }), /never band/);
  assert.throws(() => consent(env, { kind: "git-write", scope: "log" }), /writes/);
  assert.throws(() => consent(env, { kind: "run", scope: "npm test | tail" }), /one bare command/);
});

test("a run consent covers exactly its command in the project's checkout, and nothing chained", (t) => {
  const { env, checkout } = operatorFixture(t);
  assert.match(decide(main("Bash", { command: `cd ${checkout} && npm test` }), env), /^operator guard: needs consent \(run npm test\)/);
  consent(env, { kind: "run", scope: "npm test" });
  for (const command of [`cd ${checkout} && npm test`, `cd ${checkout} && npm test -- --grep x`, `cd ${checkout} && timeout 60 npm test`]) {
    assertAllowed(main("Bash", { command }), env);
    assertAllowed(sub("nightqueue:verifier", "Bash", { command }), env);
  }
  assertAllowed(main("Bash", { command: "npm test" }, checkout), env);
  assert.match(decide(main("Bash", { command: `cd ${checkout} && npm run build` }), env), /^operator guard: needs consent \(run npm run build\)/);
  assert.match(decide(main("Bash", { command: "npm test" }, env.NIGHTQUEUE_HOME), env), /outside every registered checkout/);
  assert.match(decide(main("Bash", { command: `cd ${checkout} && npm test | tail` }), env), /chains, pipes or redirects/);
  assert.match(decide(main("Bash", { command: "cd src && npm test" }), env), /absolute directory/);
});

test("a git-write consent covers its subcommand only, in either anchored form", (t) => {
  const { env, checkout } = operatorFixture(t);
  consent(env, { kind: "git-write", scope: "git commit" });
  assertAllowed(main("Bash", { command: `git -C ${checkout} commit -m "x"` }), env);
  assertAllowed(sub("nightqueue:coder", "Bash", { command: `cd ${checkout} && git commit -m x` }), env);
  assert.match(decide(main("Bash", { command: `git -C ${checkout} push` }), env), /^operator guard: needs consent \(git-write /);
  assert.match(decide(main("Bash", { command: `git -C ${checkout} --git-dir=/tmp/x commit -m x` }), env), /--git-dir/);
});

test("a revoke withdraws the consent, and another session's record or no session never counts", (t) => {
  const { env, checkout } = operatorFixture(t);
  const file = join(checkout, "a.mjs");
  writeFileSync(file, "x\n");
  consent(env, { kind: "edit", scope: checkout });
  assertAllowed(main("Edit", { file_path: file }), env);
  assertDenied(main("Edit", { file_path: file }), { ...env, NIGHTQUEUE_OPERATOR_SESSION: newId() });
  const { NIGHTQUEUE_OPERATOR_SESSION, ...noSession } = env;
  assert.ok(NIGHTQUEUE_OPERATOR_SESSION);
  assert.match(decide(main("Edit", { file_path: file }), noSession), /^operator guard: needs consent/);
  assert.match(decide(main("Edit", { file_path: file }), { ...env, NIGHTQUEUE_JOB_ID: "7" }), /^operator guard: needs consent/);
  assert.equal(revoke(env, { kind: "edit", scope: checkout }).revoked, 1);
  assert.match(decide(main("Edit", { file_path: file }), env), /^operator guard: needs consent/);
  assert.throws(() => revoke(env, { kind: "edit", scope: checkout }), /no live consent/);
});

test("the main thread launches every pipeline agent under a plugin-scoped spelling, and nothing else", (t) => {
  const { env } = operatorFixture(t);
  for (const type of ["nightqueue:coder", "plugin_nightqueue_verifier", "nightqueue:triager", "nightqueue:reviewer"]) {
    assertAllowed(main("Agent", { prompt: "p", subagent_type: type }), env);
  }
  for (const type of ["nightqueue:triage", "nightqueue:qa", "nightqueue:nightqueue-operator", "coder", "general-purpose", "Explore", undefined]) {
    assertDenied(main("Task", { prompt: "p", subagent_type: type }), env);
  }
});

test("PIPELINE_AGENTS names the plugin's agents but the operator, and pipelineAgent accepts only the plugin-scoped spellings", () => {
  assert.equal(pipelineAgent("nightqueue:coder"), "coder");
  assert.equal(pipelineAgent(" plugin_nightqueue_qa-guardian "), "qa-guardian");
  for (const type of ["coder", "qa", "nightqueue:qa", "nightqueue:triage", "other:coder", "", null, 7]) assert.equal(pipelineAgent(type), null);
  assert.equal(PIPELINE_AGENTS.includes("nightqueue-operator"), false);
});

test("a subagent runs its free reads with no consent, gh reads and nightqueue libs included", (t) => {
  const { env, checkout } = operatorFixture(t);
  assert.match(decide(sub("nightqueue:triager", "Write", { file_path: join(checkout, "x") }), env), /^operator guard: needs consent \(create /);
  assertAllowed(sub("nightqueue:reviewer", "Bash", { command: "gh pr diff 12" }), env);
  assertAllowed(sub("nightqueue:triager", "Bash", { command: `git -C ${checkout} blame src/a.mjs` }), env);
  assertAllowed(sub("nightqueue:explore", "Bash", { command: "nightqueue libs zod" }), env);
  assertDenied(sub("nightqueue:triager", "Bash", { command: "gh pr merge 12" }), env);
  assertDenied(sub("nightqueue:triager", "Bash", { command: "gh constructor x" }), env);
});

test("a subagent runs only the nightqueue reads, never a command the main thread may run to record or remove", (t) => {
  const { env } = operatorFixture(t);
  const allowed = [
    "nightqueue queue status",
    "nightqueue queue log J-1",
    "nightqueue project list",
    "nightqueue doctor --json",
    "nightqueue version",
  ];
  for (const command of allowed) assertAllowed(sub("nightqueue:reviewer", "Bash", { command }), env);
  const refused = [
    "nq issues",
    "nightqueue issues show I-1",
    "nightqueue queue close J-1",
    "nightqueue queue add x",
    "nightqueue queue run",
    "nightqueue project remove alpha --purge",
    "nightqueue connection remove gh",
    "nightqueue decision update D-1 --status superseded",
    "nightqueue decision list",
    "nightqueue decision show D-1",
    "nightqueue doctor --fix",
    "nightqueue queue status --follow",
    "nightqueue constructor",
  ];
  for (const command of refused) assertDenied(sub("nightqueue:reviewer", "Bash", { command }), env);
});

test("a failure inside the guard refuses an edit or a Bash call and lets a read through", (t) => {
  const { env } = operatorFixture(t);
  const hostile = {};
  Object.defineProperty(hostile, "command", { enumerable: true, get() { throw new Error("boom"); } });
  Object.defineProperty(hostile, "file_path", { enumerable: true, get() { throw new Error("boom"); } });
  assert.match(decide(main("Bash", hostile), env), /^operator guard: .*boom/);
  assert.match(decide(sub("nightqueue:coder", "Write", hostile), env), /^operator guard: .*boom/);
  assert.equal(decide(main("Read", hostile), env), null);
});

test("the person's own MCP tools pass to the host prompt by a named branch, and the nightqueue tools keep today's path", (t) => {
  const { env } = operatorFixture(t);
  const tools = [
    "mcp__nightqueue__queue_add", "mcp__nightqueue__operator_consent", "mcp__nightqueue__connection_call",
    "mcp__linear__create_issue", "mcp__sentry__x", "mcp__plugin_foo_bar__x",
  ];
  for (const tool of tools) {
    assertAllowed(main(tool, { title: "x" }), env);
    assertAllowed(sub("nightqueue:coder", tool, { title: "x" }), env);
    assertAllowed(main(tool, "not an object"), env);
  }
});

test("personMcpTool names every MCP tool but the nightqueue server's", () => {
  const table = [
    ["mcp__linear__x", true], ["mcp__plugin_foo_bar__x", true], ["mcp__nightqueue_evil__x", true],
    ["mcp__nightqueue__queue_add", false], ["Bash", false], [undefined, false],
  ];
  for (const [tool, expected] of table) assert.equal(personMcpTool(tool), expected, String(tool));
});

// Claude Code's hook precedence is `deny` > `defer` > `ask` > `allow` (https://code.claude.com/docs/en/hooks), so this deny beats a user allow rule.
test("a user-level permissions.allow for Bash never bypasses the consent band: the hook still answers deny", (t) => {
  const { env, checkout } = operatorFixture(t);
  const claudeDir = makeDir(t, "operator-guard-user-settings");
  writeFileSync(join(claudeDir, "settings.json"), JSON.stringify({ permissions: { allow: ["Bash", "Edit", "Write", "mcp__linear__*"] } }));
  const withUserAllow = { ...env, CLAUDE_CONFIG_DIR: claudeDir };
  const answer = JSON.parse(runAgentForeground({ input: main("Bash", { command: `cd ${checkout} && npm test` }), env: withUserAllow }));
  assert.equal(answer.hookSpecificOutput.permissionDecision, "deny");
  assert.match(answer.hookSpecificOutput.permissionDecisionReason, /^operator guard: needs consent \(run /);
  consent(withUserAllow, { kind: "run", scope: "npm test" });
  assert.equal(runAgentForeground({ input: main("Bash", { command: `cd ${checkout} && npm test` }), env: withUserAllow }), "");
});

test("idTime reads back the time a fresh id was made at, and null for a non-id", () => {
  const now = Date.now() + 3_600_000;
  assert.equal(idTime(newId(now)), now);
  assert.equal(idTime("not-an-id"), null);
});

test("the operator's settings fence the edit tools while the host's hooks keep their matcher", (t) => {
  const env = makeHome(t, "operator-settings");
  const settings = operatorSettings(env);
  assert.equal(settings.hooks.PreToolUse[0].matcher, "Agent|Task|Bash|Read|Grep|Glob|Edit|Write|MultiEdit|NotebookEdit");
  assert.deepEqual(settings.permissions, { allow: ["mcp__nightqueue__*", "WebFetch", "WebSearch"] });
  assert.equal(settings.hooks.SubagentStop, undefined, "the operator settings still wire a SubagentStop hook");
  assert.equal(desiredHooks(env).find(({ event }) => event === "PreToolUse").matcher, "Agent|Task|Bash|Read|Grep|Glob");
});
