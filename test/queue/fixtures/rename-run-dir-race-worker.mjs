import { existsSync } from "node:fs";
import { renameRunDir } from "../../../src/queue/resume.mjs";

// Real writer body of one of the two OS processes the H2 race PoC spawns: a runner process adopting
// the slug its own job's agent declared, exactly as `adoptSlug` (runner.mjs) drives it. No hand-interleaved
// read/write - this calls the real `renameRunDir` export once, after a barrier both workers wait on together.
const [, , project, from, to, barrierPath] = process.argv;

process.stdout.write("ready\n");

while (!existsSync(barrierPath)) {
  // busy-wait for the barrier the parent drops only once BOTH workers signalled ready
}

const result = renameRunDir({ project, from, to, env: process.env });
process.stdout.write(`${JSON.stringify(result)}\n`);
