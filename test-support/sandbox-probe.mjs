#!/usr/bin/env node
import { existsSync } from "node:fs";

const [exitCode] = process.argv.slice(2);
const stderrText = process.env.NIGHTSHIFT_SANDBOX_PROBE_STDERR;

// Reports the environment and cwd a sandboxed command sees, so a test can assert isolation from the outside.
function probe() {
  const home = process.env.NIGHTSHIFT_HOME ?? null;
  const claudeConfigDir = process.env.CLAUDE_CONFIG_DIR ?? null;
  return {
    home,
    claudeConfigDir,
    homeExists: home ? existsSync(home) : false,
    claudeConfigDirExists: claudeConfigDir ? existsSync(claudeConfigDir) : false,
    other: process.env.NIGHTSHIFT_SANDBOX_PROBE_OTHER ?? null,
    cwd: process.cwd(),
  };
}

if (stderrText) process.stderr.write(`${stderrText}\n`);
process.stdout.write(`${JSON.stringify(probe())}\n`);
process.exitCode = Number.parseInt(exitCode ?? "0", 10) || 0;
