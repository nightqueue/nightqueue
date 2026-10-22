## File handoff (contract — read first)
ARTIFACT_PATH: {{RUN_DIR}}/04-implementation.md
Read before acting (via Read):
- `{{RUN_DIR}}/06-verification.md`, its last `## Round` — the verifier's failures to fix.
- `{{RUN_DIR}}/05-qa.md`, its last `## Round` — ## Proven breaks still open (pending).
- `{{RUN_DIR}}/04-implementation.md` — ## Modified files so far.
{{>_handoff}}

Inputs: the artifacts above — the failures and the open breaks are the findings to fix.

The verification failed. Fix exactly the failures/breaks reported in the
06-verification.md and the pending ## Proven breaks of the 05-qa.md, without introducing
a regression and keeping the project's standards. Make the PoCs pass by fixing the
cause — never by altering or deleting the PoC.

{{>deliverables/implementation}}

{{>_job-limits}}
{{>_shell-rule}}

{{>_footer}}
