import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const EXCLUDE_RE = /info\W{0,12}exclude/i;
const WRITE_API_RE =
  /\b(?:(?:write|append)File|mkdir|rm|rmdir|rename|copyFile|cp|symlink|link|truncate)(?:Sync)?\(|\bcreateWriteStream\(|\bwrite[A-Z]\w*\(|\bopen(?:Sync)?\([^)]*["'][wa]|"worktree"\s*,\s*"add"/;
const PROJECT_CLAUDE_RE = /["'`]\.claude["'`/]|\.claude\//;
const LEGACY_WORKTREES_RE = /\.claude\/worktrees|"\.claude",\s*"worktrees"/;
const WORKTREE_ADD_UNDER_CLAUDE_RE = /git worktree add\s+\.claude\//;
const LEGACY_SCAN_FILE = "src/cli/doctor.mjs";

// The source files that both write files and name `.claude`, each with why none of its writes lands under a project's `.claude/`.
const ALLOWED = {
  "src/cli/run.mjs": "names `.claude` only in NEVER_COMMITTED_DIRS, the paths `run commit` refuses to stage; its two writes (the derived file list and the commit message copy) go under the run directory of the nightqueue home",
};

// Every file under a directory of the package whose name ends with the extension, as paths relative to the package root.
function filesUnder(dir, extension) {
  return readdirSync(join(ROOT, dir), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(extension))
    .map((entry) => relative(ROOT, join(entry.parentPath ?? entry.path, entry.name)));
}

// A text with every whitespace run collapsed to one space and every `"a" + "b"` string concatenation joined, so a split line or string hides nothing.
function normalised(text) {
  return String(text)
    .replace(/\s+/g, " ")
    .replace(/"\s*\+\s*"/g, "")
    .replace(/'\s*\+\s*'/g, "");
}

// The normalised content of a file of the package.
function contentOf(file) {
  return normalised(readFileSync(join(ROOT, file), "utf8"));
}

// Tells whether a text both names a project `.claude` and calls a write API, the file-wide shape of a write under a project's `.claude/`.
function writesUnderClaude(text) {
  const flat = normalised(text);
  return PROJECT_CLAUDE_RE.test(flat) && WRITE_API_RE.test(flat);
}

const SOURCES = filesUnder("src", ".mjs");
const PLUGIN_TEXTS = filesUnder("plugin", ".md");

test("the guard reads the whole source and plugin tree", () => {
  assert.ok(SOURCES.includes("src/queue/runner.mjs"), SOURCES.join(", "));
  assert.ok(SOURCES.includes(LEGACY_SCAN_FILE));
  assert.ok(PLUGIN_TEXTS.includes("plugin/skills/resolve/SKILL.md"), PLUGIN_TEXTS.join(", "));
});

test("no source nor plugin text names a local git exclude: nightqueue never writes inside .git/", () => {
  const found = [...SOURCES, ...PLUGIN_TEXTS].filter((file) => EXCLUDE_RE.test(contentOf(file)));
  assert.deepEqual(found, []);
});

test("no source file both names a project's .claude and writes files, unless it is allowed with the reason none of its writes lands there", () => {
  const found = SOURCES.filter((file) => !(file in ALLOWED) && writesUnderClaude(readFileSync(join(ROOT, file), "utf8")));
  assert.deepEqual(found, []);
});

test("every allowed file still names .claude and writes, so the allow list never goes stale", () => {
  for (const [file, reason] of Object.entries(ALLOWED)) {
    assert.ok(reason.length > 20, `${file} is allowed without a reason`);
    assert.ok(SOURCES.includes(file), `${file} is allowed but no longer exists`);
    assert.ok(writesUnderClaude(readFileSync(join(ROOT, file), "utf8")), `${file} is allowed but no longer names .claude and writes`);
  }
});

test("no plugin text tells an agent to add a worktree under .claude/", () => {
  const found = PLUGIN_TEXTS.filter((file) => WORKTREE_ADD_UNDER_CLAUDE_RE.test(contentOf(file)));
  assert.deepEqual(found, []);
});

test("only the read-only legacy scan of doctor names .claude/worktrees in the source", () => {
  const found = SOURCES.filter((file) => file !== LEGACY_SCAN_FILE && LEGACY_WORKTREES_RE.test(contentOf(file)));
  assert.deepEqual(found, []);
});

test("the guard's patterns fire on the shapes they exist for, split across lines and strings included", () => {
  for (const shape of ['join(gitDir, "info", "exclude")', ".git/info/exclude", 'const x = "info/" +\n  "exclude";', 'join(dir, "info",\n  "exclude")']) {
    assert.ok(EXCLUDE_RE.test(normalised(shape)), shape);
  }
  const bypasses = [
    'const dir = join(checkout, ".claude", "x");\nmkdirSync(dir);',
    'const dir = join(checkout, ".claude");\ncpSync(src, dir);',
    'const target = join(checkout, ".claude", "x");\nwriteFileAtomic(target, "{}");',
    'const target = join(checkout, ".claude", "x");\nawait appendFile(target, "x");',
    'const target = join(checkout, ".claude", "x");\nawait rename(from, target);',
    'const target = join(checkout, ".claude", "x");\ncreateWriteStream(target);',
    'const target = join(checkout, ".claude", "worktrees", "x");\nrunGit({ args: [\n  "worktree",\n  "add",\n  target] });',
    'mkdirSync(join(checkout, ".claude", "worktrees"), { recursive: true });',
  ];
  for (const shape of bypasses) assert.ok(writesUnderClaude(shape), shape);
  assert.equal(PROJECT_CLAUDE_RE.test('join(root, ".claude-plugin", "marketplace.json")'), false);
  assert.ok(WORKTREE_ADD_UNDER_CLAUDE_RE.test(normalised("`git worktree add\n.claude/worktrees/operator-qa-<slug> HEAD`")));
  assert.ok(LEGACY_WORKTREES_RE.test(normalised('join(path, ".claude",\n "worktrees")')));
});
