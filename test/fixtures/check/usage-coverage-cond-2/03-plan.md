# Plan

## Implementation plan
- Add the `active` filter to listJobs.


## Usage coverage

**Diff axis:** filter — the diff changes which rows the list returns
**Always-gate class:** yes — the query changes which rows it returns
**Scenarios consulted:** `grep -rn "listJobs" src`

- list view · today: all rows · after: active rows only · changed=yes · source=literal ticket ("only active")

## Assumptions
- [P1] the list reads one table — invalidated if: a view joins it.

## Pre-mortem
- [PM1] archived rows leak — mitigation: a test.

## Identified risks
- [R1] the default changes — how to test it: node --test.
