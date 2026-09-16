import { recordPhaseDone, recordRunFields } from "../../../src/queue/run-state.mjs";

// Real writer body of one of the two OS processes the H1 race PoC spawns: the agent's MCP `run_phase_done`
// handler (role "phases") or the queue-runner's fact-capture writer for a tier raise (role "fields").
// Both call the exact same exported functions their real callers call - no hand-interleaving, no mock.
const [, , role, project, slug, countArg] = process.argv;
const count = Number(countArg);

for (let i = 0; i < count; i += 1) {
  if (role === "phases") {
    recordPhaseDone({ project, slug, phase: "triage", artifact: `agent-${i}`, verdict: "ok", env: process.env });
  } else {
    recordRunFields({
      project,
      slug,
      fields: { tier: i % 2 === 0 ? "simple" : "complex", tierRaiseReason: `runner-${i}` },
      env: process.env,
    });
  }
}
