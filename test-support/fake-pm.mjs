#!/usr/bin/env node
import { appendFileSync, mkdirSync } from "node:fs";
import { basename, dirname } from "node:path";

const args = process.argv.slice(2);
const manager = basename(process.argv[1] ?? "pm");

// Records the call, with the environment the caller handed it, in the log the test reads back.
function logCall() {
  const path = process.env.NIGHTSHIFT_FAKE_PM_LOG;
  if (!path) return;
  mkdirSync(dirname(path), { recursive: true });
  const entry = {
    manager,
    args,
    cwd: process.cwd(),
    home: process.env.NIGHTSHIFT_HOME ?? null,
    claudeConfigDir: process.env.CLAUDE_CONFIG_DIR ?? null,
  };
  appendFileSync(path, `${JSON.stringify(entry)}\n`);
}

// Ends the process the way a package manager ends on a call it cannot serve.
function fail(message, code = 1) {
  process.stderr.write(`fake ${manager}: ${message}\n`);
  process.exit(code);
}

// Outcomes the test declared per script name; without them the fake refuses to guess whether a check passes.
function declaredScripts() {
  const raw = process.env.NIGHTSHIFT_FAKE_PM_SCRIPTS;
  if (!raw) return fail("NIGHTSHIFT_FAKE_PM_SCRIPTS is not set; refusing to guess the outcome of a check", 2);
  try {
    return JSON.parse(raw);
  } catch {
    return fail("NIGHTSHIFT_FAKE_PM_SCRIPTS is not valid JSON", 2);
  }
}

// Emulates `<pm> run <script>`, answering with the outcome the test declared for that script.
function runScript(rest) {
  const name = rest[0];
  if (!name) return fail("`run` without a script name");
  const declared = declaredScripts()[name];
  if (!declared) return fail(`no outcome declared for the script \`${name}\``, 2);
  if (declared.stdout) process.stdout.write(`${declared.stdout}\n`);
  if (declared.stderr) process.stderr.write(`${declared.stderr}\n`);
  process.exit(Number.parseInt(declared.exit ?? 0, 10) || 0);
}

// Applies the call, emulating only what a verification run is allowed to ask of a package manager.
function main() {
  logCall();
  const [command, ...rest] = args;
  if (command === "--version" || command === "-v") return process.stdout.write("0.0.0-fake\n");
  if (command === "run") return runScript(rest);
  return fail(`refusing \`${manager} ${args.join(" ")}\`: a verification run never installs anything`, 2);
}

main();
