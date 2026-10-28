import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { packageRoot } from "../../src/host/paths.mjs";
import { JOB_HOME_ENV } from "../../src/queue/home-guard.mjs";
import {
  ORCHESTRATOR_BASH_RULES,
  PLUGIN_DIR_ENV,
  describeOrchestratorBashRules,
  hasControlChar,
  hasEscapingBackslash,
  hasUnquotedCaret,
  hasUnquotedExpansion,
  hasUnquotedForeignBlank,
  hasUnquotedHash,
  hasUnquotedParen,
  insideRoots,
  isOrchestratorCall,
  maskQuoted,
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
  ["/opt/bin/nightqueue run check 04", false],
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
  ["nightqueue run check 04", true],
  ["nightqueue run log", true],
  ["nightqueue run index-save", true],
  ["nightqueue run commit", true],
  ["nightqueue run pr", true],
  ["nightqueue run start --type bug/error --commit-type fix --expect-slug fix-x", true],
  ["nightqueue run publish --message-file /runs/p/s/commit-message.txt --body-file /runs/p/s/pr-body.md", true],
  ["nightqueue run report", true],
  ["nightqueue run start --routing", true],
  ["nightqueue run start; rm -rf x", false],
  ["nightqueue run start --routing; rm -rf x", false],
  ["nightqueue run publish && git push --force", false],
  ["nightqueue run secrets-sweep", false],
  ["nightqueue queue status", false],
  ["nightqueue", false],
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
  ["git rev-parse =(x)", false],
  ["git rev-parse *(e:'x':)", false],
  ["git status --short =(x)", false],
  ["nightqueue run check =(x)", false],
  ["git push {--receive-pack=x,origin}", false],
  ["git fetch {--upload-pack=x,origin}", false],
  ["git add *", false],
  ["git add src/?.mjs", false],
  ["git rev-parse ^HEAD", false],
  ["git rev-parse '(x)'", true],
  ['git commit -m "fix(scope): x {y}"', true],
  ["git rev-parse HEAD^", false],
  ["git rev-parse 'HEAD^'", true],
];

for (const [command, allowed] of BASH_TABLE) {
  test(`the closed list ${allowed ? "allows" : "refuses"}: ${JSON.stringify(command)}`, () => {
    assert.equal(orchestratorBashAllowed(command), allowed);
  });
}

test("hasUnquotedExpansion sees only what zsh reads unquoted, and hasUnquotedParen only a paren", () => {
  const cases = [
    ["git add *", true, false],
    ["git log ^main", true, false],
    ["git log =(x)", true, true],
    ["git log '(x)' \"{y}\" $'[z]'", false, false],
    ["git log HEAD^ a~1", false, false],
    ["", false, false],
  ];
  for (const [command, expands, paren] of cases) {
    assert.equal(hasUnquotedExpansion(command), expands, command);
    assert.equal(hasUnquotedParen(command), paren, command);
  }
  assert.equal(hasUnquotedExpansion(42), true);
  assert.equal(hasUnquotedParen(42), false);
});

test("hasUnquotedHash sees a `#` zsh reads unquoted, word-initial or mid-word, and never a quoted one", () => {
  for (const command of ["a # b", "a#b", "#x", "''#b"]) assert.equal(hasUnquotedHash(command), true, command);
  for (const command of ["'#'", '"#"', "$'#'", "x'#'", '"fix #12"', "git log"]) assert.equal(hasUnquotedHash(command), false, command);
  assert.equal(hasUnquotedHash(42), false);
});

test("the orchestrator's closed list refuses an unquoted `#` that would drop a required word, and keeps a quoted one", () => {
  const refused = ["git diff # --stat", "git diff # --name-only", "git branch # --show-current", "git status # --short", "git status --short x#y"];
  for (const command of refused) assert.equal(orchestratorBashAllowed(command), false, command);
  for (const command of ["git diff '#' --stat", 'git commit -m "fix: #12"']) assert.equal(orchestratorBashAllowed(command), true, command);
});

