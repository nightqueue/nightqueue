import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { test } from "node:test";
import { binDir } from "../../src/config/paths.mjs";
import {
  PATH_MARK,
  PATH_MARK_END,
  addPathLine,
  binDirInPath,
  pathBlock,
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

test("the block is marked and guarded, and fish gets the only syntax fish understands", (t) => {
  const zsh = makeEnv(t, "shell-line");
  assert.equal(
    pathBlock(zsh),
    [
      PATH_MARK,
      'case ":$PATH:" in',
      `  *":${binDir(zsh)}:"*) ;;`,
      `  *) export PATH="${binDir(zsh)}:$PATH" ;;`,
      "esac",
      PATH_MARK_END,
    ].join("\n"),
  );
  assert.equal(
    pathBlock({ ...zsh, SHELL: "/bin/fish" }),
    [PATH_MARK, `fish_add_path ${binDir(zsh)}`, PATH_MARK_END].join("\n"),
  );
});

test("the PATH check compares resolved directories, not strings", (t) => {
  const env = makeEnv(t, "shell-in-path");
  assert.equal(binDirInPath(env), false);
  assert.equal(binDirInPath({ ...env, PATH: ["/usr/bin", `${binDir(env)}/`].join(delimiter) }), true);
  assert.equal(binDirInPath({ ...env, PATH: `/usr/bin${delimiter}/opt/nightshift/bin` }), false);
  assert.equal(binDirInPath({ ...env, PATH: undefined }), false);
});

test("the block is appended once to a file that has none, and a second call writes nothing", (t) => {
  const env = makeEnv(t, "shell-append");
  writeFileSync(rcFilePath(env), `${THIRD_PARTY}\n`);

  assert.equal(addPathLine(env).status, "created");
  assert.equal(readRc(env), `${THIRD_PARTY}\n${pathBlock(env)}\n`);
  assert.equal(addPathLine(env).status, "already present");
  assert.equal(readRc(env), `${THIRD_PARTY}\n${pathBlock(env)}\n`);
});

test("an rc file that does not exist yet is created with the block alone", (t) => {
  const env = makeEnv(t, "shell-create");
  assert.equal(existsSync(rcFilePath(env)), false);
  assert.equal(addPathLine(env).status, "created");
  assert.equal(readRc(env), `${pathBlock(env)}\n`);
});

test("a file whose last line has no newline still gets the block on its own lines", (t) => {
  const env = makeEnv(t, "shell-no-newline");
  writeFileSync(rcFilePath(env), THIRD_PARTY);
  addPathLine(env);
  assert.equal(readRc(env), `${THIRD_PARTY}\n${pathBlock(env)}\n`);
});

test("stale regions of ours collapse into one current block, and unmarked lines are never touched", (t) => {
  const env = makeEnv(t, "shell-collapse");
  const stale = `export PATH="/old/one/bin:$PATH" ${PATH_MARK}`;
  writeFileSync(rcFilePath(env), [THIRD_PARTY, stale, "alias ll='ls -l'", stale, ""].join("\n"));

  assert.equal(addPathLine(env).status, "updated");
  assert.deepEqual(readRc(env).split("\n"), [THIRD_PARTY, ...pathBlock(env).split("\n"), "alias ll='ls -l'", ""]);
  assert.equal(addPathLine(env).status, "already present");
});

test("a line of the user that merely mentions the mark is neither replaced nor removed", (t) => {
  const env = makeEnv(t, "shell-decoys");
  const decoys = [
    `${PATH_MARK}: review this later`,
    PATH_MARK,
    "alias deploy='make deploy'",
    `echo "installed with ${PATH_MARK}"`,
    `# ${PATH_MARK}`,
    `export PATH="/opt/x:$PATH" # nightshift-old`,
    `alias ns='shift' ${PATH_MARK} helper`,
  ];
  writeFileSync(rcFilePath(env), `${decoys.join("\n")}\n`);

  assert.equal(addPathLine(env).status, "created");
  assert.deepEqual(readRc(env).split("\n"), [...decoys, ...pathBlock(env).split("\n"), ""]);

  assert.equal(removePathLine(env).status, "removed");
  assert.deepEqual(readRc(env).split("\n"), [...decoys, ""]);
  assert.equal(removePathLine(env).status, "not present", "a decoy was taken for our own line");
});

test("a fish region of a previous home is replaced, and only the first survives", (t) => {
  const env = makeEnv(t, "shell-fish-stale", { shell: "/opt/homebrew/bin/fish" });
  const stale = `fish_add_path /old/home/bin ${PATH_MARK}`;
  mkdirSync(dirname(rcFilePath(env)), { recursive: true });
  writeFileSync(rcFilePath(env), [`set -x EDITOR vim`, stale, stale, ""].join("\n"));

  assert.equal(addPathLine(env).status, "updated");
  assert.deepEqual(readRc(env).split("\n"), ["set -x EDITOR vim", ...pathBlock(env).split("\n"), ""]);
  assert.equal(addPathLine(env).status, "already present");
});

test("the removal takes out only the regions of ours, and says nothing to remove when there are none", (t) => {
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
  assert.equal(readFileSync(real, "utf8"), `${THIRD_PARTY}\n${pathBlock(env)}\n`);
  assert.equal(statSync(rcFilePath(env), { throwIfNoEntry: false }).isSymbolicLink?.() ?? false, false);
  assert.equal(statSync(real).mode & 0o777, 0o600);
  assert.equal(existsSync(rcFilePath(env)), true);
});

test("the single line of an older installation becomes the block, without ever leaving both behind", (t) => {
  const env = makeEnv(t, "shell-migrate");
  const legacy = `export PATH="${binDir(env)}:$PATH" ${PATH_MARK}`;
  writeFileSync(rcFilePath(env), [THIRD_PARTY, legacy, ""].join("\n"));

  assert.equal(addPathLine(env).status, "updated");
  assert.deepEqual(readRc(env).split("\n"), [THIRD_PARTY, ...pathBlock(env).split("\n"), ""]);
  assert.equal(readRc(env).includes(legacy), false, "the line of the older installation survived next to the block");
  assert.equal(addPathLine(env).status, "already present");
  assert.equal(removePathLine(env).status, "removed");
  assert.deepEqual(readRc(env).split("\n"), [THIRD_PARTY, ""]);
});

test("the block a fish installation left behind is replaced by the block of this home", (t) => {
  const env = makeEnv(t, "shell-fish-block", { shell: "/opt/homebrew/bin/fish" });
  mkdirSync(dirname(rcFilePath(env)), { recursive: true });
  writeFileSync(rcFilePath(env), [PATH_MARK, "fish_add_path /old/home/bin", PATH_MARK_END, ""].join("\n"));

  assert.equal(addPathLine(env).status, "updated");
  assert.deepEqual(readRc(env).split("\n"), [...pathBlock(env).split("\n"), ""]);
});

test("the block of a previous home is replaced whole, never nested inside the new one", (t) => {
  const env = makeEnv(t, "shell-stale-block");
  const stale = [
    PATH_MARK,
    'case ":$PATH:" in',
    '  *":/old/home/bin:"*) ;;',
    '  *) export PATH="/old/home/bin:$PATH" ;;',
    "esac",
    PATH_MARK_END,
  ];
  writeFileSync(rcFilePath(env), [THIRD_PARTY, ...stale, "alias ll='ls -l'", ""].join("\n"));

  assert.equal(addPathLine(env).status, "updated");
  assert.deepEqual(readRc(env).split("\n"), [THIRD_PARTY, ...pathBlock(env).split("\n"), "alias ll='ls -l'", ""]);
  assert.equal(readRc(env).includes("/old/home/bin"), false);
});

test("the block of an older build, written before the closing marker existed, is migrated instead of left orphaned", (t) => {
  const env = makeEnv(t, "shell-migrate-unterminated");
  const previous = [
    PATH_MARK,
    'case ":$PATH:" in',
    `  *":${binDir(env)}:"*) ;;`,
    `  *) export PATH="${binDir(env)}:$PATH" ;;`,
    "esac",
  ];
  writeFileSync(rcFilePath(env), [THIRD_PARTY, ...previous, "alias ll='ls -l'", ""].join("\n"));

  assert.equal(addPathLine(env).status, "updated");
  assert.deepEqual(readRc(env).split("\n"), [THIRD_PARTY, ...pathBlock(env).split("\n"), "alias ll='ls -l'", ""]);
  assert.equal(addPathLine(env).status, "already present");
  assert.equal(removePathLine(env).status, "removed");
  assert.deepEqual(readRc(env).split("\n"), [THIRD_PARTY, "alias ll='ls -l'", ""]);
});

test("a block of the same shape pointing at another home is left alone without the closing marker, because only its own home can claim it", (t) => {
  const env = makeEnv(t, "shell-unterminated-foreign-home");
  const foreign = [
    PATH_MARK,
    'case ":$PATH:" in',
    '  *":/opt/other-home/bin:"*) ;;',
    '  *) export PATH="/opt/other-home/bin:$PATH" ;;',
    "esac",
  ];
  writeFileSync(rcFilePath(env), [...foreign, ""].join("\n"));

  assert.equal(addPathLine(env).status, "created");
  assert.deepEqual(readRc(env).split("\n"), [...foreign, ...pathBlock(env).split("\n"), ""]);
  assert.equal(removePathLine(env).status, "removed");
  assert.deepEqual(readRc(env).split("\n"), [...foreign, ""]);
});

test("the block is valid syntax for the shells that source it", (t) => {
  const env = makeEnv(t, "shell-syntax");
  const path = join(env.HOME, "block.sh");
  writeFileSync(path, `${pathBlock(env)}\n`);

  for (const shell of ["sh", "bash"]) {
    const result = spawnSync(shell, ["-n", path], { encoding: "utf8" });
    if (result.error) continue;
    assert.equal(result.status, 0, `${shell} refused the block: ${result.stderr}`);
  }
});
