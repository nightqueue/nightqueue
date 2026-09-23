import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { packageRoot } from "../../src/host/paths.mjs";
import { JOB_HOME_ENV } from "../../src/queue/home-guard.mjs";
import {
  OPERATOR_BASH_RULES,
  ORCHESTRATOR_BASH_RULES,
  PLUGIN_DIR_ENV,
  describeOperatorBashRules,
  describeOrchestratorBashRules,
  insideRoots,
  isOrchestratorCall,
  operatorBashAllowed,
  orchestratorBashAllowed,
  orchestratorRoots,
  readTarget,
  sessionSpillRoot,
  sessionTranscriptPath,
} from "../../src/queue/orchestrator-scope.mjs";

const BASH_TABLE = [
  ["git rev-parse --show-toplevel", true],
  ["git worktree list", true],
  ["git status --short", true],
  ["git status -s", true],
  ["git status --porcelain", true],
  ["git status", false],
  ["git add -A", true],
  ['git commit -m "feat: scope the orchestrator"', true],
  ['git commit --amend -m "x"', false],
  ["git commit --amend=x", false],
  ["git commit --am", false],
  ["git push -u origin feat/x", true],
  ["git push -u origin HEAD", true],
  ["git push origin HEAD:refs/heads/feat/x", true],
  ["git push --force origin main", false],
  ["git push -f origin main", false],
  ["git push -uf origin main", false],
  ["git push --force-with-lease origin main", false],
  ["git push --force-with-lease=main origin main", false],
  ["git push --force-if-includes origin main", false],
  ["git push --delete origin feat/x", false],
  ["git push -d origin feat/x", false],
  ["git push --mirror origin", false],
  ["git push --mir origin", false],
  ["git push --all origin", false],
  ["git push --prune origin", false],
  ['git push --receive-pack="touch /tmp/x" /other/repo', false],
  ["git push --exec=x origin", false],
  ["git push origin +main", false],
  ["git push origin :feat/x", false],
  ["git fetch origin", true],
  ["git fetch --upload-pack=x /other/repo", false],
  ["/usr/bin/git fetch origin", false],
  ["./git fetch origin", false],
  ["/opt/bin/nightshift run check 04", false],
  ["git -C /p status --short", false],
  ["git -C /other/repo push --force", false],
  ["git -C /p log", false],
  ["git --git-dir=/other/.git status --short", false],
  ["git --work-tree=/other status --short", false],
  ["git -c core.sshCommand=x push origin feat/x", false],
  ["git branch --show-current", true],
  ["git branch -m x", false],
  ["git diff --stat", true],
  ["git diff --stat=200 origin/main", true],
  ["git diff --shortstat", true],
  ["git diff --name-only HEAD~1", true],
  ["git diff --name-status", true],
  ["git diff", false],
  ["git diff HEAD -- x", false],
  ["git diff --stat -p", false],
  ["git diff --stat --patch", false],
  ["git log --oneline", false],
  ["git show HEAD", false],
  ["gh pr view 3", true],
  ["gh pr list --head feat/x", true],
  ["gh pr status", true],
  ["gh pr checks 3", true],
  ["gh pr create --title t --body-file b.md", true],
  ["gh pr diff 3", false],
  ["gh pr merge 3 --admin", false],
  ["gh pr close 3", false],
  ["gh pr edit 3 --body x", false],
  ["gh pr comment 3 --body x", false],
  ["gh pr checkout 3", false],
  ["gh pr", false],
  ["gh api repos/x", false],
  ["nightshift run check 04", true],
  ["nightshift run log", true],
  ["nightshift run index-save", true],
  ["nightshift run commit", true],
  ["nightshift run pr", true],
  ["nightshift run secrets-sweep", false],
  ["nightshift queue status", false],
  ["nightshift", false],
  ["cat x", false],
  ["grep -rn foo src", false],
  ["ls", false],
  ["", false],
  ["   ", false],
  ["git status --short && rm -rf x", false],
  ["git status --short; ls", false],
  ["git status --short | head", false],
  ["echo $(ls)", false],
  ["git diff --stat `ls`", false],
  ["git diff --stat > out.txt", false],
  ["git status --short\nls", false],
];

