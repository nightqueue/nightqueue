# QA phase — the adversarial QA of /resolve

Read via Read by the /resolve orchestrator in Phase 5, before launching any qa-guardian. It is
the single home of the Stage A gate and the consolidation. The QA attack brief and the LITE/ANALYST/PROVER prompts live in `prompts/`
(`_qa-attack-brief.md`, `qa-lite.md`, `qa-analyst.md`, `qa-prover.md`): the pipeline gets them
rendered by `phase_prompt` (`qa-lite`, `qa-analyst`, `qa-prover`), never assembled by hand. The
shared report format they all deliver is `deliverables/qa-report.md`. Every lane writes into ONE
artifact, `05-qa.md`, one `## Round <n>` per launch.

**Mode — read from `run check 03`:** the `QA: lite|full` line of the last
`nightqueue run check 03` answer decides, and nothing else (on a resume, run the check again:
it is a pure read of the plan). The check answers `full` when the plan declares
`**Always-gate class:** yes` or lists two or more 🔴 risks under `## Identified risks`, and
`lite` otherwise.

**lite → one lane:** launch 1 qa-guardian — `phase_prompt` with `target: "qa-lite"`, then
`Agent` with the answered `subagent_type`, `model` and `prompt` verbatim — header
`🛡️ QA-GUARDIAN · LITE · ...`. It writes its own `## Round <n>` of `05-qa.md`; then run
`nightqueue run check 05`. Stages A and B and the consolidation below do not apply.

**full → two stages (analyst → parallel provers):** the analysis stays in a single
head — it groups breaks by root (4 symptoms with the same cause = 1 fix, not 4) and crosses
callers and interactions between files. The proof — the write→run→iterate loop of each PoC,
the serial bottleneck of the phase — is distributed across parallel provers. Stages A and B
below replace the single launch.

**Stage A — Analyst (full):** launch 1 qa-guardian — `phase_prompt` with
`target: "qa-analyst"`, then `Agent` with the answered `subagent_type`, `model` and `prompt`
verbatim — header `🛡️ QA-GUARDIAN · ANALYST · ...`. It writes its round into `05-qa.md`.

**Stage A gate:** run `nightqueue run check 05 --stage analyst` (the Phase 0 artifact gate),
which reads the analyst's round for the sections of the analyst request's `## Deliver` — on
`MISSING`, relaunch the analyst (🔁) once with the check's lines as `note`; if it persists, terminate and inform the user. It
answers `QA-STAGE: provers|skip` and records the marker itself (`recorded: qa_stage_a <verdict>`)
BEFORE stage B — never by writing a file: this is what makes a resume skip the analyst if the
provers die halfway. On `QA-STAGE: skip` (zero runtime hypotheses), go straight to
`nightqueue run check 05`.

**Stage B — Provers (full):** launch **N qa-guardian in parallel**
(the `subagent_type` and `model` `phase_prompt` answers) — one
per root group of the hypotheses (never one per symptom). The `description` of each prover's launch MUST start with
`H<N> (group: <group>): ` — the cockpit identifies each prover lane and its verdict by that
prefix. The prompt of each
one: `phase_prompt` with `target: "qa-prover"` and `group` = the IDs/label of its same-root
group, passed verbatim. Each prover appends its own round through `nightqueue run append 05`.
A return without an `APPENDED:` line, or with an `INCONCLUSIVE` hypothesis, relaunches that
prover once (🔁) with what was missing; its new round supersedes the old one of its group. An
`INCONCLUSIVE` **never becomes HELD**: if it remains, it is an ⚠️ open item. The runtime checks
that every `H<n>` of the analyst has a prover `H<n>:` line: a missing id or an `INCONCLUSIVE`
gives `NEEDS DISCUSSION` (the note names the ids), a `BROKE` gives `NEEDS FIX`. A prover still
without `APPENDED:` after its relaunch is an ⚠️ open item.

On a resume whose block says `From stage: qa-stage-b`, the analyst's round is already in
`05-qa.md`: read it (its last `## Round` carrying `## Break hypotheses`) and start Stage B,
without rebuilding stage A.

**Consolidation — by the runtime:** `nightqueue run check 05` merges every round since the
analyst's (the later round of a prover group wins), writes `## Round <n+1>` marked
`source: runtime consolidation` and answers over it. Never write or edit `05-qa.md` yourself.
The aggregate verdict counts proof: any merged round with a non-`None` `## Proven breaks` →
`NEEDS FIX`; else the provers' verdicts plus the coverage of the analyst's `H<n>` ids (any
`NEEDS FIX` or `BROKE` line → `NEEDS FIX`, else any `NEEDS DISCUSSION`, unreadable verdict,
`INCONCLUSIVE` line or id with no prover line → `NEEDS DISCUSSION`, else `APPROVED`); with no prover
round, open hypotheses → `NEEDS DISCUSSION`, and no hypothesis → the analyst's verdict. A `GATE:` line relaunches the QA once,
from the analyst. The check (the Phase 0 artifact gate) reads the last round — the artifact
Phase 6 and Phase 9 re-read via Read, its last `## Round`.
