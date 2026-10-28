import { terminateRun } from "../src/queue/terminate.mjs";

// Plays the agent's `run_terminate` inside a fake attempt: node run-terminator.mjs <projectId> <slug> <jobId> <reason>; exits 1 when nothing was committed.
function main() {
  const [projectId, slug, jobId, reason] = process.argv.slice(2);
  const ended = terminateRun({ projectId, slug, phase: "qa", reason, jobId: Number(jobId), env: process.env });
  if (ended?.wip?.status === "committed") return;
  process.stderr.write(`run-terminator: the wip was not committed: ${JSON.stringify(ended)}\n`);
  process.exitCode = 1;
}

main();