for (const [command, allowed] of BASH_TABLE) {
  test(`the closed list ${allowed ? "allows" : "refuses"}: ${JSON.stringify(command)}`, () => {
    assert.equal(orchestratorBashAllowed(command), allowed);
  });
}

test("a command that is not a string is refused and never throws", () => {
  for (const value of [undefined, null, 42, ["git", "status"], { command: "git status --short" }]) {
    assert.equal(orchestratorBashAllowed(value), false);
  }
});

test("the closed list is frozen data, and its rendering names every rule", () => {
  assert.equal(Object.isFrozen(ORCHESTRATOR_BASH_RULES), true);
  assert.equal(ORCHESTRATOR_BASH_RULES.every((rule) => Object.isFrozen(rule) && Object.isFrozen(rule.argv)), true);
  const rendered = describeOrchestratorBashRules();
  for (const { argv } of ORCHESTRATOR_BASH_RULES) assert.ok(rendered.includes(argv.join(" ")), `${argv.join(" ")} missing from ${rendered}`);
});

test("every `nightshift run <sub>` the skill names is allowed and is a real run subcommand", () => {
  const skill = readFileSync(join(packageRoot(), "plugin", "skills", "resolve", "SKILL.md"), "utf8");
  const named = new Set([...skill.matchAll(/nightshift run ([a-z0-9-]+)/g)].map((match) => match[1]));
  const runSource = readFileSync(join(packageRoot(), "src", "cli", "run.mjs"), "utf8");
  const subcommandsBlock = runSource.match(/const SUBCOMMANDS = new Map\(\[([\s\S]*?)\]\);/);
  assert.ok(subcommandsBlock, "src/cli/run.mjs no longer declares SUBCOMMANDS");
  const real = new Set([...subcommandsBlock[1].matchAll(/\["([a-z0-9-]+)",/g)].map((match) => match[1]));
  assert.ok(named.size > 0, "the skill names no `nightshift run` subcommand");
  for (const sub of named) {
    assert.ok(real.has(sub), `the skill names \`nightshift run ${sub}\`, which src/cli/run.mjs does not have`);
    assert.equal(orchestratorBashAllowed(`nightshift run ${sub}`), true, `the closed list refuses \`nightshift run ${sub}\``);
  }
});

// Each command the skill prescribes to the orchestrator: the text the skill carries, and a concrete call of it.
const SKILL_PRESCRIBED = [
  ["git rev-parse --is-inside-work-tree", "git rev-parse --is-inside-work-tree"],
  ["git branch --show-current", "git branch --show-current"],
  ["git fetch\n     origin", "git fetch origin"],
  ["git worktree add <path> -b <type>/<slug> origin/main", "git worktree add /work/wt -b feat/slug origin/main"],
  ["git status --short", "git status --short"],
  ["git diff --stat", "git diff --stat"],
  ["git diff --stat|--shortstat|--name-only|--name-status", "git diff --name-only"],
  ["gh pr list\n   --head <branch>", "gh pr list --head feat/slug"],
  ["gh pr view|list|status|checks|create", "gh pr view 3"],
  ["gh pr create", "gh pr create --title t --body-file /runs/p/s/pr-body.md"],
  ["nightshift run check <NN>", "nightshift run check 06.5"],
  ["nightshift run log --json", "nightshift run log --json"],
  ["nightshift run index-save <RUN_DIR>/02-explore.md --project <PROJECT> --repo-root <CWD>", "nightshift run index-save /runs/p/s/02-explore.md --project p --repo-root /work/wt"],
  ["nightshift run commit --message-file <RUN_DIR>/commit-message.txt", "nightshift run commit --message-file /runs/p/s/commit-message.txt"],
  ["nightshift run pr --template", "nightshift run pr --template"],
  ["nightshift run pr --body-file <RUN_DIR>/pr-body.md", "nightshift run pr --body-file /runs/p/s/pr-body.md"],
];

test("every command the skill prescribes to the orchestrator passes the closed list", () => {
  const skill = readFileSync(join(packageRoot(), "plugin", "skills", "resolve", "SKILL.md"), "utf8");
  for (const [text, concrete] of SKILL_PRESCRIBED) {
    assert.ok(skill.includes(text), `the skill no longer carries ${JSON.stringify(text)} - re-sync this table`);
    assert.equal(orchestratorBashAllowed(concrete), true, `the closed list refuses the prescribed ${JSON.stringify(concrete)}`);
  }
});

test("the skill's closed list names every rule and every guard of the data", () => {
  const skill = readFileSync(join(packageRoot(), "plugin", "skills", "resolve", "SKILL.md"), "utf8");
  const list = skill.slice(skill.indexOf("- (e) the closed Bash list"), skill.indexOf("Nothing else."));
  for (const { argv, noneOf = [], next = [] } of ORCHESTRATOR_BASH_RULES) {
    assert.ok(list.includes(argv.join(" ")), `the skill's closed list misses ${argv.join(" ")}`);
    for (const word of [...noneOf, ...next]) assert.ok(list.includes(word), `the skill's closed list misses ${word} of ${argv.join(" ")}`);
  }
  for (const flag of ["-C", "--git-dir", "--work-tree", "-c"]) assert.ok(list.includes(`\`${flag}\``), `the skill's closed list misses the global ${flag}`);
});

test("the job home variable is the one the runtime pins on the child", () => {
  assert.equal(JOB_HOME_ENV, "NIGHTSHIFT_JOB_HOME");
  assert.equal(PLUGIN_DIR_ENV, "NIGHTSHIFT_PLUGIN_DIR");
});

test("the read target of each tool, relative paths resolved against the cwd", () => {
  const cwd = "/work/tree";
  assert.equal(readTarget("Read", { file_path: "/runs/p/s/01.md" }, cwd), "/runs/p/s/01.md");
  assert.equal(readTarget("Read", { file_path: "src/a.mjs" }, cwd), "/work/tree/src/a.mjs");
  assert.equal(readTarget("Read", {}, cwd), null);
  assert.equal(readTarget("Read", { file_path: "a.mjs" }, undefined), null);
  assert.equal(readTarget("Grep", { pattern: "x", path: "/runs/p" }, cwd), "/runs/p");
  assert.equal(readTarget("Grep", { pattern: "x" }, cwd), cwd);
  assert.equal(readTarget("Glob", { pattern: "*.md", path: "/runs/p" }, cwd), "/runs/p");
  assert.equal(readTarget("Glob", { pattern: "**/*.mjs" }, cwd), cwd);
  assert.equal(readTarget("Glob", { pattern: "/runs/p/s/*.md" }, cwd), "/runs/p/s");
  assert.equal(readTarget("Glob", { pattern: "/runs/p/**/0?-*.md" }, cwd), "/runs/p");
  assert.equal(readTarget("Glob", { pattern: "../src/*.mjs", path: "/runs/p" }, cwd), null);
  assert.equal(readTarget("Glob", { pattern: "/runs/p/../../etc/*" }, cwd), null);
  assert.equal(readTarget("Edit", { file_path: "/x" }, cwd), null);
});

// Temp tree with a runs root, a worktree, a symlink to the runs root and a symlink inside it escaping to the worktree.
function scopeFixture(t) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "ns-scope-")));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const runs = join(base, "home", "runs");
  const worktree = join(base, "worktree");
  mkdirSync(join(runs, "p", "s"), { recursive: true });
  mkdirSync(worktree, { recursive: true });
  symlinkSync(runs, join(base, "runs-link"));
  symlinkSync(worktree, join(runs, "p", "s", "escape"));
  return { base, runs, worktree };
}

