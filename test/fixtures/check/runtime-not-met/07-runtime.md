## Round 1

## Runtime verdict
NOT-MET

Diff applies plan: yes

## Round 2

## Runtime verdict
NOT-MET

Diff applies plan: yes

| # | Scenario (declared entry point) | Result | Evidence |
|---|---|---|---|
| 1 | queue retry J-1 | MET | evidence/api-retry.log |
| 2 | queue close J-2 | NOT MET — the job stays open | evidence/api-close.log |
