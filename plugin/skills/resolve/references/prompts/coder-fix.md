## File handoff (contract — read first)
ARTIFACT_PATH: {{RUN_DIR}}/04-implementation.md
Read before acting (via Read):
- `{{RUN_DIR}}/06-verification.md` — the last iteration (## Verification — iteration N): the
  verifier's failures to fix.
- `{{RUN_DIR}}/05-qa.md` — ## Proven breaks still open (pending).
- `{{RUN_DIR}}/04-implementation.md` — ## Modified files so far.
Rewrite `## Modified files` in ARTIFACT_PATH with the complete cumulative list via Write.
Return to the orchestrator AT MOST 10 lines: verdict/status + the handoff file written + open
items — never file contents, never a diff. Do NOT paste the complete section.

The verification failed. Fix exactly the failures/breaks reported in the
06-verification.md and the pending ## Proven breaks of the 05-qa.md, without introducing
a regression and keeping the project's standards. Make the PoCs pass by fixing the
cause — never by altering or deleting the PoC.

{{>_shell-rule}}

{{>_footer}}