test("a path is inside the roots only once both sides are canonical", (t) => {
  const { base, runs, worktree } = scopeFixture(t);
  const roots = [runs];
  assert.equal(insideRoots(join(runs, "p", "s", "01-triage.md"), roots), true);
  assert.equal(insideRoots(runs, roots), true);
  assert.equal(insideRoots(join(base, "runs-link", "p", "s", "not-yet-written.md"), roots), true);
  assert.equal(insideRoots(join(runs, "p", "s", "escape", "src", "a.mjs"), roots), false);
  assert.equal(insideRoots(join(runs, "..", "..", "worktree"), roots), false);
  assert.equal(insideRoots(join(base, "home", "runs-other"), roots), false);
  assert.equal(insideRoots(worktree, roots), false);
  assert.equal(insideRoots(null, roots), false);
  assert.equal(insideRoots(join(runs, "x"), null), false);
});

test("the roots are the job's runs and every copy of the plugin, canonical and without duplicates", (t) => {
  const { base } = scopeFixture(t);
  const plugin = join(base, "plugin");
  mkdirSync(plugin);
  const env = {
    NIGHTSHIFT_HOME: join(base, "other-home"),
    [JOB_HOME_ENV]: join(base, "home"),
    [PLUGIN_DIR_ENV]: plugin,
    HOME: base,
    CLAUDE_CONFIG_DIR: join(base, "claude-config"),
  };
  const roots = orchestratorRoots(env);
  assert.equal(roots[0], join(base, "home", "runs"));
  assert.ok(roots.includes(plugin), roots.join("\n"));
  assert.ok(roots.includes(join(realpathSync(packageRoot()), "plugin")), roots.join("\n"));
  assert.ok(roots.includes(join(base, "claude-config", "plugins")), roots.join("\n"));
  assert.equal(roots.some((root) => root.startsWith(join(base, "other-home", "runs"))), false, "the runs of the job home lost to NIGHTSHIFT_HOME");
  assert.equal(new Set(roots).size, roots.length);

  const { [JOB_HOME_ENV]: _pinned, [PLUGIN_DIR_ENV]: _plugin, ...unpinned } = env;
  assert.equal(orchestratorRoots(unpinned)[0], join(base, "other-home", "runs"));
});

