# QA phase — the provers of /resolve

Read before launching the `qa-prover` lanes of a `full` QA.

**Stage B — Provers:** launch **N qa-guardian in parallel**, one per root group of the
analyst's return (never one per symptom), each the `qa-prover` step with `GROUP:` = that group,
passed verbatim. The `description` of each launch MUST start with `H<N> (group: <group>): ` —
the cockpit identifies each prover lane and its verdict by that prefix.

A return with no `APPENDED:` line, or with an `INCONCLUSIVE` hypothesis, relaunches that prover
once (🔁) with what was missing; its new round supersedes the old one of its group. What is still
missing is an ⚠️ open item.

**Consolidation — by the runtime:** `nightqueue run check 05` merges every round since the
analyst's, writes `## Round <n+1>` marked
`source: runtime consolidation` and answers over it. Nobody edits `05-qa.md` by hand.
