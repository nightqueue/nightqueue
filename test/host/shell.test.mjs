import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { test } from "node:test";
import { binDir } from "../../src/config/paths.mjs";
import {
  PATH_MARK,
  addPathLine,
  binDirInPath,
  pathLine,
  rcFilePath,
  removePathLine,
} from "../../src/host/shell.mjs";
import { makeDir } from "../../test-support/memory.mjs";

const THIRD_PARTY = 'export PATH="/opt/x:$PATH"';

// Environment of an isolated user home plus an isolated configuration home.
function makeEnv(t, name, { shell = "/bin/zsh", path = "" } = {}) {
  const base = makeDir(t, name);
  return { HOME: base, NIGHTSHIFT_HOME: join(base, "nightshift"), SHELL: shell, PATH: path };
}

// Content of the rc file, or an empty string when the file was never created.
function readRc(env) {
  const path = rcFilePath(env);
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

test("the rc file follows SHELL, and anything unknown lands on zsh", (t) => {
  const zsh = makeEnv(t, "shell-zsh");
  assert.equal(rcFilePath(zsh), join(zsh.HOME, ".zshrc"));
  assert.equal(rcFilePath({ ...zsh, SHELL: "/usr/local/bin/bash" }), join(zsh.HOME, ".bashrc"));
  assert.equal(rcFilePath({ ...zsh, SHELL: "/opt/homebrew/bin/fish" }), join(zsh.HOME, ".config", "fish", "config.fish"));
  assert.equal(rcFilePath({ ...zsh, SHELL: "" }), join(zsh.HOME, ".zshrc"));
});

test("the line is marked, and fish gets the only syntax fish understands", (t) => {
  const zsh = makeEnv(t, "shell-line");
  assert.equal(pathLine(zsh), `export PATH="${binDir(zsh)}:$PATH" ${PATH_MARK}`);
  assert.equal(pathLine({ ...zsh, SHELL: "/bin/fish" }), `fish_add_path ${binDir(zsh)} ${PATH_MARK}`);
});

test("the PATH check compares resolved directories, not strings", (t) => {
  const env = makeEnv(t, "shell-in-path");
  assert.equal(binDirInPath(env), false);
  assert.equal(binDirInPath({ ...env, PATH: ["/usr/bin", `${binDir(env)}/`].join(delimiter) }), true);
  assert.equal(binDirInPath({ ...env, PATH: `/usr/bin${delimiter}/opt/nightshift/bin` }), false);
  assert.equal(binDirInPath({ ...env, PATH: undefined }), false);
});

test("the line is appended once to a file that has none, and a second call writes nothing", (t) => {
  const env = makeEnv(t, "shell-append");
  writeFileSync(rcFilePath(env), `${THIRD_PARTY}\n`);

  assert.equal(addPathLine(env).status, "created");
  assert.equal(readRc(env), `${THIRD_PARTY}\n${pathLine(env)}\n`);
  assert.equal(addPathLine(env).status, "already present");
  assert.equal(readRc(env), `${THIRD_PARTY}\n${pathLine(env)}\n`);
});

test("an rc file that does not exist yet is created with the single line", (t) => {
  const env = makeEnv(t, "shell-create");
  assert.equal(existsSync(rcFilePath(env)), false);
  assert.equal(addPathLine(env).status, "created");
  assert.equal(readRc(env), `${pathLine(env)}\n`);
});

test("a file whose last line has no newline still gets the line on its own line", (t) => {
  const env = makeEnv(t, "shell-no-newline");
  writeFileSync(rcFilePath(env), THIRD_PARTY);
  addPathLine(env);
  assert.equal(readRc(env), `${THIRD_PARTY}\n${pathLine(env)}\n`);
});

test("stale marked lines collapse into one current line, and unmarked lines are never touched", (t) => {
  const env = makeEnv(t, "shell-collapse");
  const stale = `export PATH="/old/one/bin:$PATH" ${PATH_MARK}`;
  writeFileSync(rcFilePath(env), [THIRD_PARTY, stale, "alias ll='ls -l'", stale, ""].join("\n"));

  assert.equal(addPathLine(env).status, "updated");
  assert.deepEqual(readRc(env).split("\n"), [THIRD_PARTY, pathLine(env), "alias ll='ls -l'", ""]);
  assert.equal(addPathLine(env).status, "already present");
});

test("a line of the user that merely mentions the mark is neither replaced nor removed", (t) => {
  const env = makeEnv(t, "shell-decoys");
  const decoys = [
    `${PATH_MARK}: review this later`,
    `echo "installed with ${PATH_MARK}"`,
    `# ${PATH_MARK}`,
    `export PATH="/opt/x:$PATH" # nightshift-old`,
    `alias ns='shift' ${PATH_MARK} helper`,
  ];
  writeFileSync(rcFilePath(env), `${decoys.join("\n")}\n`);

  assert.equal(addPathLine(env).status, "created");
  assert.deepEqual(readRc(env).split("\n"), [...decoys, pathLine(env), ""]);

  assert.equal(removePathLine(env).status, "removed");
  assert.deepEqual(readRc(env).split("\n"), [...decoys, ""]);
  assert.equal(removePathLine(env).status, "not present", "a decoy was taken for our own line");
});

test("a fish line of a previous home is replaced, and only the first survives", (t) => {
  const env = makeEnv(t, "shell-fish-stale", { shell: "/opt/homebrew/bin/fish" });
  const stale = `fish_add_path /old/home/bin ${PATH_MARK}`;
  mkdirSync(dirname(rcFilePath(env)), { recursive: true });
  writeFileSync(rcFilePath(env), [`set -x EDITOR vim`, stale, stale, ""].join("\n"));

  assert.equal(addPathLine(env).status, "updated");
  assert.deepEqual(readRc(env).split("\n"), ["set -x EDITOR vim", pathLine(env), ""]);
  assert.equal(addPathLine(env).status, "already present");
});

test("the removal takes out only the marked lines, and says nothing to remove when there are none", (t) => {
  const env = makeEnv(t, "shell-remove");
  writeFileSync(rcFilePath(env), `${THIRD_PARTY}\n`);
  addPathLine(env);

  assert.equal(removePathLine(env).status, "removed");
  assert.equal(readRc(env), `${THIRD_PARTY}\n`);
  assert.equal(removePathLine(env).status, "not present");
  assert.equal(removePathLine(makeEnv(t, "shell-remove-absent")).status, "not present");
});

test("the write keeps the mode of the rc file and follows it when it is a symlink", (t) => {
  const env = makeEnv(t, "shell-symlink");
  const real = join(env.HOME, "dotfiles-zshrc");
  writeFileSync(real, `${THIRD_PARTY}\n`);
  chmodSync(real, 0o600);
  symlinkSync(real, rcFilePath(env));

  addPathLine(env);
  assert.equal(readFileSync(real, "utf8"), `${THIRD_PARTY}\n${pathLine(env)}\n`);
  assert.equal(statSync(rcFilePath(env), { throwIfNoEntry: false }).isSymbolicLink?.() ?? false, false);
  assert.equal(statSync(real).mode & 0o777, 0o600);
  assert.equal(existsSync(rcFilePath(env)), true);
});
