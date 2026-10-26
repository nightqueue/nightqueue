# Plan

## Implementation plan
- Add the `active` filter to listJobs.

## Symptom coverage

**How I enumerated:** I analyzed the code and the callers

| # | Path/trigger that produces this symptom | Status | Reason |
|---|---|---|---|
| 1 | retry path | covered | fixed in notice.mjs |
| 2 | cli path | covered | same helper |

## Usage coverage

**Diff axis:** filter — the diff changes which rows the list returns
**Always-gate class:** no — no query
**Scenarios consulted:** `grep -rn "listJobs" src`

- list view · today: all rows · after: active rows only · changed=yes · source=literal ticket ("only active")

## Assumptions
- [P1] the list reads one table — invalidated if: a view joins it.

## Pre-mortem
- [PM1] archived rows leak — mitigation: a test.

## Identified risks
- [R1] the default changes — how to test it: node --test.
