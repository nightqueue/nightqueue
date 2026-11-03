---
name: resolve
description: >-
  Orchestrates an autonomous team of agents to solve any coding task.
  Pipeline: interpretation → triage-gate → exploration → architecture →
  implementation → QA → functional verification → report. Use when the user asks to
  "resolve", "implement", "fix" or describes a coding task that requires autonomous
  execution with integrated QA and verification.
---

# Resolve — Agent orchestrator

## The orchestrator's contract (read first)

The orchestrator coordinates and nothing else: it never reads source code, never explores the
repository, never reviews a diff itself — everything it needs reaches it as a ≤25-line subagent
return or as `nightqueue run …` output.

It works through five channels only; `<RUN_DIR>` files are not one:

- (a) the subagent returns;
- (b) `references/**` of this skill, each read when its phase says so;
- (c) the `nightqueue` MCP tools;
- (d) the harness's subagent launch, with the `subagent_type` and `model` of its block;
- (e) git/gh/`nightqueue run` in the subcommands the runtime allows; a denial says what to do instead.

Inside a queued job the runtime enforces them; never work around a denial — hand the need to the phase's subagent.
The orchestrator never calls `lesson_save`/`memory_save`; the reflector is the run's only writer.
Independent launches go in parallel; the runtime waits for every subagent and background task of an unattended run — never end a turn to wait for one.

## Resume

Read at Phase 0 when the prompt carries `RUN FACTS`. The block holds records, never a decision: you decide where to continue, from its verdicts and the artifacts' existence; hand artifact paths to the next agent, never read them to decide.

<!-- generic: moves to the pipeline template in R6 -->
- Continue after the last recorded phase whose artifact exists in `RUN_DIR` (`run check <NN>` tells, never Read/Glob), by its `NEXT:`. A recorded phase whose artifact is missing → redo from that phase; `-` names none to check.
- Reuse `Branch`/`Worktree`. A `wip(<slug>)` commit on the branch is the previous attempt's work: start on it, never reset or rewrite it; `run publish` folds it into the delivery commit.
- Answers apply at the phase that paused.

**Resolve's exceptions:**
- An answer at Phase 3: `run check 03` first, then its answer rule (approved → Phase 4; adjustments → relaunch the architect, `note` = the answer; a Type answer → `run_set` `type`).
- A retried `NOT-REPRODUCIBLE`/`NO-CHANGE-NEEDED` triage → relaunch the triager.
- Phase 5 re-runs whole; a `qa` `SKIPPED` has no artifact, so its triage check decides.

## Pipeline (execute in this exact order)

### Phase 0 — Start

1. **Run resume.** When the prompt carries a `RUN FACTS` block, read `references/phases.md`, then `## Resume`, and follow it before step 2.

2. **Start the run**: run `nightqueue run start` (outside a job add
   `--project <project> --slug <a short kebab-case slug of the request>`). It answers one JSON
   line: `runDir` (the `RUN_DIR` from here on; a `RUN_DIR:` line of the prompt is the same),
   `project`, `worktree`, `branch`, `models`, `needsSlug`, `demoRepo`, `baseRef`, `pluginRoot`,
   `stages`, `drafts`, `phases`, `prTemplate`, `commitConvention`, `commitTemplate`.

3. **One pipeline:** every run executes Phases 1–10; nothing in the request changes the phases.

4. **The worktree.** Inside a queued job the runtime created it at `$PWD` on branch
   `worktree-<slug>` and recorded it: never create another and never record `branch`/`worktree`.
   Run `git status --short` once: anything listed is a previous attempt's work — keep it. Pass
   `$PWD` to every phase. No `NIGHTQUEUE_JOB_ID` (an interactive `/resolve`) → read
   `references/interactive-worktree.md` now.

5. Every agent definition carries the shell rule; every test command a phase runs goes under an explicit `timeout`.

6–7. **After every `run check`, do what its last line says: `NEXT: <action>`.** After the first
   subagent returns read `references/phases.md`, once: the actions and the judgment they leave.

8. No execution log by hand: never time a phase nor keep a table — `run report` derives them.

9. **Autonomy.** The run executes without asking to confirm commands; the isolation is the
   worktree. It stops for the user only at the Phase 3 pause; everything else is routed or an open item.

### Phases 1–10

| Phase | Block of `## Phase prompts` | Gate |
| --- | --- | --- |
| 1 Triage | `triager` | `run check 01` |
| 2 Exploration | `explore` | `run check 02` |
| 3 Architecture | `architect` | `run check 03` |
| 4 Implementation | `coder`, one per stage | `run check 04` |
| 5 QA | `qa-triage`, then `qa-lite` or `qa-analyst` + `qa-prover` | `run check 05 --stage triage`, `--stage analyst`, `run check 05` |
| 6 Verification | `verifier`; `coder-fix` in its loop | `run check 06` |
| 7 Runtime | `runtime` | `run check 07` |
| 8 Commit and PR | none, `references/phase-8.md` | `run publish` |
| 9 Report | none, `references/phase-9.md` | `run report` |
| 10 Reflect | `reflector` | none |

## Phase prompts

