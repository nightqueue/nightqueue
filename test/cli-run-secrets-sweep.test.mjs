import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { makeDir, makeHome } from "../test-support/memory.mjs";

const CLI = fileURLToPath(new URL("../bin/nightshift.mjs", import.meta.url));

// A file whose leak is INDIRECT: the log call names a variable, and only the line that builds it carries the header.
const INDIRECT = `const apiToken = process.env.API_TOKEN;
let requestCurl = \`curl -X POST \${url}\`;
requestCurl += \` -H "Authorization: Bearer \${apiToken}"\`;
console.log(requestCurl);
console.log("request sent");
`;

// A file whose identifiers merely CONTAIN a term as a fragment: `key` inside `keyboard` is not a match.
const BOUNDARY = `const keyboard = detectKeyboard();
const monkey = "donkey";
console.log(keyboard, monkey);
logger.info("secret handshake done");
`;

// Direct leaks through the sinks of four different languages.
const DIRECT = `console.log(apiToken);
logger.warn(password);
fmt.Println(sessionKey)
System.out.println(authHeader);
print(user.credential)
`;

// Creates a directory of fixture files and answers it.
function makeFixtures(t, name, files) {
  const dir = makeDir(t, `secrets-sweep-${name}`);
  for (const [file, content] of Object.entries(files)) writeFileSync(join(dir, file), content);
  return dir;
}

// Runs `nightshift run secrets-sweep` as a real subprocess, the way the QA agent calls it.
function sweep(env, cwd, args) {
  const result = spawnSync(process.execPath, [CLI, "run", "secrets-sweep", ...args], { cwd, env, encoding: "utf8" });
  assert.equal(result.error, undefined, `the CLI failed to spawn: ${result.error}`);
  return { code: result.status, stdout: result.stdout.trim(), stderr: result.stderr, lines: result.stdout.trim().split("\n") };
}

test("a logged variable built from an Authorization header is reported with the line that defines it", (t) => {
  const env = makeHome(t, "sweep-indirect");
  const dir = makeFixtures(t, "indirect", { "client.js": INDIRECT });

  const result = sweep(env, dir, ["--files", "client.js"]);

  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(result.lines, [
    "client.js:4: console.log(requestCurl);",
    '    def client.js:3: requestCurl += ` -H "Authorization: Bearer ${apiToken}"`;',
    "secrets-sweep: 1 candidates in 1 files",
  ]);
});

test("an identifier that merely contains a term as a fragment is not a candidate", (t) => {
  const env = makeHome(t, "sweep-boundary");
  const dir = makeFixtures(t, "boundary", { "ui.js": BOUNDARY });

  const result = sweep(env, dir, ["--files", "ui.js"]);

  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(result.lines, ["secrets-sweep: 0 candidates in 1 files"]);
});

test("a log call is reported through every sink the sweep recognises", (t) => {
  const env = makeHome(t, "sweep-direct");
  const dir = makeFixtures(t, "direct", { "leaks.txt": DIRECT });

  const result = sweep(env, dir, ["--files", "leaks.txt"]);

  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(result.lines.slice(0, 5), [
    "leaks.txt:1: console.log(apiToken);",
    "leaks.txt:2: logger.warn(password);",
    "leaks.txt:3: fmt.Println(sessionKey)",
    "leaks.txt:4: System.out.println(authHeader);",
    "leaks.txt:5: print(user.credential)",
  ]);
  assert.equal(result.lines.at(-1), "secrets-sweep: 5 candidates in 1 files");
});

test("a message that only names a term in its text is not a candidate", (t) => {
  const env = makeHome(t, "sweep-message");
  const dir = makeFixtures(t, "message", {
    "msg.js": 'console.log("token refreshed");\nconsole.log("password updated for", userId);\n',
  });

  const result = sweep(env, dir, ["--files", "msg.js"]);

  assert.deepEqual(result.lines, ["secrets-sweep: 0 candidates in 1 files"]);
});

test("`--files a,b` and `--files a --files b` name the same files", (t) => {
  const env = makeHome(t, "sweep-flag");
  const dir = makeFixtures(t, "flag", { "a.js": INDIRECT, "b.js": BOUNDARY });

  const comma = sweep(env, dir, ["--files", "a.js,b.js"]);
  const repeated = sweep(env, dir, ["--files", "a.js", "--files", "b.js"]);

  assert.equal(comma.stdout, repeated.stdout);
  assert.equal(comma.lines.at(-1), "secrets-sweep: 1 candidates in 2 files");
});

