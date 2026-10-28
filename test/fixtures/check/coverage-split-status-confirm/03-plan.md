# Plan

## Requires user confirmation
- **Question:** should the escape apply to every git read (A) or only to the grep path (B)?

## Implementation plan
- Pending confirmation. Escape the pattern before the git grep call.

## Symptom coverage

**How I enumerated:** I read the operator code paths

| # | Path/trigger that produces this symptom | Status | Reason |
|---|---|---|---|
| V1 | operator grep path | covered | the escape wraps the pattern |
| V14 | operator log path | covered under (A) · not-covered under (B) | depends on the answer |

## Usage coverage

**Diff axis:** other — the escape changes no query
**Always-gate class:** no — no query
**Scenarios consulted:** `grep -rn "git grep" src`

- grep tool · today: unescaped · after: escaped · changed=yes · source=literal ticket ("escape the pattern")

## Assumptions
- [P1] the grep path is the only shell call — invalidated if: another tool shells out.

## Pre-mortem
- [PM1] the escape breaks a literal pattern — mitigation: a test.

## Identified risks
- [R1] a pattern with quotes — how to test it: node --test.
