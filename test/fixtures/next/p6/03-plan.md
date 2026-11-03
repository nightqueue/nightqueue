# Plan

## Implementation plan
- Add it.

**Type mismatch:** the request declared feature/refactor, but it reports a symptom

## Symptom coverage

**How I enumerated:** `grep -rn "a" src`

| # | Path/trigger that produces this symptom | Status | Reason |
|---|---|---|---|
| 1 | retry path | covered | fixed in a.mjs |

## Assumptions
- [P1] the list reads one table (`src/queue/list.mjs:12`) — invalidated if: a view joins it.

## Pre-mortem
- [PM1] archived rows leak — mitigation: a test.

## Identified risks
- [R1] the default changes — how to test it: node --test.
