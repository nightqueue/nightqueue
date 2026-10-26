# Plan

## Implementation plan
- Add the `active` filter to listJobs.

**Diff axis:** filter — the diff changes which rows the list returns
**Always-gate class:** yes — the query changes which rows it returns

## Assumptions
- [P1] the list reads one table — invalidated if: a view joins it.

## Pre-mortem
- [PM1] archived rows leak — mitigation: a test.

## Identified risks
- [R1] 🟡 the default changes — how to test it: node --test.