test("only the calling session's own spill of a large tool result is readable, nothing else of the configuration directory", (t) => {
  const { base } = scopeFixture(t);
  const config = join(base, "claude-config");
  const project = join(config, "projects", "-Users-me-repo");
  const session = join(project, "0b6f3c1e-session");
  mkdirSync(join(session, "tool-results"), { recursive: true });
  const env = { [JOB_HOME_ENV]: join(base, "home"), HOME: base, CLAUDE_CONFIG_DIR: config };
  const roots = orchestratorRoots(env, [{ transcriptPath: join(project, "0b6f3c1e-session.jsonl"), sessionId: "0b6f3c1e-session" }]);
  assert.equal(insideRoots(join(session, "tool-results", "toolu_01abc.txt"), roots), true);
  assert.equal(insideRoots(join(session, "tool-results"), roots), true);
  assert.equal(insideRoots(join(config, "projects", "other", "s2", "tool-results", "not-yet.txt"), roots), false);
  assert.equal(insideRoots(join(project, "s2", "tool-results", "other-job.txt"), roots), false);
  assert.equal(insideRoots(join(session, "subagents", "agent-1.jsonl"), roots), false);
  assert.equal(insideRoots(join(project, "0b6f3c1e-session.jsonl"), roots), false);
  assert.equal(insideRoots(join(config, "projects", "p", "tool-results", "x.txt"), roots), false);
  assert.equal(insideRoots(join(config, "settings.json"), roots), false);
  assert.equal(insideRoots(join(session, "tool-results", "..", "..", "..", "..", "settings.json"), roots), false);
  assert.equal(insideRoots(join(base, "home", "tool-results", "x.txt"), roots), false);

  const withoutSession = orchestratorRoots(env);
  assert.equal(insideRoots(join(session, "tool-results", "toolu_01abc.txt"), withoutSession), false);
  assert.equal(roots.length, withoutSession.length + 1);
});

