# Triage

## Brief
**Affected area:** src/notice.mjs
**Context:** the gate notice is built by `composeNotice`
**Objective:** fill the gate notice again
**Expected outcome:** the gate notice carries the section it names
**Type:** bug/error
**Commit type:** fix

## Verdict: PROCEED

Evidence level: 3

## Diagnosis
- Exact symptom (target): the gate notice is empty
- Confirmed root cause: composeNotice drops the heading (src/notice.mjs:20)
- Symptom proof: <line-by-line path that produces the target symptom>

## Validated brief
Fix the empty notice built by `composeNotice`.

## Out of scope
- None.

## Request gaps
- None.
