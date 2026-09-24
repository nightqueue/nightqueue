#!/usr/bin/env node
import { appendFileSync } from "node:fs";

const args = process.argv.slice(2);

// Answers the `--help` probe, listing `--agent` unless the test asks for a CLI without it.
function printHelp() {
  const agentLine = process.env.NIGHTQUEUE_FAKE_NO_AGENT === "1" ? "" : "  --agent <agent>  Agent for the current session\n";
  process.stdout.write(`Usage: claude [options]\n\nOptions:\n${agentLine}  -r, --resume [value]  Resume a conversation\n`);
}

// Records one interactive launch, with what the operator guard reads from its environment, in the file the test reads back.
function recordLaunch() {
  const path = process.env.NIGHTQUEUE_FAKE_CALLS;
  if (!path) {
    process.stderr.write("fake claude: NIGHTQUEUE_FAKE_CALLS is not set\n");
    process.exit(2);
  }
  const call = {
    argv: args,
    cwd: process.cwd(),
    mode: process.env.NIGHTQUEUE_MODE ?? null,
    pluginDirEnv: process.env.NIGHTQUEUE_PLUGIN_DIR ?? null,
    jobId: process.env.NIGHTQUEUE_JOB_ID ?? null,
  };
  appendFileSync(path, `${JSON.stringify(call)}\n`);
}

if (args[0] === "--help") printHelp();
else recordLaunch();
