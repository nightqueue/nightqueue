## File handoff (contract — read first)
ARTIFACT_PATH: {{RUN_DIR}}/01-triage.md
Read before acting (via Read): none.
Return summary (≤10 lines, per the handoff contract of step 5.2): verdict + artifact path +
whether it emitted ## Intent note / ## Depth note + open items.

Follow your triage methodology. On a bug, validate the cause with the REAL data of the bug
account (not by reading/guessing/TS type) and prove the symptom before PROCEED.
Finish with: ## Verdict · ## Diagnosis (bug only, incl. Symptom proof) ·
## Validated brief · ## Out of scope · ## Request gaps ·
## Intent signals (bug only) · ## Open items.

Brief:
{{BRIEF}}

{{#RAW_EVIDENCE}}
Raw evidence from the user:
{{RAW_EVIDENCE}}

{{/RAW_EVIDENCE}}
Type: {{TYPE}}

{{>_context}}
{{>_shell-rule}}

{{>_footer}}
