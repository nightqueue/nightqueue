## Deliver

`05-qa.md` holds three kinds of `## Round`: a lite or analyst round, written by its lane; a prover round, appended by the runtime through `nightqueue run append 05`; and the consolidated round, written by `nightqueue run check 05` (`source: runtime consolidation`). Never write a consolidated round yourself.

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
First line: `Symptom coverage: <N vectors of the plan's table> · <command/criterion of your re-enumeration> · omitted: <file:line | none>`. N = the total lines of the plan's ## Symptom coverage table (covered + not-covered), NOT the vectors you confirmed in the diff: a not-covered vector counts towards N even without being in the diff, and an omitted vector you discovered does not enter N, only `omitted:`.
{{/IS_BUG}}
{{#HAS_USAGE_COVERAGE}}
Next line (the first, without the line above): `Usage coverage: <N> · <M> · divergences: <file:line, …|none> · unconfirmed decisions: <item, …|none>`. N = the scenario lines (starting with `- `) inside the plan's ## Usage coverage, from the heading to the next `## `, outside a code block — the **Diff axis:**, **Always-gate class:** and **Scenarios consulted:** lines do NOT count. M = the entry-point lines of your ## Access map (QA) — the `partial:` and `unimplemented intent:` lines do NOT count. Both counts are audited with these same definitions.
{{/HAS_USAGE_COVERAGE}}
Then the HELD/BROKE result of each risk of the plan, of the regression in callers and of the Robustness test (an analysis writes "→ hypothesis H<n>" for a runtime one).

## Invalidated assumptions
(the assumption knocked down + the evidence; or `None`)

## Generated PoCs
(the *.poc.test.* / *.fuzz.test.* / *.regression.test.* files created under `{{RUN_DIR}}/poc/`, with the vector each one attacks; or `None — nothing exercisable at runtime`)

## Prevention
(recommendations to prevent recurrence)

## Verdict
APPROVED (it held against every attack) | NEEDS FIX (there are proven breaks) | NEEDS DISCUSSION
{{/GROUP}}
