## Deliver

`05-qa.md` holds four kinds of `## Round`: a triage round (`source: qa-triage`) and a lite or analyst round, each written by its lane; a prover round, appended by the runtime through `nightqueue run append 05`; and the consolidated round, written by `nightqueue run check 05` (`source: runtime consolidation`). Never write a consolidated round yourself.

{{#GROUP}}
Write the PoC files assigned to your group, with their assigned names, under `{{RUN_DIR}}/poc/` — never in the repo. Your round draft carries, in this order and with these headings (the runtime stamps its `source: prover · group:` line, never write one):

## Proven breaks
(the PROVEN hypotheses: the PoC + the output of its real failure; for type=regression, of its pass; or `None`)

## Validated risks
One line per hypothesis: `H<n>: BROKE (PROVEN) | HELD (REFUTED) | INCONCLUSIVE — <what was missing>`

## Generated PoCs
(the PoC files written under `{{RUN_DIR}}/poc/`, with the vector each one attacks; or `None`)

## Verdict
NEEDS FIX (any PROVEN) | NEEDS DISCUSSION (any INCONCLUSIVE) | APPROVED
{{/GROUP}}
{{^GROUP}}
Write the report to ARTIFACT_PATH, in this order and with these headings. `## Proven breaks`, `## Validated risks`, `## Invalidated assumptions`, `## Generated PoCs` and `## Verdict` are mandatory on every report (the artifact gate fails without any of them, in the last `## Round`); an empty one says `None`. The report is what the fixes are made from and what the PoC run re-checks.

## Mapped rules
(project conventions relevant to the attack)

## Proven breaks
(every 🔴/🟡 with proof; each one points to its PoC or quotes its excerpt)
| # | File | Line | Break | Front | Severity | Proof |
|---|------|------|-------|-------|----------|-------|
| 1 | <file> | <line> | <how it breaks> | Security | 🔴 | reading: quoted excerpt |
| 2 | <file> | <line> | <how it breaks> | Correctness | 🔴 | PoC: payment.poc.test.ts |

## Suggestions (non-blocking)
| # | File | Line | Suggestion | Front |
|---|------|------|------------|-------|
| 1 | <file> | <line> | <description> | Maintainability |
A security finding outside the ticket scope enters here, with `· dedicated ticket: yes · origin: outside the ticket scope` inside the Suggestion cell — never as a loose sentence in ## Validated risks.

{{#HAS_USAGE_COVERAGE}}
## Access map (QA)
Your independent enumeration of the entry points of the target code, written BEFORE reading the plan, one line each:
- <consumer> · <file:line> · <hop1 → hop2 → hop3> · terminal: <click: | route: | job/cron/webhook: | command: | external consumer: not verifiable>

{{/HAS_USAGE_COVERAGE}}
## Validated risks
{{#IS_BUG}}
`omitted: <file:line, …|none>` — the vectors you found outside the plan's ## Symptom coverage table.
{{/IS_BUG}}
{{#HAS_USAGE_COVERAGE}}
`divergences: <file:line, …|none>` — where your ## Access map (QA) and the plan differ.
`unconfirmed decisions: <item, …|none>` — the plan's decisions no named consumer proves or breaks.
{{/HAS_USAGE_COVERAGE}}
Each of these lines, when filled, is an open item of the delivery and never stops the run.
Then the HELD/BROKE result of each risk of the plan, of the regression in callers and of the Robustness test (an analysis writes "→ hypothesis H<n>" for a runtime one).

## Invalidated assumptions
(the assumption knocked down + the evidence; or `None`)
List only assumptions proven false; one that held is not an item here.

## Generated PoCs
(the *.poc.test.* / *.fuzz.test.* / *.regression.test.* files created under `{{RUN_DIR}}/poc/`, with the vector each one attacks; or `None — nothing exercisable at runtime`)

## Prevention
(recommendations to prevent recurrence)

## Verdict
APPROVED (it held against every attack) | NEEDS FIX (there are proven breaks) | NEEDS DISCUSSION
{{/GROUP}}
