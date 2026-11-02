## File handoff (contract — read first)
ARTIFACT_PATH: {{RUN_DIR}}/07-runtime.md (append-only: this launch is ## Round {{ROUND}})
Read before acting (via Read): {{RUN_DIR}}/01-triage.md (## Validated brief, ## Diagnosis on a bug) ·
{{RUN_DIR}}/03-plan.md (## Implementation plan, ## Usage coverage when present) · {{RUN_DIR}}/04-implementation.md ·
{{RUN_DIR}}/06-verification.md (its last `## Round`)
{{>_round}}
{{>_handoff}}

Inputs: the artifacts above; the Type, the bug account and the expected outcome below.

Mode: RUNTIME
Type: {{TYPE}}
Bug account: {{BUG_ACCOUNT}}
Expected outcome: {{EXPECTED_OUTCOME}}

Steps 1–2.7 of your method already ran in the verification before this lane: prove the change by running it (your `## Proving by execution`), cases (a)–(d2) — gate (d) runs when Type = feature/refactor, gate (d2) when Type = bug/error with `## Usage coverage` in `03-plan.md`; every manual CLI/MCP run goes through `nightqueue sandbox <cmd>`.

## Deliver

Write ARTIFACT_PATH as this launch's `## Round`, in this order; `## Runtime verdict` is mandatory (`nightqueue run check 07`).

## Runtime verdict
Its first line is exactly one of:
- `CONFIRMED` — every applicable case proven, every (d)/(d2) line `MET` or `NOT MET / to confirm`;
- `NOT-MET` — a criterion/scenario `NOT MET` without `to confirm`;
- `SYMPTOM-PERSISTS` — on a bug, the execution shows the bug still present;
- `NEEDS-DEVICE` — case (c), or a step gated by live hardware/SMS; the device script (steps + what to observe + criterion) follows the verdict line;
- `UNAVAILABLE` — the path is genuinely inaccessible; what you tried and why each attempt failed follows the verdict line.

Diff applies plan: yes|no (bug only; `n/a` otherwise) — compare `git diff --stat` and the files of `04-implementation.md` with `03-plan.md`; never paste the diff.

Then the commands run, each with its evidence (structure only — never a token/PII), and, when gate (d)/(d2) runs, its table with the verdict column named `Result`:
| # | Scenario (declared entry point) | Result | Evidence |
`Result` is `MET` | `NOT MET` | `NOT MET / to confirm` + its reason; the notice reads `NOT MET` only in that column, so a gate written only in prose is not read.

Evidence files go under `{{RUN_DIR}}/evidence/`, named `api-<name>.log`, `browser-<name>.png|.log` or `emulator-<name>.png|.log`.

{{>_job-limits}}
{{>_demo-repo}}
{{>_shell-rule}}

{{>_footer}}
