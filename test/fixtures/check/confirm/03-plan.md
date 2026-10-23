# Plan

## Implementation plan
- Add the `active` filter to listJobs.

## Symptom coverage

**How I enumerated:** `grep -rn "composeNotice" src`

| # | Path/trigger that produces this symptom | Status | Reason |
|---|---|---|---|
| 1 | retry path | covered | fixed in notice.mjs |
| 2 | cli path | not-covered | another subsystem |

## Usage coverage

**Diff axis:** filter — the diff changes which rows the list returns
**Always-gate class:** no — no query
**Scenarios consulted:** `grep -rn "listJobs" src`

- list view · today: all rows · after: active rows only · changed=yes · source=literal ticket ("only active")
- export csv · today: all · after: active · changed=yes · source=pipeline

## Requires user confirmation
- What the ticket expected: every path fixed · Why it is a problem: the cli path is shared · Proposed solution: fix retry only · Question: approve?

## Assumptions
- [P1] the list reads one table — invalidated if: a view joins it.

## Pre-mortem
- [PM1] archived rows leak — mitigation: a test.

## Identified risks
- [R1] the default changes — how to test it: node --test.
