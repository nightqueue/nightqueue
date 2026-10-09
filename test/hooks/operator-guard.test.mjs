import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { COMMAND_NAMES } from "../../src/cli/index.mjs";
import { idTime, newId } from "../../src/config/ids.mjs";
import { qaDir, runsDir, secretsPath } from "../../src/config/paths.mjs";
import { operatorDecision } from "../../src/hooks/operator-guard.mjs";
import { operatorSettings, desiredHooks } from "../../src/host/settings.mjs";
import { SUBCOMMAND_NAMES as DECISION_SUBCOMMANDS } from "../../src/cli/decision.mjs";
import { SUBCOMMAND_NAMES as PROJECT_SUBCOMMANDS } from "../../src/cli/project.mjs";
import { SUBCOMMAND_NAMES as QUEUE_SUBCOMMANDS } from "../../src/cli/queue.mjs";
import { OPERATOR_CLI_COMMANDS, OPERATOR_SUBCOMMANDS, agentRole } from "../../src/queue/operator-scope.mjs";
import { makeHome, makeProject, projectIdOf } from "../../test-support/memory.mjs";

// An operator session's env over a temporary home with one registered checkout, and the qa worktree path of that project.
function operatorFixture(t) {
  const home = makeHome(t, "operator-guard");
  const checkout = makeProject(t, home, "alpha");
  const env = { ...home, NIGHTQUEUE_MODE: "operator" };
  const qaWorktree = join(qaDir(env), projectIdOf(env, "alpha"), newId());
  return { env, checkout, qaWorktree };
}

// The PreToolUse payload of the operator's main thread.
function main(toolName, toolInput, cwd = "/") {
  return { hook_event_name: "PreToolUse", session_id: "s-1", cwd, tool_name: toolName, tool_input: toolInput };
}

// The PreToolUse payload of one subagent of the operator.
function sub(agentType, toolName, toolInput) {
  return { ...main(toolName, toolInput), agent_id: "a1", agent_type: agentType };
}

// Asserts the call is denied with a one-line D-58 reason.
function assertDenied(input, env) {
  const reason = operatorDecision({ input, env });
  assert.ok(typeof reason === "string" && reason.startsWith("D-58: "), `${JSON.stringify(input.tool_input)} -> ${reason}`);
  assert.equal(reason.includes("\n"), false);
}

// Asserts the call is allowed.
function assertAllowed(input, env) {
  assert.equal(operatorDecision({ input, env }), null, JSON.stringify(input.tool_input));
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
  const families = { queue: QUEUE_SUBCOMMANDS, decision: DECISION_SUBCOMMANDS, project: PROJECT_SUBCOMMANDS };
  assert.deepEqual(Object.keys(OPERATOR_SUBCOMMANDS).sort(), Object.keys(families).sort());
  for (const [family, names] of Object.entries(families)) {
    assert.ok(OPERATOR_CLI_COMMANDS.allowed.includes(family), family);
    assertClassified(OPERATOR_SUBCOMMANDS[family], names, family);
  }
});

test("the main thread refuses the subcommands and flags that write files, widen its scope or start the runner", (t) => {
  const { env, checkout } = operatorFixture(t);
  const allowed = [
    "nightqueue decision list",
    "nightqueue decision show D-1",
    "nightqueue project list",
    "nightqueue queue add --project alpha fix-it",
    "nightqueue queue run",
    "nightqueue doctor",
  ];
  for (const command of allowed) assertAllowed(main("Bash", { command }), env);
  const refused = [
    "nightqueue decision export --dir /tmp/x --force",
    "nightqueue decision import /tmp/d.json",
    `nightqueue project add ${checkout}`,
    "nightqueue project move alpha --path /tmp/elsewhere",
    "nightqueue queue add --project alpha fix-it --run",
    "nightqueue queue add --run=true x",
    "nightqueue doctor --fix",
    "nightqueue queue",
    "nightqueue decision",
  ];
  for (const command of refused) assertDenied(main("Bash", { command }), env);
});

test("a backslash never smuggles a refused word past the main thread or a read-only subagent", (t) => {
  const { env, checkout } = operatorFixture(t);
  const vectors = [
    `git -C ${checkout} log --out\\put=/tmp/x`,
    `git -C ${checkout} log --ext\\-diff`,
    "nightqueue queue ses\\sion",
    "nightqueue queue status --fol\\low",
    "nq queue status --fore\\ground",
  ];
  for (const command of vectors) {
    assertDenied(main("Bash", { command }), env);
    assertDenied(sub("nightqueue:triage", "Bash", { command }), env);
  }
});

test("the main thread never edits", (t) => {
  const { env, checkout } = operatorFixture(t);
  for (const tool of ["Edit", "Write", "MultiEdit", "NotebookEdit"]) assertDenied(main(tool, { file_path: join(checkout, "x") }), env);
});