test("a spill root needs both an absolute transcript path and a safe session id", () => {
  assert.equal(sessionSpillRoot({ transcriptPath: "/c/projects/p/s1.jsonl", sessionId: "s1" }), join("/c/projects/p", "s1", "tool-results"));
  assert.equal(sessionSpillRoot({ transcriptPath: "/c/projects/p/s1.jsonl" }), null);
  assert.equal(sessionSpillRoot({ sessionId: "s1" }), null);
  assert.equal(sessionSpillRoot({ transcriptPath: "p/s1.jsonl", sessionId: "s1" }), null);
  assert.equal(sessionSpillRoot({ transcriptPath: "/c/projects/p/s1.jsonl", sessionId: ".." }), null);
  assert.equal(sessionSpillRoot({ transcriptPath: "/c/projects/p/s1.jsonl", sessionId: "a/b" }), null);
  assert.equal(sessionSpillRoot(), null);
});

test("the counters find the session's transcript on disk, so their spill root is the hook's", (t) => {
  const { base } = scopeFixture(t);
  const config = join(base, "claude-config");
  const project = join(config, "projects", "-Users-me-repo");
  mkdirSync(join(config, "projects", "-another-repo"), { recursive: true });
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, "sess-1.jsonl"), "{}\n");
  const env = { CLAUDE_CONFIG_DIR: config, HOME: base };
  assert.equal(sessionTranscriptPath(env, "sess-1"), join(project, "sess-1.jsonl"));
  assert.equal(sessionTranscriptPath(env, "sess-2"), null);
  assert.equal(sessionTranscriptPath(env, "../sess-1"), null);
  assert.equal(sessionTranscriptPath({ CLAUDE_CONFIG_DIR: join(base, "missing"), HOME: base }, "sess-1"), null);
});

test("only a payload with a non-empty agent_id is a subagent's", () => {
  assert.equal(isOrchestratorCall({ tool_name: "Read" }), true);
  assert.equal(isOrchestratorCall({ tool_name: "Read", agent_id: "" }), true);
  assert.equal(isOrchestratorCall({ tool_name: "Read", agent_id: 7 }), true);
  assert.equal(isOrchestratorCall({ tool_name: "Read", agent_id: "a83ebd0b428a73e4b", agent_type: "general-purpose" }), false);
  assert.equal(isOrchestratorCall(null), true);
});

const OPERATOR_ALLOWED = [
  "git log --oneline -n 30",
  "git diff --name-only v1.0.0..HEAD",
  "git diff --stat",
  "git worktree add .claude/worktrees/operator-qa-x HEAD",
  "git worktree add --detach .claude/worktrees/operator-qa-chat-photo origin/main",
  "git worktree remove --force .claude/worktrees/operator-qa-x",
  "git worktree remove .claude/worktrees/operator-qa-x",
  "git worktree list",
  "git worktree list --porcelain",
  "git worktree prune",
  "gh issue list",
  "gh issue view 12",
  "gh pr checks 3",
  "gh pr view 3",
  "adb devices",
  "nightshift run check 01 --project p --slug s",
  "nightshift run log --project p --slug s",
  "git status --short",
  "git rev-parse HEAD",
  "git branch --show-current",
];

