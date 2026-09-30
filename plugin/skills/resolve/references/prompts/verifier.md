## File handoff (contract — read first)
ARTIFACT_PATH: {{RUN_DIR}}/06-verification.md (append per iteration)
Read before acting (via Read):
- `{{RUN_DIR}}/05-qa.md` — ## Generated PoCs (run them all); items with Proof=reading of
  ## Proven breaks (confirm by grep that they are gone).
- `{{RUN_DIR}}/04-implementation.md` — ## Modified files (the files to verify).
Write the verdict and the detail to ARTIFACT_PATH via Write; if it already exists (a re-run 🔁),
read it and rewrite it preserving the previous iterations, appending
## Verification — iteration N at the end. Return to the orchestrator AT MOST 10 lines:
verdict/status + the handoff file written + open items — never file contents, never a diff.
Do NOT paste the complete detail.

Tier: {{TIER}}
{{#STAGE}}
Stage: {{STAGE}}
{{/STAGE}}

Run: {{VERIFIER_SCOPE}}.
Apply your methodology (the QA's PoCs and the Runtime API Check when they apply).
A PoC that fails = the break is still present → FAILED.
Final verdict: ## Verification: PASSED, ## Verification: PASSED-STATIC
(runtime of the bug not executed) or ## Verification: FAILED.

{{>_context}}
{{>_shell-rule}}

{{>_footer}}