test("a file that cannot be read is named on stderr and never stops the sweep", (t) => {
  const env = makeHome(t, "sweep-unreadable");
  const dir = makeFixtures(t, "unreadable", { "client.js": INDIRECT });

  const result = sweep(env, dir, ["--files", "gone.js,client.js,."]);

  assert.equal(result.code, 0);
  assert.match(result.stderr, /cannot read .*gone\.js/);
  assert.match(result.stderr, /cannot read /);
  assert.equal(result.lines.at(0), "client.js:4: console.log(requestCurl);");
  assert.equal(result.lines.at(-1), "secrets-sweep: 1 candidates in 1 files");
});

test("a binary file is skipped with a note instead of being scanned", (t) => {
  const env = makeHome(t, "sweep-binary");
  const dir = makeFixtures(t, "binary", { "client.js": INDIRECT });
  writeFileSync(join(dir, "blob.bin"), Buffer.from([0x7f, 0x45, 0x00, 0x6b, 0x65, 0x79]));

  const result = sweep(env, dir, ["--files", "blob.bin,client.js"]);

  assert.equal(result.code, 0);
  assert.match(result.stderr, /binary file skipped: .*blob\.bin/);
  assert.equal(result.lines.at(-1), "secrets-sweep: 1 candidates in 1 files");
});

test("an empty --files list sweeps nothing and says so, and a missing --files is a usage error", (t) => {
  const env = makeHome(t, "sweep-empty");
  const dir = makeFixtures(t, "empty", { "client.js": INDIRECT });

  const empty = sweep(env, dir, ["--files", ""]);
  const missing = sweep(env, dir, []);

  assert.equal(empty.code, 0);
  assert.match(empty.stderr, /the `--files` list is empty/);
  assert.deepEqual(empty.lines, ["secrets-sweep: 0 candidates in 0 files"]);
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /missing `--files`; usage: nightshift run secrets-sweep --files <list>/);
});

test("the sweep never writes the files it reads", (t) => {
  const env = makeHome(t, "sweep-readonly");
  const dir = makeFixtures(t, "readonly", { "client.js": INDIRECT, "ui.js": BOUNDARY });

  sweep(env, dir, ["--files", "client.js,ui.js"]);

  assert.equal(readFileSync(join(dir, "client.js"), "utf8"), INDIRECT);
  assert.equal(readFileSync(join(dir, "ui.js"), "utf8"), BOUNDARY);
});

test("a file outside the working directory is refused, whichever way it points there", (t) => {
  const env = makeHome(t, "sweep-outside");
  const outside = makeFixtures(t, "outside", { "client.js": INDIRECT });
  const dir = makeFixtures(t, "inside", { "client.js": INDIRECT });
  symlinkSync(outside, join(dir, "elsewhere"));

  const absolute = sweep(env, dir, ["--files", `client.js,${join(outside, "client.js")}`]);
  const relative = sweep(env, dir, ["--files", "../"]);
  const throughLink = sweep(env, dir, ["--files", "elsewhere/client.js"]);

  for (const result of [absolute, relative, throughLink]) {
    assert.equal(result.code, 1, result.stdout);
    assert.match(result.stderr, /`--files` names .*, which is outside the working directory /);
  }
  assert.equal(throughLink.stdout, "", "a symlinked component must be resolved before the boundary is checked, not after");
});

test("`nightshift run` lists exactly the two steps it dispatches", (t) => {
  const env = makeHome(t, "sweep-help");
  const dir = makeDir(t, "sweep-help-cwd");

  const help = spawnSync(process.execPath, [CLI, "run", "--help"], { cwd: dir, env, encoding: "utf8" });
  const unknown = spawnSync(process.execPath, [CLI, "run", "nope"], { cwd: dir, env, encoding: "utf8" });

  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /nightshift run index-save <artifact>/);
  assert.match(help.stdout, /nightshift run secrets-sweep --files <list>/);
  assert.equal(help.stdout.split("\n").filter((line) => line.startsWith("  nightshift run ")).length, 2);
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /unknown run step `nope`; use: index-save, secrets-sweep/);
});