const OPERATOR_DENIED = [
  "git add .",
  "git commit -m x",
  "git commit --amend",
  "git push",
  "git push -u origin feat/x",
  "git fetch",
  "git fetch origin",
  "gh pr create",
  "gh pr merge 3",
  "gh issue close 12",
  "nightshift run commit",
  "nightshift run pr",
  "git -C /x worktree add .claude/worktrees/operator-qa-x HEAD",
  "git worktree add --force .claude/worktrees/operator-qa-x HEAD",
  "git worktree add -f .claude/worktrees/operator-qa-x HEAD",
  "git worktree add -b y .claude/worktrees/operator-qa-x HEAD",
  "git worktree add -B y .claude/worktrees/operator-qa-x HEAD",
  "git worktree add .claude/worktrees/operator-qa-x",
  "git worktree add ../operator-qa-x HEAD",
  "git worktree add .claude/worktrees/operator-qa-x/../../y HEAD",
  "git worktree add /abs/.claude/worktrees/operator-qa-x HEAD",
  "git worktree add ~/.claude/worktrees/operator-qa-x HEAD",
  "git worktree add .claude/worktrees/operator-qa- HEAD",
  "git worktree add .claude/worktrees/other HEAD",
  "git worktree add .claude/worktrees/operator-qa-x HEAD extra",
  "git worktree add .claude/worktrees/operator-qa-x -- HEAD",
  "git worktree add .claude/worktrees/operator-qa-x --no-checkout HEAD",
  "git worktree remove .claude/worktrees/other",
  "git worktree remove /tmp/x",
  "git worktree remove",
  "git worktree move a b",
  "git worktree lock .claude/worktrees/operator-qa-x",
  "git worktree",
  "git worktree list /tmp",
  "git worktree prune --expire now",
  "git log --oneline -n 5 -p",
  "git log --oneline -n 5 --output=/tmp/x",
  "git log --oneline -n 0",
  "git log --oneline",
  "git log",
  "git show HEAD",
  "git diff --stat --output=x",
  "git diff --stat --output x",
  "git diff --stat --ext-diff",
  "git diff --stat --no-index a b",
  "git diff -p",
  "git diff --stat -p",
  "git diff",
  "adb shell ls",
  "adb devices -l",
  "adb install app.apk",
  "/usr/bin/git status --short",
  "git status --short; rm -rf x",
  "git status --short && git push",
  "git log --oneline -n 5 > /tmp/log",
  "npm test",
  "cat src/app.mjs",
  "",
];

for (const command of OPERATOR_ALLOWED) {
  test(`the operator's closed list allows: ${JSON.stringify(command)}`, () => {
    assert.equal(operatorBashAllowed(command), true);
  });
}

for (const command of OPERATOR_DENIED) {
  test(`the operator's closed list refuses: ${JSON.stringify(command)}`, () => {
    assert.equal(operatorBashAllowed(command), false);
  });
}

test("the operator's list leaves the job's list untouched: the orchestrator still adds any worktree, commits and pushes", () => {
  assert.equal(orchestratorBashAllowed("git worktree add /tmp/x"), true);
  assert.equal(orchestratorBashAllowed("git commit -m x"), true);
  assert.equal(orchestratorBashAllowed("nightshift run pr"), true);
  assert.equal(orchestratorBashAllowed("gh issue list"), false);
  assert.equal(orchestratorBashAllowed("adb devices"), false);
});

test("the operator's list is frozen data, and its rendering names the QA worktree and no write", () => {
  assert.equal(Object.isFrozen(OPERATOR_BASH_RULES), true);
  assert.equal(OPERATOR_BASH_RULES.every((rule) => Object.isFrozen(rule) && Object.isFrozen(rule.argv)), true);
  const rendered = describeOperatorBashRules();
  assert.match(rendered, /git log --oneline -n <N>/);
  assert.match(rendered, /git worktree add \.claude\/worktrees\/operator-qa-<slug> <commit-ish>/);
  assert.match(rendered, /git worktree remove \[--force\] \.claude\/worktrees\/operator-qa-<slug>/);
  assert.match(rendered, /gh issue list\|view/);
  assert.match(rendered, /nightshift run check\|log\|index-save(,|$)/);
  for (const write of ["git add", "git commit", "git push", "git fetch", "create", "commit|", "|pr"]) {
    assert.equal(rendered.includes(write), false, `${write} is in ${rendered}`);
  }
});
