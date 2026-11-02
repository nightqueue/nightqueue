# Plan

## Implementation plan
- Add the `active` filter to listJobs.

## Usage coverage

**Diff axis:** filter — the diff changes which rows the list returns
**Always-gate class:** no — no query
**Scenarios consulted:** `grep -rn "listJobs" src`

- list view · today: all rows · after: active rows only · changed=yes · decision: the flag asks for it
- export csv · today: all rows · after: all rows · changed=no · decision: the export keeps every row

## Decisions taken
- Whether a paused job counts as active · it does not · a paused job is waiting for nobody's work

## Assumptions
- [P1] the list reads one table (`src/queue/list.mjs:12`) — invalidated if: a view joins it.

## Pre-mortem
- [PM1] archived rows leak — mitigation: a test.

## Identified risks
- [R1] the default changes — how to test it: node --test.
