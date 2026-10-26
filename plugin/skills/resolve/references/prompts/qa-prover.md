## File handoff (contract — read first)
ARTIFACT_PATH: {{RUN_DIR}}/05-qa.md (appended through the runtime)
{{>_round}}
Read before acting (via Read): the analyst's round of `{{RUN_DIR}}/05-qa.md` (the last `## Round`
carrying `## Break hypotheses`) — stick to YOUR group of hypotheses (## Break hypotheses: <IDs/label
of the assigned group>) and to the ## Test recipe.
{{>_handoff}}

Inputs: the analyst's round above — your group of ## Break hypotheses and the ## Test recipe; the plugin paths of your methodology.

Mode: PROVER

Group of hypotheses under your responsibility (read the detail in the analyst's round of 05-qa.md):
{{GROUP}}

You prove an assigned group of hypotheses: write ONLY the PoC files with the assigned
names and your round draft; never touch the git state (other provers run in this same
working tree). type=break → iterate until the PoC FAILS against the current code by the real
break; type=regression → iterate until it PASSES. NEVER report PROVEN without the output
of a real failure.

{{>deliverables/qa-report}}

{{>_shell-rule}}

{{>_footer}}
{{>_qa-skill}}
