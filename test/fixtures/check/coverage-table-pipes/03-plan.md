# Plan

## Implementation plan
- Add the `active` filter to listJobs.

## Symptom coverage

**How I enumerated:** `grep -rn "composeNotice" src`

| # | Path/trigger that produces this symptom | Status | Reason |
|---|---|---|---|
| 1 | `grep -E "a|b"` path | covered | fixed in notice.mjs |
| 2 | a \| b path | covered | same helper |
| 3 | studio path | covered | `rg "a|b"` shows it |

## Usage coverage

**Diff axis:** filter — the diff changes which rows the list returns
**Always-gate class:** no — no query
**Scenarios consulted:** `grep -rn "listJobs" src`

- list view · today: all rows · after: active rows only · changed=no · source=literal ticket ("only active")

## Assumptions
- [P1] the list reads one table — invalidated if: a view joins it.

## Pre-mortem
- [PM1] archived rows leak — mitigation: a test.

## Identified risks
- [R1] the default changes — how to test it: node --test.
