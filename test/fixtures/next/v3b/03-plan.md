# Plan

## Implementation plan
### Stage 1 — one
- a

### Stage 2 — two
- b

## Assumptions
- [P1] the list reads one table (`src/queue/list.mjs:12`) — invalidated if: a view joins it.

## Pre-mortem
- [PM1] archived rows leak — mitigation: a test.

## Identified risks
- [R1] the default changes — how to test it: node --test.
