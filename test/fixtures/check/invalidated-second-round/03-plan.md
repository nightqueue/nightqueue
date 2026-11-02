# Plan

## Implementation plan
- Add the `active` filter to listJobs.


## Usage coverage

**Diff axis:** filter — the diff changes which rows the list returns
**Always-gate class:** no — no query
**Scenarios consulted:** `grep -rn "listJobs" src`

- list view · today: all rows · after: active rows only · changed=yes · source=literal ticket ("only active")

## Assumptions
- [H6] the list reads one table (`src/queue/list.mjs:12`) — invalidated if: a view joins it.
- [H7] archived rows carry a flag (`src/queue/list.mjs:12`) — invalidated if: they live in another table.
- [H8] no caller pages the list (`src/queue/list.mjs:12`) — invalidated if: a caller passes an offset.

## Pre-mortem
- [PM1] archived rows leak — mitigation: a test.

## Identified risks
- [R1] the default changes — how to test it: node --test.