test("the main thread runs only the D-58 Bash list", (t) => {
  const { env, checkout } = operatorFixture(t);
  const allowed = [
    "nightqueue queue status",
    "nightqueue doctor --json",
    `git -C ${checkout} log --oneline -5`,
    `git -C ${checkout} --no-optional-locks status`,
    `git -C ${checkout} branch --list`,
    `git -C ${checkout} show HEAD:README.md`,
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

test("the main thread reads the checkouts, qa, runs and the plugin, never the home root", (t) => {
  const { env, checkout, qaWorktree } = operatorFixture(t);
  assertAllowed(main("Read", { file_path: join(checkout, "src", "app.mjs") }), env);
  assertAllowed(main("Read", { file_path: join(qaWorktree, "x") }), env);
  assertAllowed(main("Grep", { pattern: "x", path: join(runsDir(env), "p") }), env);
  assertDenied(main("Read", { file_path: secretsPath(env) }), env);
  assertDenied(main("Glob", { pattern: "*" }, join(env.NIGHTQUEUE_HOME)), env);
});

test("an absolute Glob pattern or Grep glob is judged by its own prefix, whatever path the call names", (t) => {
  const { env, checkout } = operatorFixture(t);
  assertAllowed(main("Glob", { path: checkout, pattern: "src/**/*.mjs" }), env);
  assertAllowed(main("Glob", { path: checkout, pattern: `${checkout}/src/*.mjs` }), env);
  assertDenied(main("Glob", { path: checkout, pattern: `${env.NIGHTQUEUE_HOME}/*` }), env);
  assertDenied(main("Glob", { path: checkout, pattern: "/etc/*" }), env);
  assertDenied(main("Grep", { path: checkout, pattern: "x", glob: `${env.NIGHTQUEUE_HOME}/**` }), env);
  assertDenied(sub("nightqueue:triage", "Glob", { path: checkout, pattern: "/etc/*" }), env);
});

test("the subagents read only where the operator reads, so delegation never widens the read scope", (t) => {
  const { env, checkout, qaWorktree } = operatorFixture(t);
  for (const type of ["nightqueue:triage", "nightqueue:reviewer", "nightqueue:qa"]) {
    assertAllowed(sub(type, "Read", { file_path: join(checkout, "src", "app.mjs") }), env);
    assertAllowed(sub(type, "Grep", { pattern: "x", path: qaWorktree }), env);
    assertDenied(sub(type, "Read", { file_path: secretsPath(env) }), env);
    assertDenied(sub(type, "Read", { file_path: "/etc/hosts" }), env);
    assertDenied(sub(type, "Glob", { pattern: "*" }), env);
  }
});

test("an edit, Bash or Agent call whose tool_input is not an object is refused", (t) => {
  const { env } = operatorFixture(t);
  for (const tool of ["Edit", "Write", "MultiEdit", "NotebookEdit", "Bash", "Agent", "Task"]) {
    for (const toolInput of [null, undefined, "x", 7, []]) {
      assertDenied(main(tool, toolInput), env);
      assertDenied(sub("nightqueue:qa", tool, toolInput), env);
    }
  }
});

test("the main thread launches only the triage, qa and reviewer subagents", (t) => {
  const { env } = operatorFixture(t);
  for (const type of ["nightqueue:triage", "qa", "plugin_nightqueue_reviewer"]) assertAllowed(main("Agent", { prompt: "p", subagent_type: type }), env);
  for (const type of ["general-purpose", "Explore", "nightqueue:triager", undefined]) assertDenied(main("Task", { prompt: "p", subagent_type: type }), env);
});

test("the qa subagent writes and runs only in its qa worktree, under each spelling of its type", (t) => {
  const { env, checkout, qaWorktree } = operatorFixture(t);
  for (const type of ["nightqueue:qa", "qa", "plugin_nightqueue_qa"]) {
    assertAllowed(sub(type, "Write", { file_path: join(qaWorktree, "x") }), env);
    assertDenied(sub(type, "Write", { file_path: join(checkout, "x") }), env);
    assertDenied(sub(type, "Edit", { file_path: join(qaDir(env), "not-an-id", "x") }), env);
  }
  const allowed = [
    `cd ${qaWorktree} && npm test 2>&1 | tail -5`,
    `cd ${qaWorktree} && node --test test/a.test.mjs > /dev/null`,
    `cd ${qaWorktree} && git log HEAD~3..HEAD --oneline`,
    `cd ${qaWorktree}/src && cat ${qaWorktree}/README.md`,
    `cd "${qaWorktree}" && nightqueue sandbox npm test`,
    "nightqueue sandbox worktree alpha",
    `nightqueue sandbox worktree --drop ${qaWorktree}`,
  ];
  for (const command of allowed) assertAllowed(sub("nightqueue:qa", "Bash", { command }), env);
  const refused = [
    "npm test",
    `cd ${qaWorktree} && rm -rf /Users/x`,
    `cd ${qaWorktree} && cd /tmp && ls`,
    `cd ${qaWorktree} && cat ../../x`,
    `cd ${qaWorktree} && cat $HOME/.ssh/id_rsa`,
    `cd ${qaWorktree} && cat $(echo /etc/passwd)`,
    `cd ${qaWorktree} && cat ~/x`,
    `cd ${qaWorktree} && cat '/etc/passwd'`,
    `cd ${qaWorktree} && cat \\/etc/passwd`,
    `cd ${qaWorktree}/.. && ls`,
    "cd /tmp && ls",
    `cd ${checkout} && npm test`,
    "nightqueue sandbox worktree --drop /tmp/x",
    "nightqueue sandbox ls",
  ];
  for (const command of refused) assertDenied(sub("nightqueue:qa", "Bash", { command }), env);
});

test("the qa anchor refuses ANSI-C quoting, backslashes, globs and braces that reach a dot, and an option glued to an absolute path", (t) => {
  const { env, qaWorktree } = operatorFixture(t);
  const refused = [
    "cat $'/etc/passwd'",
    "ls $'..'",
    'cat $"/etc/passwd"',
    "cat \\.\\./x",
    "tar -C/etc -xf a.tar",
    "tar -xC/etc -f a.tar",
    "ls {.,x}./",
    "ls .[.]/",
    "ls .?/",
    "ls .*/",
    "ls src/[.][.]/",
  ];
  for (const tail of refused) assertDenied(sub("nightqueue:qa", "Bash", { command: `cd ${qaWorktree} && ${tail}` }), env);
  assertAllowed(sub("nightqueue:qa", "Bash", { command: `cd ${qaWorktree} && ls test/*.test.mjs -C ${qaWorktree}/src` }), env);
});

test("after the qa anchor, nightqueue runs only through sandbox, gh only reads and git never pushes or reconfigures, in any segment", (t) => {
  const { env, qaWorktree } = operatorFixture(t);
  const allowed = [
    "nightqueue sandbox npm test",
    "nightqueue sandbox nightqueue doctor",
    "gh pr view 3 --json title",
    "git log --oneline -3 && git diff",
    "npm test 2>&1 | tail -5",
  ];
  for (const tail of allowed) assertAllowed(sub("nightqueue:qa", "Bash", { command: `cd ${qaWorktree} && ${tail}` }), env);
  const refused = [
    "nightqueue update",
    "nightqueue setup",
    "nightqueue open",
    "nq queue run",
    "npm test && nightqueue queue add x",
    "env nightqueue update",
    'sh -c "nightqueue update"',
    "node bin/nightqueue.mjs update",
    "gh pr merge 1",
    "npm test | gh issue close 2",
    "git push origin HEAD",
    "git -C . remote add x y",
    "git -c a=b config user.name x",
    "npm test; git push",
  ];
  for (const tail of refused) assertDenied(sub("nightqueue:qa", "Bash", { command: `cd ${qaWorktree} && ${tail}` }), env);
});

test("a read-only subagent never edits and runs only reads, gh reads included", (t) => {
  const { env, checkout } = operatorFixture(t);
  assertDenied(sub("nightqueue:triage", "Write", { file_path: join(checkout, "x") }), env);
  assertDenied(sub("general-purpose", "Edit", { file_path: join(checkout, "x") }), env);
  assertAllowed(sub("nightqueue:reviewer", "Bash", { command: "gh pr diff 12" }), env);
  assertAllowed(sub("nightqueue:triage", "Bash", { command: `git -C ${checkout} blame src/a.mjs` }), env);
  assertDenied(sub("nightqueue:triage", "Bash", { command: "gh pr merge 12" }), env);
  assertDenied(sub("nightqueue:triage", "Bash", { command: "gh constructor x" }), env);
});

test("a read-only subagent runs only the nightqueue reads, never a command the main thread may run to record or remove", (t) => {
  const { env } = operatorFixture(t);
  const allowed = [
    "nightqueue queue status",
    "nightqueue queue log J-1",
    "nightqueue project list",
    "nightqueue decision list",
    "nightqueue decision show D-1",
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
  assert.match(operatorDecision({ input: main("Bash", hostile), env }), /^D-58: .*boom/);
  assert.match(operatorDecision({ input: sub("qa", "Write", hostile), env }), /^D-58: .*boom/);
  assert.equal(operatorDecision({ input: main("Read", hostile), env }), null);
});

test("agentRole names only the three operator subagents", () => {
  assert.equal(agentRole("nightqueue:qa"), "qa");
  assert.equal(agentRole(" triage "), "triage");
  assert.equal(agentRole("plugin_nightqueue_reviewer"), "reviewer");
  for (const type of ["triager", "qa-guardian", "other:qa", "", null, 7]) assert.equal(agentRole(type), null);
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
  assert.equal(desiredHooks(env).find(({ event }) => event === "PreToolUse").matcher, "Agent|Task|Bash|Read|Grep|Glob");
});