Fill one block and launch it: the filled block, fence removed, is the whole `prompt`, with `subagent_type` = its
`AGENT` and `model` = its `MODEL`, from the `models` `run start` answered. No other call is needed.
Never add a line: relaunch context goes in `NOTE:` (`note=` of `NEXT:`),
an empty `STAGE:` is left out. `<RETURN>` is these three lines:

```
RETURN-HEAD: VERDICT: <verdict> · ARTIFACT: <file> · OPEN: <n>
RETURN-MAX-LINES: 27
## Did (≤ 5) · ## Found (≤ 10) · ## Open (≤ 6, or "none") +≤2 citations
```

### triager
```
TARGET: triager · AGENT: nightqueue:triager · MODEL: <models.triager>
RUN_DIR: <runDir>
WORKTREE: <worktree>
PROJECT: <project>
NEEDS_SLUG: <needsSlug>
NOTE: <note, or none>
<RETURN>
```

### explore
```
TARGET: explore · AGENT: nightqueue:explore · MODEL: <models.explore>
RUN_DIR: <runDir>
WORKTREE: <worktree>
PROJECT: <project>
NOTE: <note, or none>
<RETURN>
```

### architect
```
TARGET: architect · AGENT: nightqueue:architect · MODEL: <models.architect>
RUN_DIR: <runDir>
WORKTREE: <worktree>
PROJECT: <project>
INPUTS: 01-triage.md, 02-explore.md
DELIVERY: <limit, or none>
NOTE: <note, or none>
<RETURN>
```

### coder
```
TARGET: coder · AGENT: nightqueue:coder · MODEL: <models.coder>
RUN_DIR: <runDir>
WORKTREE: <worktree>
PROJECT: <project>
INPUTS: 01-triage.md, 03-plan.md, 04-implementation.md
STAGE: <stage>
NOTE: <note, or none>
<RETURN>
```

### coder-fix
```
TARGET: coder-fix · AGENT: nightqueue:coder · MODEL: <models.coder>
RUN_DIR: <runDir>
WORKTREE: <worktree>
PROJECT: <project>
INPUTS: 06-verification.md, ## Proven breaks, ## Generated PoCs of 05-qa.md, 04-implementation.md
NOTE: <the iteration and its failures, in one line>
<RETURN>
```

### verifier
```
TARGET: verifier · AGENT: nightqueue:verifier · MODEL: <models.verifier>
RUN_DIR: <runDir>
WORKTREE: <worktree>
PROJECT: <project>
INPUTS: ## Generated PoCs and ## Proven breaks of 05-qa.md, 04-implementation.md
STAGE: <stage>
BASE_REF: <baseRef>
DEMO_REPO: <demoRepo>
NOTE: <note, or none>
<RETURN>
```

### runtime
```
TARGET: runtime · AGENT: nightqueue:verifier · MODEL: <models.verifier>
Mode: RUNTIME
RUN_DIR: <runDir>
WORKTREE: <worktree>
PROJECT: <project>
INPUTS: 01-triage.md, 03-plan.md, 04-implementation.md, 06-verification.md
DEMO_REPO: <demoRepo>
NOTE: <note, or none>
<RETURN>
```

### qa-triage
```
TARGET: qa-triage · AGENT: nightqueue:qa-guardian · MODEL: <models.qa-triage>
RUN_DIR: <runDir>
WORKTREE: <worktree>
PROJECT: <project>
INPUTS: 00-brief.md, 03-plan.md, 04-implementation.md
BASE_REF: <baseRef>
NOTE: <note, or none>
<RETURN>
```

### qa-lite
```
TARGET: qa-lite · AGENT: nightqueue:qa-guardian · MODEL: <models.qa-analyst>
RUN_DIR: <runDir>
WORKTREE: <worktree>
PROJECT: <project>
INPUTS: 02-explore.md, 03-plan.md, 04-implementation.md
PLUGIN_ROOT: <pluginRoot>
DEMO_REPO: <demoRepo>
NOTE: <note, or none>
<RETURN>
```

### qa-analyst
```
TARGET: qa-analyst · AGENT: nightqueue:qa-guardian · MODEL: <models.qa-analyst>
RUN_DIR: <runDir>
WORKTREE: <worktree>
PROJECT: <project>
INPUTS: 02-explore.md, 03-plan.md, 04-implementation.md
PLUGIN_ROOT: <pluginRoot>
DEMO_REPO: <demoRepo>
NOTE: <note, or none>
<RETURN>
```

### qa-prover
```
TARGET: qa-prover · AGENT: nightqueue:qa-guardian · MODEL: <models.qa-prover>
RUN_DIR: <runDir>
WORKTREE: <worktree>
PROJECT: <project>
INPUTS: the analyst's round of 05-qa.md
GROUP: <ids — label, from the analyst's return>
PLUGIN_ROOT: <pluginRoot>
DEMO_REPO: <demoRepo>
NOTE: <note, or none>
<RETURN>
```

### reflector
```
TARGET: reflector · AGENT: nightqueue:reflector · MODEL: <models.reflector>
RUN_DIR: <runDir>
PROJECT: <project>
PLUGIN_ROOT: <pluginRoot>
NOTE: <note, or none>
RETURN-HEAD: REFLECTION: <n> saved · <n> recurrences · <n> skipped
RETURN-MAX-LINES: 10
```