test("hasUnquotedCaret sees a `^` zsh reads unquoted anywhere in a word, and never a quoted one", () => {
  for (const command of ["git log ^main", "git fetch origin --^zzz", "git rev-parse HEAD^", "a ''^b"]) assert.equal(hasUnquotedCaret(command), true, command);
  for (const command of ["'^main'", '"--^zzz"', "$'^x'", "x'^'", "git log"]) assert.equal(hasUnquotedCaret(command), false, command);
  assert.equal(hasUnquotedCaret(42), false);
});

test("the orchestrator's closed list refuses an unquoted `^` mid-word, which EXTENDED_GLOB expands to file names, and keeps a quoted one", () => {
  const refused = ["git fetch origin --^zzz", "git push origin HEAD --^zzz", "git commit -m fix --^zzz", "git diff --stat HEAD^"];
  for (const command of refused) assert.equal(orchestratorBashAllowed(command), false, command);
  for (const command of ["git commit -m 'a ^ b'", 'git diff --stat "HEAD^"']) assert.equal(orchestratorBashAllowed(command), true, command);
});

test("hasControlChar sees a C0 control character but a tab or a newline, quoted or not", () => {
  for (const command of ["a\u0000b", "'a\u0000b'", "a\u0001", "a\u001bb", "a\rb", "a\fb", 42]) assert.equal(hasControlChar(command), true, JSON.stringify(command));
  for (const command of ["a b", "a\tb", "a\nb", "a\u007fb", "a b"]) assert.equal(hasControlChar(command), false, JSON.stringify(command));
});

test("the orchestrator's closed list refuses a command carrying a NUL byte, at which zsh cuts the word it passes", () => {
  const refused = ["git push origin main --force\u0000x", "git push origin main '--force\u0000x'", "git status --short\u0000", "git diff --stat\u0001"];
  for (const command of refused) assert.equal(orchestratorBashAllowed(command), false, JSON.stringify(command));
  assert.equal(orchestratorBashAllowed("git push origin main"), true);
});

const FOREIGN_BLANKS = ["\f", "\v", " ", " ", " ", " ", " ", " ", " ", " ", "　", "﻿"];

const BLANK_FUZZ_EXAMPLES = [
  "git rev-parse --show-toplevel",
  "git status --short",
  "git diff --stat",
  "git branch --show-current",
  "git push origin HEAD",
  "git fetch origin main",
  "git commit -m fix",
  "gh pr view 12",
  "nightqueue run check job",
];

const BACKSLASH_VECTORS = [
  "git fetch --up\\load-pack=x origin",
  "git push origin \\+main",
  "git push origin \\:main",
  "git push --for\\ce origin main",
  "git push --dele\\te origin main",
  "git commit -m x --am\\end",
  "git diff --stat -\\p",
  'git commit -m \\"a --amend b\\"',
  'git push origin \\"x --force y\\"',
];

// The command with only the space after word `gap` replaced by `blank`.
function fuseAt(command, blank, gap) {
  const words = command.split(" ");
  return `${words.slice(0, gap + 1).join(" ")}${blank}${words.slice(gap + 1).join(" ")}`;
}

test("hasUnquotedForeignBlank sees an unquoted blank zsh does not split on, and never a quoted one or a plain space, tab or line break", () => {
  for (const blank of FOREIGN_BLANKS) {
    assert.equal(hasUnquotedForeignBlank(`a${blank}b`), true, JSON.stringify(blank));
    assert.equal(hasUnquotedForeignBlank(`'a${blank}b'`), false, JSON.stringify(blank));
    assert.equal(hasUnquotedForeignBlank(`"a${blank}b"`), false, JSON.stringify(blank));
  }
  for (const command of ["a b", "a\tb", "a\nb", "a\rb"]) assert.equal(hasUnquotedForeignBlank(command), false, JSON.stringify(command));
  assert.equal(hasUnquotedForeignBlank(42), false);
});

