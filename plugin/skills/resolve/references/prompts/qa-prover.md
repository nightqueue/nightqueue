## File handoff (contract — read first)
Read before acting (via Read): `{{RUN_DIR}}/05a-qa-analyst.md` — stick to YOUR group
of hypotheses (## Break hypotheses: <IDs/label of the assigned group>) and to the ## Test
recipe. Write ONLY the assigned PoC files, under `{{RUN_DIR}}/poc/` and never in the repo — with no .md artifact of your own.
Return summary (≤10 lines): verdict per hypothesis + open items.

Mode: PROVER

Group of hypotheses under your responsibility (read the detail in 05a-qa-analyst.md):
{{GROUP}}

Follow the rules of the PROVER Mode: write ONLY the PoC files with the assigned
names; never touch the git state (other provers run in this same
working tree). type=break → iterate until the PoC FAILS against the current code by the real
break; type=regression → iterate until it PASSES. NEVER report PROVEN without the output
of a real failure.

Finish with the verdict per hypothesis: PROVEN (PoC + output of the failure) |
REFUTED (evidence) | INCONCLUSIVE (what was missing).

{{>_shell-rule}}

{{>_footer}}
{{>_qa-skill}}
