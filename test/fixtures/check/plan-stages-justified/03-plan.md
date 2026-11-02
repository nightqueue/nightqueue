# Plan

## Implementation plan
**Stage reason:** green intermediate — each stage leaves the suite green.

### Stage 1 — first
- a

### Stage 2 — second
- b

### Stage 3 — third
- c


## Assumptions
- [P1] the list reads one table (`src/queue/list.mjs:12`) — invalidated if: a view joins it.

## Pre-mortem
- [PM1] archived rows leak — mitigation: a test.

## Identified risks
- [R1] the default changes — how to test it: node --test.
