#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { run } from "../src/cli/index.mjs";
import { recordOutcome } from "../src/queue/run-state.mjs";

// What a session does around its triage, played by the fake `claude`: writes the triage into its run, runs `run check 01`, then records a gate outcome into the run the check left.

// Runs one `nightqueue` command in this process with the session's environment, answering its printed lines.
async function nightqueue(argv) {
  const out = [];
  const err = [];
  const code = await run(argv, { env: process.env, out: (line) => out.push(line), err: (line) => err.push(line), stdout: { write: () => {} } });
  if (code !== 0) throw new Error(`nightqueue ${argv.join(" ")} exited ${code}: ${err.join(" ")}`);
  return out;
}

const [triagePath, notice] = process.argv.slice(2);
const [before] = await nightqueue(["run", "dir"]);
writeFileSync(join(before, "01-triage.md"), readFileSync(triagePath, "utf8"));
await nightqueue(["run", "check", "01"]);
const [after] = await nightqueue(["run", "dir"]);
const written = recordOutcome({ projectId: basename(dirname(after)), slug: basename(after), status: "gate", notice, env: process.env });
if (written.status !== "written") throw new Error(`the outcome was not recorded: ${written.reason}`);
