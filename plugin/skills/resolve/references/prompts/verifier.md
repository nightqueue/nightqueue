## File handoff (contract — read first)
ARTIFACT_PATH: {{RUN_DIR}}/06-verification.md (append-only: this launch is ## Round {{ROUND}})
Read before acting (via Read):
- `{{RUN_DIR}}/05-qa.md`, its last `## Round` — ## Generated PoCs (run them all); items with
  Proof=reading of ## Proven breaks (confirm by grep that they are gone).
- `{{RUN_DIR}}/04-implementation.md` — ## Modified files (the files to verify).
{{>_round}}
{{>_handoff}}

Inputs: the artifacts above; its scope; the stage when the plan is staged; the `## Applicable lessons` and `## Project memory` when the context carries them.

{{#STAGE}}
Stage: {{STAGE}}
{{/STAGE}}

Run: {{VERIFIER_SCOPE}}.
Apply your methodology (the QA's PoCs and the Runtime API Check when they apply).
A PoC that fails = the break is still present → FAILED.
A QA report runs before you here: a changed input/API with no PoC and no justification in it is FAILED.

{{>deliverables/verification}}

{{>_context}}
{{>_job-limits}}
{{>_demo-repo}}
{{>_shell-rule}}

{{>_footer}}
