## Deliver

Write this launch's output to ARTIFACT_PATH, in this order. `## Checks run` and the verdict line are mandatory (`nightqueue run check 06` fails without either, in the last `## Round`).

## Checks run
- <check> (`<command>`): PASSED | FAILED | SKIPPED
One line per line of the `nightqueue verify` block (typecheck, lint, build, test, poc, diff-hygiene) and a `ci-shaped` line when it ran; the diff-hygiene line quotes the `git diff --stat` summary and says whether it matches the brief.

## Failures (if any)
- [check]: file:line — essential error message
- [PoC]: vector/function — the assert or minimized counter-example that failed (break still present)

## Runtime API Check  (only when the diff introduces or changes a third-party call)
PASSED, or the list of problems.

The verdict is always the last heading, exactly one of:
## Verification: PASSED — every existing check passed (SKIPPED does not fail) and, on a runtime bug, the real bug path ran; state the evidence level that sustains it.
## Verification: PASSED-STATIC — the static checks passed but the runtime path of the bug did not run; list what was left unexecuted.
## Verification: FAILED — at least one check or PoC failed; list objectively what must be fixed.

Also write `{{RUN_DIR}}/evidence/automated-verification.md` with this round's `## Checks run`, `## Failures` and verdict line.