test("hasEscapingBackslash sees a backslash outside quotes or inside double quotes, and never a single-quoted one", () => {
  for (const command of ["a\\b", '\\"x\\"', '"a\\"b"', '"a\\\\b"', '"a\\b"', "x'y'\\z"]) assert.equal(hasEscapingBackslash(command), true, command);
  for (const command of ["'a\\b'", "'\\'", "plain", '"no escape"']) assert.equal(hasEscapingBackslash(command), false, command);
  assert.equal(hasEscapingBackslash(42), true);
});

test("the orchestrator's closed list refuses a backslash zsh reads as an escape, and keeps a single-quoted one", () => {
  for (const command of BACKSLASH_VECTORS) assert.equal(orchestratorBashAllowed(command), false, command);
  for (const command of ["git commit -m 'a\\b'", "git commit -m 'a b'", "git fetch origin", "git diff --stat"]) assert.equal(orchestratorBashAllowed(command), true, command);
});

test("the orchestrator's closed list refuses every row example with a foreign blank at any gap, and keeps a quoted one", () => {
  for (const command of BLANK_FUZZ_EXAMPLES) {
    assert.equal(orchestratorBashAllowed(command), true, command);
    for (const blank of FOREIGN_BLANKS) {
      for (let gap = 0; gap < command.split(" ").length - 1; gap += 1) {
        const fused = fuseAt(command, blank, gap);
        assert.equal(orchestratorBashAllowed(fused), false, JSON.stringify(fused));
      }
    }
  }
  assert.equal(orchestratorBashAllowed("git commit -m 'a b'"), true);
});

test("a command that is not a string is refused and never throws", () => {
  for (const value of [undefined, null, 42, ["git", "status"], { command: "git status --short" }]) {
    assert.equal(orchestratorBashAllowed(value), false);
  }
});

const MASK_TABLE = [
  ["git log -1 =(nightqueue version)", "git log -1 =(nightqueue version)"],
  ["grep -e a '(' -e b ')'", "grep -e a '_' -e b '_'"],
  ['log --format="%h (x)"', 'log --format="______"'],
  ["a '' \"\" b", "a '' \"\" b"],
  ["'a'\"b\"(x)", "'_'\"_\"(x)"],
  ["\"it's\"(x)", "\"____\"(x)"],
  ['"a\\"" (x)', '"___" (x)'],
  ["$'a\\'(x)' y", "$'______' y"],
  ["$'a\\'' (x)", "$'___' (x)"],
  ['echo "$(id)"', 'echo "$(___"'],
  ["echo \\( x", "echo \\_ x"],
  ["echo 'unterminated (x", "echo '_______________"],
  ['echo "open (x', 'echo "_______'],
];

for (const [command, masked] of MASK_TABLE) {
  test(`maskQuoted hides only what zsh reads as quoted: ${JSON.stringify(command)}`, () => {
    assert.equal(maskQuoted(command), masked);
    assert.equal(maskQuoted(command).length, command.length);
  });
}

test("maskQuoted refuses a value that is not a string with a clear error", () => {
  assert.throws(() => maskQuoted(undefined), /maskQuoted expects a string command, got undefined/);
});

test("maskQuoted scans a large unterminated quote in linear time", () => {
  for (const opening of ["'", '"', "$'"]) {
    const command = `git log ${opening}${"a\\(".repeat(100_000)}`;
    const started = performance.now();
    const masked = maskQuoted(command);
    assert.equal(masked.length, command.length);
    assert.equal(/[()]/.test(masked), false);
    assert.ok(performance.now() - started < 1000, `maskQuoted took too long on an unterminated ${opening} run`);
  }
});

test("the closed list is frozen data, and its rendering names every rule", () => {
  assert.equal(Object.isFrozen(ORCHESTRATOR_BASH_RULES), true);
  assert.equal(ORCHESTRATOR_BASH_RULES.every((rule) => Object.isFrozen(rule) && Object.isFrozen(rule.argv)), true);
  const rendered = describeOrchestratorBashRules();
  for (const { argv } of ORCHESTRATOR_BASH_RULES) assert.ok(rendered.includes(argv.join(" ")), `${argv.join(" ")} missing from ${rendered}`);
});

