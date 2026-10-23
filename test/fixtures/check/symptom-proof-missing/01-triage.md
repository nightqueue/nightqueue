# Triage

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
