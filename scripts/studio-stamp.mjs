#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { checkStudioStamp, writeStudioStamp } from "../src/studio/stamp.mjs";

export { checkStudioStamp, studioSourceHash, writeStudioStamp } from "../src/studio/stamp.mjs";

// Runs `node scripts/studio-stamp.mjs write|check` against the repository root.
function main() {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const command = process.argv[2];
  if (command === "write") {
    process.stdout.write(`studio stamp ${writeStudioStamp(root).slice(0, 12)}\n`);
    return;
  }
  if (command === "check") {
    const result = checkStudioStamp(root);
    process.stdout.write(result.ok ? `studio ok ${result.hash.slice(0, 12)}\n` : `${result.reason}\n`);
    process.exitCode = result.ok ? 0 : 1;
    return;
  }
  process.stderr.write("usage: node scripts/studio-stamp.mjs write|check\n");
  process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
