#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { run } from "../src/cli/index.mjs";

// A session played by the fake `claude`: once per signal dir it writes the triage, runs `run check 01` (which may rename the run), signals `renamed` and waits for the test's `go` file.

const GO_WAIT_MS = 20_000;
const GO_POLL_MS = 20;

// Runs one `nightqueue` command in this process with the session's environment, answering its printed lines.
async function nightqueue(argv) {
  const out = [];
  const err = [];
  const code = await run(argv, { env: process.env, out: (line) => out.push(line), err: (line) => err.push(line), stdout: { write: () => {} } });
  if (code !== 0) throw new Error(`nightqueue ${argv.join(" ")} exited ${code}: ${err.join(" ")}`);
  return out;
}

// Waits until the test drops the `go` file into the signal dir, or the wait runs out.
async function waitForGo(signalDir) {
  const deadline = Date.now() + GO_WAIT_MS;
  while (!existsSync(join(signalDir, "go")) && Date.now() < deadline) await new Promise((done) => setTimeout(done, GO_POLL_MS));
}

const [triagePath, signalDir] = process.argv.slice(2);
if (!existsSync(join(signalDir, "renamed"))) {
  const [before] = await nightqueue(["run", "dir"]);
  writeFileSync(join(before, "01-triage.md"), readFileSync(triagePath, "utf8"));
  await nightqueue(["run", "check", "01"]);
  writeFileSync(join(signalDir, "renamed"), "1");
  await waitForGo(signalDir);
}
