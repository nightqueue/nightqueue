# Plan

## Implementation plan
- Add the `active` filter to listJobs.

## Symptom coverage

**How I enumerated:** `grep -rn "composeNotice" src`

| # | Path/trigger that produces this symptom | Status | Reason |
|---|---|---|---|
| 1 | retry path | covered | fixed in notice.mjs |

## Requires user confirmation
**Question for you:** approve fixing the retry path only?

## Assumptions
- [P1] the list reads one table (`src/queue/list.mjs:12`) — invalidated if: a view joins it.

## Pre-mortem
- [PM1] archived rows leak — mitigation: a test.

## Identified risks
- [R1] the default changes — how to test it: node --test.
