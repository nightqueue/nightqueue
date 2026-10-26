import { recordPhaseDone, recordRunFields } from "../../../src/queue/run-state.mjs";

// Real writer body of one of the two OS processes the H1 race PoC spawns: the agent's MCP `run_phase_done`
// handler (role "phases") or the queue-runner's fact-capture writer of the run fields (role "fields").
// Both call the exact same exported functions their real callers call - no hand-interleaving, no mock.
const [, , role, projectId, slug, countArg] = process.argv;
const count = Number(countArg);

for (let i = 0; i < count; i += 1) {
  if (role === "phases") {
    recordPhaseDone({ projectId, slug, phase: "triage", artifact: `agent-${i}`, verdict: "ok", env: process.env });
  } else {
    recordRunFields({
      projectId,
      slug,
      fields: { type: i % 2 === 0 ? "bug/error" : "feature/refactor", branch: `runner-${i}` },
      env: process.env,
    });
  }
}