// The run subcommands the skill names for a lane, never for the orchestrator: a prover appends its own QA round.
const LANE_ONLY_SUBCOMMANDS = new Set(["append"]);

// The text the orchestrator reads: SKILL.md and every top-level reference of the skill.
function skillFlow() {
  const dir = join(packageRoot(), "plugin", "skills", "resolve");
  const references = readdirSync(join(dir, "references")).filter((name) => name.endsWith(".md")).sort();
  return [join(dir, "SKILL.md"), ...references.map((name) => join(dir, "references", name))].map((file) => readFileSync(file, "utf8")).join("\n");
}

test("every `nightqueue run <sub>` the skill names is a real run subcommand, allowed unless only a lane runs it", () => {
  const skill = skillFlow();
  const named = new Set([...skill.matchAll(/nightqueue run ([a-z0-9-]+)/g)].map((match) => match[1]));
  const runSource = readFileSync(join(packageRoot(), "src", "cli", "run.mjs"), "utf8");
  const subcommandsBlock = runSource.match(/const SUBCOMMANDS = new Map\(\[([\s\S]*?)\]\);/);
  assert.ok(subcommandsBlock, "src/cli/run.mjs no longer declares SUBCOMMANDS");
  const real = new Set([...subcommandsBlock[1].matchAll(/\["([a-z0-9-]+)",/g)].map((match) => match[1]));
  assert.ok(named.size > 0, "the skill names no `nightqueue run` subcommand");
  for (const sub of named) {
    assert.ok(real.has(sub), `the skill names \`nightqueue run ${sub}\`, which src/cli/run.mjs does not have`);
    const allowed = !LANE_ONLY_SUBCOMMANDS.has(sub);
    assert.equal(orchestratorBashAllowed(`nightqueue run ${sub}`), allowed, `the closed list ${allowed ? "refuses" : "allows"} \`nightqueue run ${sub}\``);
  }
});

// Each command the skill prescribes to the orchestrator: the text the skill carries, and a concrete call of it.
const SKILL_PRESCRIBED = [
  ["git rev-parse --is-inside-work-tree", "git rev-parse --is-inside-work-tree"],
  ["git branch --show-current", "git branch --show-current"],
  ["git fetch origin", "git fetch origin"],
  ["git worktree add <path> -b worktree-<slug> origin/main", "git worktree add /work/wt -b worktree-slug origin/main"],
  ["git status --short", "git status --short"],
  ["git diff --stat", "git diff --stat"],
  ["gh pr create", "gh pr create --title t --body-file /runs/p/s/pr-body.md"],
  ["nightqueue run check <NN>", "nightqueue run check 07"],
  ["nightqueue run start", "nightqueue run start"],
  [
    "nightqueue run publish --message-file <RUN_DIR>/commit-message.txt --body-file <RUN_DIR>/pr-body.md",
    "nightqueue run publish --message-file /runs/p/s/commit-message.txt --body-file /runs/p/s/pr-body.md --extra test/x.regression.test.mjs",
  ],
  ["nightqueue run report", "nightqueue run report"],
];

test("every command the skill prescribes to the orchestrator passes the closed list", () => {
  const skill = skillFlow();
  for (const [text, concrete] of SKILL_PRESCRIBED) {
    assert.ok(skill.includes(text), `the skill no longer carries ${JSON.stringify(text)} - re-sync this table`);
    assert.equal(orchestratorBashAllowed(concrete), true, `the closed list refuses the prescribed ${JSON.stringify(concrete)}`);
  }
});

test("the deny reason names every rule and every guard of the data, and the skill no longer copies the list", () => {
  const rendered = describeOrchestratorBashRules();
  for (const { argv, noneOf = [], next = [] } of ORCHESTRATOR_BASH_RULES) {
    assert.ok(rendered.includes(argv.join(" ")), `the deny reason misses ${argv.join(" ")}`);
    for (const word of [...noneOf, ...next]) assert.ok(rendered.includes(word), `the deny reason misses ${word} of ${argv.join(" ")}`);
  }
  const skill = readFileSync(join(packageRoot(), "plugin", "skills", "resolve", "SKILL.md"), "utf8");
  assert.equal(skill.includes("the closed Bash list"), false, "the skill still copies the closed list the runtime holds");
  assert.ok(skill.includes("- (e) git/gh/`nightqueue run` in the subcommands the runtime allows; a denial says what to do instead."), "channel (e) no longer defers to the runtime");
});

test("the job home variable is the one the runtime pins on the child", () => {
  assert.equal(JOB_HOME_ENV, "NIGHTQUEUE_JOB_HOME");
  assert.equal(PLUGIN_DIR_ENV, "NIGHTQUEUE_PLUGIN_DIR");
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
    NIGHTQUEUE_HOME: join(base, "other-home"),
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
  assert.equal(roots.some((root) => root.startsWith(join(base, "other-home", "runs"))), false, "the runs of the job home lost to NIGHTQUEUE_HOME");
  assert.equal(new Set(roots).size, roots.length);

  const { [JOB_HOME_ENV]: _pinned, [PLUGIN_DIR_ENV]: _plugin, ...unpinned } = env;
  assert.equal(orchestratorRoots(unpinned)[0], join(base, "other-home", "runs"));
});

test("the skill's references channel is readable by the orchestrator", (t) => {
  const { base } = scopeFixture(t);
  const plugin = join(base, "plugin");
  const cached = join(base, "claude-config", "plugins", "cache", "x", "plugin");
  const env = { NIGHTQUEUE_HOME: join(base, "home"), [JOB_HOME_ENV]: join(base, "home"), [PLUGIN_DIR_ENV]: plugin, HOME: base, CLAUDE_CONFIG_DIR: join(base, "claude-config") };
  const references = [plugin, cached].flatMap((root) => {
    const dir = join(root, "skills", "resolve", "references");
    mkdirSync(join(dir, "prompts"), { recursive: true });
    writeFileSync(join(dir, "phase-9.md"), "# Phase 9\n");
    writeFileSync(join(dir, "prompts", "_handoff.md"), "handoff\n");
    return [join(dir, "phase-9.md"), join(dir, "prompts", "_handoff.md")];
  });
  const roots = orchestratorRoots(env);
  const cwd = join(base, "worktree");
  for (const file_path of references) {
    assert.equal(insideRoots(readTarget("Read", { file_path }, cwd), roots), true, `${file_path} is outside the orchestrator's roots`);
  }
  assert.equal(insideRoots(readTarget("Read", { file_path: join(cwd, "src", "a.mjs") }, cwd), roots), false);
});

test("only the calling session's own spill of a large tool result is readable, nothing else of the configuration directory", (t) => {
  const { base } = scopeFixture(t);
  const config = join(base, "claude-config");
  const project = join(config, "projects", "-Users-me-repo");
  const session = join(project, "0b6f3c1e-session");
  mkdirSync(join(session, "tool-results"), { recursive: true });
  const env = { [JOB_HOME_ENV]: join(base, "home"), NIGHTQUEUE_HOME: join(base, "home"), HOME: base, CLAUDE_CONFIG_DIR: config };
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

test("the job's list is untouched by the operator's guard: the orchestrator still adds any worktree, commits and pushes", () => {
  assert.equal(orchestratorBashAllowed("git worktree add /tmp/x"), true);
  assert.equal(orchestratorBashAllowed("git commit -m x"), true);
  assert.equal(orchestratorBashAllowed("nightqueue run pr"), true);
  assert.equal(orchestratorBashAllowed("gh issue list"), false);
  assert.equal(orchestratorBashAllowed("adb devices"), false);
});
