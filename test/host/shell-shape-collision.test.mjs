import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { addPathLine, pathBlock, rcFilePath, removePathLine } from "../../src/host/shell.mjs";
import { makeDir } from "../../test-support/memory.mjs";

// Environment of an isolated user home, mirroring test/host/shell.test.mjs::makeEnv.
function makeEnv(t, name, { shell = "/bin/zsh" } = {}) {
  const base = makeDir(t, name);
  return { HOME: base, NIGHTSHIFT_HOME: join(base, "nightshift"), SHELL: shell, PATH: "" };
}

// Content of the rc file, or an empty string when the file was never created.
function readRc(env) {
  const path = rcFilePath(env);
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

test("vector A: a user comment that merely says the mark, followed by an unrelated fish_add_path line, survives addPathLine and removePathLine intact", (t) => {
  const env = makeEnv(t, "shell-shape-collision-fish", { shell: "/opt/homebrew/bin/fish" });
  const userLines = ["# nightshift", "fish_add_path /usr/local/go/bin", ""];
  mkdirSync(dirname(rcFilePath(env)), { recursive: true });
  writeFileSync(rcFilePath(env), userLines.join("\n"));

  addPathLine(env);
  assert.deepEqual(
    readRc(env).split("\n"),
    [...userLines.slice(0, -1), ...pathBlock(env).split("\n"), ""],
    "the user's fish_add_path line, unrelated to nightshift, must survive addPathLine untouched",
  );

  removePathLine(env);
  assert.deepEqual(
    readRc(env).split("\n"),
    userLines,
    "the user's own comment and fish_add_path line must survive removePathLine untouched",
  );
});

test("vector A: a user comment that merely says the mark, followed by an unrelated POSIX case block, survives addPathLine and removePathLine intact", (t) => {
  const env = makeEnv(t, "shell-shape-collision-case");
  const userLines = [
    "# nightshift",
    'case ":$PATH:" in',
    '  *":/opt/other-tool/bin:"*) ;;',
    '  *) export PATH="/opt/other-tool/bin:$PATH" ;;',
    "esac",
    "",
  ];
  writeFileSync(rcFilePath(env), userLines.join("\n"));

  addPathLine(env);
  assert.deepEqual(
    readRc(env).split("\n"),
    [...userLines.slice(0, -1), ...pathBlock(env).split("\n"), ""],
    "the user's case block, written by another tool, must survive addPathLine untouched",
  );

  removePathLine(env);
  assert.deepEqual(
    readRc(env).split("\n"),
    userLines,
    "the user's own comment and case block must survive removePathLine untouched",
  );
});

test("vector B: a legacy single-line install saved with CRLF line endings is migrated away, not left orphaned next to a new block", (t) => {
  const env = makeEnv(t, "shell-shape-collision-crlf");
  const legacy = `export PATH="/old/home/bin:$PATH" # nightshift\r`;
  writeFileSync(rcFilePath(env), `third-party-line\r\n${legacy}\n`);

  const result = addPathLine(env);
  assert.equal(result.status, "updated", "a recognized legacy region must be migrated (status: updated), not treated as absent (status: created)");
  assert.equal(
    readRc(env).includes(legacy.replace(/\r$/, "")),
    false,
    "the CRLF legacy line of the older installation must not survive next to the new block",
  );

  const second = addPathLine(env);
  assert.equal(second.status, "already present", "once migrated, a second call must be a no-op");
});
