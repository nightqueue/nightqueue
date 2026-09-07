import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { removePathStep, setupPath } from "../../src/cli/install-steps.mjs";
import { makeReport } from "../../src/cli/report.mjs";
import { addPathLine, rcFilePath } from "../../src/host/shell.mjs";
import { makeDir } from "../../test-support/memory.mjs";

// Environment of an isolated user home plus an isolated configuration home, same shape as shell.test.mjs.
function makeEnv(t, name, { shell = "/bin/zsh", path = "" } = {}) {
  const base = makeDir(t, name);
  return { HOME: base, NIGHTSHIFT_HOME: join(base, "nightshift"), SHELL: shell, PATH: path };
}

// Report that captures every step/degrade line instead of printing it.
function makeCapturingReport() {
  const lines = [];
  const ctx = { out: (line) => lines.push(line), err: () => {} };
  return { report: makeReport(ctx), lines };
}

// Minimal ctx setupPath/removePathStep need: env plus a non-TTY stdin so no prompt is ever awaited.
function makeStepCtx(env) {
  return { env, stdin: { isTTY: false }, stdout: { write: () => {} } };
}

test("H1a: rc file is a directory - setupPath must degrade, never throw", async (t) => {
  const env = makeEnv(t, "rc-isdir-add");
  mkdirSync(rcFilePath(env), { recursive: true });
  const { report, lines } = makeCapturingReport();

  await assert.doesNotReject(() => setupPath(makeStepCtx(env), report, { path: true }));

  assert.equal(report.count(), 1, "setupPath must count this as a degraded step");
  assert.ok(
    lines.some((line) => line.startsWith("PATH: failed")),
    `expected a "PATH: failed" line, got: ${JSON.stringify(lines)}`,
  );
});

test("H1a: rc file is a directory - removePathStep must not throw", (t) => {
  const env = makeEnv(t, "rc-isdir-remove");
  mkdirSync(rcFilePath(env), { recursive: true });
  const { report, lines } = makeCapturingReport();

  // readRcFile swallows the EISDIR on read and treats the directory as an empty file, so no
  // marked line is ever found and writeRcFile (the call that would EISDIR) is never reached.
  // Documented here because it is surprising, not because the hypothesis demands "failed".
  assert.doesNotThrow(() => removePathStep(makeStepCtx(env), report));
  assert.ok(
    lines.some((line) => line.startsWith("PATH:")),
    `expected some PATH line, got: ${JSON.stringify(lines)}`,
  );
});

test("H1b: rc file's parent directory has no write permission - setupPath must degrade, never throw", async (t) => {
  const env = makeEnv(t, "rc-eacces-add");
  mkdirSync(env.HOME, { recursive: true });
  assert.equal(existsSync(rcFilePath(env)), false);
  chmodSync(env.HOME, 0o555);
  const { report, lines } = makeCapturingReport();

  try {
    await assert.doesNotReject(() => setupPath(makeStepCtx(env), report, { path: true }));
  } finally {
    chmodSync(env.HOME, 0o755);
  }

  assert.equal(report.count(), 1, "setupPath must count this as a degraded step");
  assert.ok(
    lines.some((line) => line.startsWith("PATH: failed")),
    `expected a "PATH: failed" line, got: ${JSON.stringify(lines)}`,
  );
});

test("H1b: rc file's parent directory has no write permission - removePathStep must degrade, never throw", (t) => {
  const env = makeEnv(t, "rc-eacces-remove");
  // Create the rc file (with content to remove) while the directory is still writable.
  writeFileSync(rcFilePath(env), "");
  addPathLine(env);
  assert.equal(existsSync(rcFilePath(env)), true);
  chmodSync(env.HOME, 0o555);
  const { report, lines } = makeCapturingReport();

  try {
    assert.doesNotThrow(() => removePathStep(makeStepCtx(env), report));
  } finally {
    chmodSync(env.HOME, 0o755);
  }

  assert.ok(
    lines.some((line) => line.startsWith("PATH: failed")),
    `expected a "PATH: failed" line, got: ${JSON.stringify(lines)}`,
  );
});
