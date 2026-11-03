#!/usr/bin/env node

// Imports the CLI behind the one refusal a broken install can raise while loading, so a missing pipeline manifest is one line naming its path.
async function loadCli() {
  try {
    return await import("../src/cli/index.mjs");
  } catch (error) {
    if (error?.name !== "UserError") throw error;
    process.stderr.write(`nightqueue: ${error.message}\n`);
    process.exit(1);
  }
}

const { run } = await loadCli();
process.exitCode = await run(process.argv.slice(2));
