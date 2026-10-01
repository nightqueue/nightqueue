#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { dbPath, requireExplicitHome } from "../src/config/paths.mjs";
import { openStore } from "../src/store/open.mjs";

const USAGE = "usage: node scripts/issue-backfill.mjs [--dry-run]";

// Reads the command line: `--dry-run` counts what would be written without writing it.
function parseOptions(argv) {
  const { values, positionals } = parseArgs({ args: argv, options: { "dry-run": { type: "boolean", default: false } }, allowPositionals: true });
  if (positionals.length > 0) throw new Error(`unexpected argument \`${positionals[0]}\`. ${USAGE}`);
  return { dryRun: values["dry-run"] };
}

// Synthesizes the comments of the issues linked to a job before comments existed, in the home NIGHTQUEUE_HOME names; answers the exit code.
export async function main(argv = process.argv.slice(2), env = process.env, io = console) {
  const { dryRun } = parseOptions(argv);
  requireExplicitHome(env);
  const store = openStore(env);
  try {
    const tally = await store.issues.backfillIssues({ dryRun });
    io.log(`${dryRun ? "dry run " : ""}${dbPath(env)}: items=${tally.items} written=${tally.written} skipped=${tally.skipped}`);
    return 0;
  } finally {
    await store.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      console.error(`issue-backfill: ${err?.message ?? String(err)}`);
      process.exitCode = 1;
    },
  );
}
