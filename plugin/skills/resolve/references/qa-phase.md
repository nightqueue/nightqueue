# QA phase — the adversarial QA of /resolve

Read via Read by the /resolve orchestrator in Phase 5, before launching any qa-guardian, and by
the operator in its step 6b (a bug hunt). It is the single home of the Stage A gate and the
consolidation. The QA attack brief and the LITE/ANALYST/PROVER prompts live in `prompts/`
(`_qa-attack-brief.md`, `qa-lite.md`, `qa-analyst.md`, `qa-prover.md`): the pipeline gets them
rendered by `phase_prompt` (`qa-lite`, `qa-analyst`, `qa-prover`), never assembled by hand.

**Without a diff (operator hunt):** the hunt's scope replaces the file list of
`04-implementation.md`, and the fronts that depend on a plan — the pre-mortem, the symptom and
usage coverage, every read of `03-plan.md` — are omitted from the prompts. A caller without
`Glob` takes `{{PLUGIN_ROOT}}` from this file's own path, three levels above its directory.
Everything else below is unchanged.

**An operator hunt has no `phase_prompt` run:** it reads those templates via Read and fills
their `{{…}}` values itself — `{{PLUGIN_ROOT}}` is the plugin root, the directory three levels
above the directory of this file (never a Glob of the repository), the one that CONTAINS
`skills/`. If it does not resolve, omit those three lines entirely — the agent keeps its own
`Glob` fallback for that case.

**complex → two stages (analyst → parallel provers):** the analysis stays in a single
head — it groups breaks by root (4 symptoms with the same cause = 1 fix, not 4) and crosses
callers and interactions between files. The proof — the write→run→iterate loop of each PoC,
the serial bottleneck of the phase — is distributed across parallel provers. Stages A and B
below replace the single launch.

**Stage A — Analyst (complex):** launch 1 qa-guardian — `phase_prompt` with
`target: "qa-analyst"`, then `Agent` with the answered `subagent_type`, `model` and `prompt`
verbatim — header `🛡️ QA-GUARDIAN · complex · ANALYST · ...`.

**Stage A gate:** run `nightqueue run check 05a` (the artifact gate, step 5.2) over
`05a-qa-analyst.md`, which must carry `## Break hypotheses` and `## Test recipe` — on
`MISSING`, relaunch the analyst (🔁) once; if it persists, terminate and inform the user. Zero
runtime hypotheses → skip stage B and go straight to the consolidation.

As soon as that gate closes, call `run_set` with `qa_stage_a` = `{ "artifact":
"05a-qa-analyst.md", "verdict": "<the analyst's verdict>" }` — BEFORE launching stage B,
never by writing the file: this is what makes a resume skip the analyst if the provers die
halfway.

**Stage B — Provers (complex):** launch **N qa-guardian in parallel, all in a single message**
(the `subagent_type` and `model` `phase_prompt` answers, `mode: "bypassPermissions"`) — one
per root group of the hypotheses (never one per symptom). The `description` of each prover's Agent call MUST start with
`H<N> (group: <group>): ` — the cockpit identifies each prover lane and its verdict by that
prefix. Single header of the phase: `🛡️ QA-GUARDIAN · complex · PROVERS ×N · ...`. On a resume
whose block says `From stage: qa-stage-b`, `05a-qa-analyst.md` is already on disk: read it and
start from here, without rebuilding stage A. The prompt of each one: `phase_prompt` with
`target: "qa-prover"` and `group` = the IDs/label of its same-root group, passed verbatim.

**Consolidation (inline, by yourself — no subagent):** assemble the single report in the
contract that Phase 6 consumes:
- `## Proven breaks` = the analyst's static ones + the `PROVEN` hypotheses of the provers,
  keeping the analyst's grouping by root (same root = 1 item with its PoCs).
- `## Validated risks` = the analyst's, resolving each "→ hypothesis H<n>" to HELD (REFUTED)
  or BROKE (PROVEN).
- `## Generated PoCs` = the provers' files + a note that the without-fix proof via stash was
  delegated to the verifier.
- `## Invalidated assumptions` = the analyst's.
- `INCONCLUSIVE` **never becomes HELD**: relaunch ONE prover (🔁) for that hypothesis with
  what was missing; if it remains inconclusive, record an ⚠️ open item.
- Aggregate verdict: any proven break → `NEEDS FIX`; nothing proven and no open item →
  `APPROVED`.

Write the consolidated report to `05-qa.md` via Write and run `nightqueue run check 05`
(the artifact gate, step 5.2) — the artifact Phase 6 and Phase 8 re-read via Read.
