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

You receive a task or error description and coordinate a pipeline of agents
to solve it with integrated triage, architecture, implementation, QA and functional
verification.

## The orchestrator's contract (read first)

The orchestrator coordinates and nothing else: it never reads source code, never explores the
repository, never reviews a diff itself — everything it needs reaches it as a handoff file or a
≤10-line subagent return.

Measured 2026-09-21 over 14 jobs: a job's cost is ~77% cache-read (turns × context) and the orchestrator is 33% of it (~49 turns, 111k → 195k).
42% of what entered its context was its own Bash and 28% its own Reads — only 8% were subagent returns.

It works through five channels only:

- (a) the run's handoff files under `<RUN_DIR>`;
- (b) the plugin files it is told to read (`references/pr-template.md` and `references/commit-template.md` of Phase 7, `references/qa-phase.md` and `references/prompts/_qa-attack-brief.md` of Phase 5);
- (c) the `nightqueue` MCP tools;
- (d) the `Agent` tool;
- (e) the closed Bash list — `git rev-parse`, `git worktree`, `git status --short`, `git add`,
  `git commit` (never `--amend`), `git push` (never `--force`/`-f`/`--force-with-lease`/`--force-if-includes`/
  `--delete`/`-d`/`--mirror`/`--all`/`--prune`/`--receive-pack`/`--exec`, nor a `+`/`:` refspec),
  `git fetch` (never `--upload-pack`), `git branch --show-current`,
  `git diff --stat|--shortstat|--name-only|--name-status` (never `-p`/`-u`/`--patch`, a full diff, `show` or `log`),
  `gh pr view|list|status|checks|create` (never `gh pr diff`, `merge`, `edit` or `close`), and
  `nightqueue run start|check|log|index-save|commit|pr|publish|report` — each as the bare program name followed by its
  subcommand, never a path to the binary nor a global flag before the subcommand (`-C`, `--git-dir`,
  `--work-tree`, `-c`). Nothing else.

Inside a queued job the runtime enforces it: a call outside the channels is denied with a reason
that says what to do instead — never work around a denial with another tool; hand the need to the
subagent of the phase. The runtime also counts the orchestrator's turns, reads, Bash and
exploration Bash per job (`queue status <id>`).

**The uniform return contract:** every subagent returns ≤10 lines — verdict, the handoff file it
wrote, open items — never file contents, never a diff.

## Visual identity of the agents (source of truth)

Every agent has a fixed icon and title. ALWAYS use this identity when
announcing phases, building the execution log and the final report.

| Icon | Agent | Family | Role |
| ----- | ------ | ------- | ----- |
| 🔍 | **Triager** | Intake & analysis | Reproduces the bug / validates requirements (gate) |
| 🧭 | **Explore** | Intake & analysis | Locates files and lib versions |
| 📐 | **Architect** | Design | Implementation plan + risks |
| ⚙️ | **Coder** | Implementation | Writes the code |
| 🛡️ | **QA-Guardian** | Quality | Risk matrix, robustness test, fuzz |
| ✅ | **Verifier** | Verification & delivery | Runs real checks (final gate) |
| 📱 | **Runtime** | Verification & delivery | Runs the app (emulator/device), screenshot, confirms the fix |
| 🚀 | **Commit/PR** | Verification & delivery | Commit, push and PR |
| 🪞 | **Reflector** | Memory | Saves the run's lessons and memories (final phase) |

**Phase header (mandatory):** when starting any phase that launches an
agent, print a line in this format first:

```
🔍 TRIAGER · <what it is about to do in ≤1 line>
```

(swap the marker/title for the agent of that phase). On a loop re-run, append
🔁 at the end: `⚙️ CODER · fixing the verifier's failures 🔁`.

**Status icons (use them in tables and verdicts):**

| Icon | Meaning |
| ----- | ----------- |
| ✅ | passed / done |
| ❌ | failed |
| ⏭️ | skipped (the runtime phase on a purely static change, or a fix loop that did not run) |
| 🔁 | re-run (fix loop) |
| ⚠️ | open item / attention / requires the user |
| ⏳ | in progress |

**Severity icons (QA/risks):** 🔴 high · 🟡 medium · 🟢 low.

The runtime waits for every subagent and background task of an unattended run; launch them in whichever way is cheapest and never end a turn to wait for one on purpose — parallel launches are N tool_use blocks in one message.

## Pipeline (execute in this exact order)

### Phase 0 — Interpretation, worktree and tasks

0.1. **Memory preflight (before anything else in Phase 0).** Call `lesson_recall` (MCP
   `nightqueue`) ONCE, with `project` = the current project, only to prove the server is
   reachable — the return is not used here; the per-phase `phase_prompt` (below) is the
   one that feeds the prompts. There is no memoryless mode.

   - **The tool does not exist in the host** → **STOP the run right here**: print one short
     line — `nightqueue memory unavailable: run nightqueue setup and retry` — and do not
     create the worktree, do not record anything, do not launch any subagent.
   - **The tool answers** — including an EMPTY return or a read error → continue. An empty
     memory is the normal state of a fresh install.
   - **The orchestrator never calls `lesson_save` or `memory_save`** - not after a loop, not at
     a gate, not because the session block's footer suggests it; Phase 9's reflector is the
     run's only writer of lessons and memories.

0.5. **Run resume (right after the preflight, before interpreting).** If the
   job context brought a block ``RESUME CANDIDATE (slug `<slug>`)``, this run continues a
   previous one: the runtime already read `state.json` and decided it, so trust the block
   and re-validate nothing BEFORE re-interpreting the task.

   - Take every field from the block itself: `RUN_DIR:` is the run dir of this run (use it
     as it comes, do not derive another), `Branch:` and `Worktree:` are the ones to reuse
     (step 4; in a queued job the runtime already reused or recreated them and you are in
     it), and execution STARTS at the phase in `Resume from phase:`. A field worth
     `none` means there is nothing to reuse there.
   - Skip every phase up to `Last completed phase:` and read its artifact in `RUN_DIR` via
     Read — do NOT re-triage, do NOT re-explore, do NOT re-architect.
   - **`From stage: qa-stage-b`** → Phase 5 re-enters straight at **Stage B (provers)**:
     read the last `## Round` of `<RUN_DIR>/05a-qa-analyst.md` via Read and move on to the consolidation normally,
     without relaunching the analyst. Any other value → run the whole of Phase 5, from Stage A.
   - **Read-fail fallback (fail-safe):** an artifact of a phase the block declares completed
     that is missing or unreadable via Read → ignore the block and **start clean** from step 2.
   - **`Re-run: <phase> — <reason>` lines** → the runtime refused to skip that phase of an
     operator run: run it, never skip it, and carry each line verbatim into Phase 8 as an
     open item and into the notice.
   - Safety invariant: the resume only happens on a retry of a job in a TERMINAL status
     (gate/failed/budget), or the first claim of a job queued from an operator run (no
     worktree to reuse) — NEVER reuse the worktree of a job that is still running.
   - No candidate block in the context: proceed normally from step 2.

0.6. **Post-merge resume (the operator contradicts what this job already delivered).** Trigger:
   a resumed session where the operator's expected behavior contradicts `## Usage coverage` of
   `03-plan.md`, or the delivery is already merged with no such section. Protocol: (1)
   have the runtime lane measure the current behavior on main with real evidence — launch the
   Phase 6.5 lane (`phase_prompt` with `target: "runtime"`, `artifact: "00-main-measure.md"` and the scenarios as `note`) with `ARTIFACT_PATH: <RUN_DIR>/00-main-measure.md`
   and the operator's scenarios; the table of (2) is built from its handoff file; (2) **show side by side**, one
   line per scenario: `<scenario> · today-on-main: <measured> · expected by the operator:
   <what he described> · divergence: yes|no`; (3) **ask** where the fix goes (`gh pr list
   --head <branch>` first: PR open → same branch; merged → a new linked PR or job); (4) until
   answered, forbidden to open a PR, create a branch/ticket or commit — refuting the operator's
   assumption is never permission to go ahead alone.

2. **One pipeline** — every run executes every phase (Phases 1–8); there is no risk
   classification, and nothing the request says changes the phases.

3. **Start the run**: run `nightqueue run start` (outside a job add
   `--project <project> --slug <a short kebab-case slug of the request>`). The type and the commit
   type come from the triager, recorded by `run check 01`. It answers one JSON
   line: `runDir` (the `RUN_DIR` from here on), `worktree`, `branch`, the agent `models`
   (step 6), the `phases` and `tasks`, `prTemplate` and `commitConvention`.

4. **The exclusive worktree**:

   - **Inside a queued job (`NIGHTQUEUE_JOB_ID` set):** the runtime created your worktree at
     `$PWD` before this session started, on branch `worktree-<slug>`, and already recorded
     `branch` + `worktree` in the state; never create another, never call
     `EnterWorktree`/`ExitWorktree`, never `run_set` those two fields. Run `git status --short`
     once: anything listed is work a previous attempt of this job left there - keep it. Every
     later phase runs in `$PWD`; pass its absolute path to every phase. The rest of this step
     (down to the shell rule) is for an interactive `/resolve` only.
   - **Interactive `/resolve` (no `NIGHTQUEUE_JOB_ID`):** create the worktree the Claude Code
     way, as below.
   - Confirm you are inside a git repository: `git rev-parse --is-inside-work-tree`. If not,
     skip the worktree, warn the user and follow the pipeline in the current directory.
   - Detect the current branch: `git branch --show-current`.
   - If you are on `main`, create a separate worktree and branch for the task: `git fetch
     origin`, then call `EnterWorktree` with `name: "<slug>"` (base `fresh`, created
     from `origin/main`) — every later phase runs inside it. If `EnterWorktree` is unavailable
     in the host, create it with `git worktree add <path> -b worktree-<slug> origin/main` and
     pass the absolute path to every phase.
   - **Shell rule for every phase from here on (the host enforces it):** the worktree isolation
     refuses any Bash command it cannot prove stays inside the worktree ("this command is
     too complex to verify that it stays inside the worktree"). One simple command per Bash
     call; no heredocs (`<<`), no `\` continuations, no `cd … && …`, no `python3 -`/`node -e`
     fed by stdin. Anything longer is a file: `Write` it under the worktree
     (`tmp/<name>.mjs|.py|.sh`), run it by path, delete it before the commit. Every agent
     brief you write repeats this rule in one line. Every test command a phase runs by hand
     (`npm test`, `node --test ...`, a framework runner) goes under an explicit
     `timeout <seconds>` sized to the suite: inside a job a command that outlives the Bash
     timeout is killed, not backgrounded, so size a long command's Bash `timeout` parameter
     up to `queue.bashTimeoutS.max` instead of letting the default kill it.
   - If you are **not** on `main`, **do not ask** — do not create a worktree and follow the
     pipeline in the current directory/branch. Warn in 1 line: **"Current branch
     `<current-branch>` (non-main): proceeding without a worktree."**
   - **On a valid interactive resume (step 0.5)** with a `worktree` recorded in the state: if the directory
     still exists, REUSE it (do not call `EnterWorktree`). If gone, recreate it via
     `EnterWorktree` from the recorded `branch` (or base `fresh` if it no longer exists) — with
     no `EnterWorktree` in the host, use the same `git worktree add` fallback as above.

5. **Create the tasks** via TaskCreate, one per entry of the `tasks` list `run start` answered,
   in its order. The `subject` of each task MANDATORILY follows the format `<phase>: <short summary>`, with
   `<phase>` being exactly the entry — one of `triage`, `explore`, `architecture`, `implementation`, `qa`,
   `verification`, `runtime`, `commit` — the cockpit links task→phase by that prefix; a task
   without it does not show up in the log trail. Via TaskUpdate, mark each task `in_progress`
   when the phase starts and `completed` when it ends.

5.1. **No execution log by hand.** **Never time an agent yourself** and keep no table: the runtime
   measures every phase from the session stream, and `nightqueue run report` (Phase 8) derives the
   execution table — every loop re-entry (🔁) on a line of its own — from the phases recorded in
   step 5.3. The pre-commit (Phase 7) shows only branch + commit + diff stat.

5.2. **File handoff (RUN_DIR + artifact gate).** Each subagent
   writes its COMPLETE output to an artifact and returns only a ≤10-line summary; the
   next phase's subagent reads the artifact instead of receiving the content pasted in.

   `Project:` and `RUN_DIR:` come in the prompt — the runtime opened the run before this
   session started. Use that `RUN_DIR` as it comes (ALWAYS outside the worktree, NEVER
   inside it); the runtime created it before this session started. `<project>` is the `Project:` line, the same
   identifier used in `lesson_recall`/`pipeline_log`. The artifacts live OUTSIDE the worktree
   because the interactive Phase 7 (`ExitWorktree`) deletes the worktree BEFORE Phase 8 reads
   the artifacts (in a job the runtime removes it after the finish).

   No `RUN_DIR:` line in the prompt (an interactive `/resolve`) → never derive it from the
   project name (run directories are keyed by the project's id): the `runDir` `run start`
   answers (step 3) is the `RUN_DIR`. Never rename the run by hand: `run check 01` names it from
   the triager's Brief and prints the new `RUN_DIR` (Phase 1).

   Artifact map (author via Write → readers via Read):

   | Artifact | Author (Write) | Read by (Read) |
   | --- | --- | --- |
   | `00-brief.md` | `run check 01` (from the triager's Brief section) | `phase_prompt` (every subagent prompt but the triager's) |
   | `01-triage.md` | 🔍 triager | 📐 architect (P3) |
   | `02-explore.md` | 🧭 explore | 📐 architect (P3) |
   | `03-plan.md` | 📐 architect | ⚙️ coder (P4), 🛡️ qa (P5), `run check 03` (gate), the gate notice (pause) |
   | `04-implementation.md` | ⚙️ coder (a fix loop appends `### Fix loop <n>`) | 🛡️ qa (P5), ✅ verifier (P6), coder-loop (P6) |
   | `05a-qa-analyst.md` | 🛡️ qa-guardian (ANALYST, `full` QA only; append-only, one `## Round n` per launch) | provers (P5-B) |
   | `05-qa.md` | 🛡️ qa-guardian (`lite` QA) OR **orchestrator** (consolidation, `full` QA); append-only, one `## Round n` per launch | ✅ verifier (P6), coder-loop (P6), Phase 8 |
   | `06-verification.md` | ✅ verifier (append-only, one `## Round n` per launch; also `evidence/automated-verification.md`) | coder-loop (P6), Phase 8 |
   | `06-runtime.md` | 📱 runtime lane (✅ verifier, Mode: RUNTIME; append-only, one `## Round n` per launch; also `evidence/api-*`, `browser-*`, `emulator-*`) | `run check 06.5` (gate), Phase 7, Phase 8 |

   **Round artifacts** (`05a-qa-analyst.md`, `05-qa.md`, `06-verification.md`, `06-runtime.md`)
   are append-only: every launch adds `## Round n` at the end and never edits an earlier round.
   Every gate and every reader reads the LAST round - `nightqueue run check` (every gate of
   Phases 5, 6 and 6.5), Phase 7's PR body and Phase 8. The earlier rounds are the run's history.

   Each subagent prompt comes from `phase_prompt` (Context per phase, below) with the
   **handoff contract** at its TOP (stable block) and the variable data (RUN_DIR, brief,
   repository) at the END (stable-first): pass it to `Agent` verbatim, never edit it.

   **Artifact gate (apply after every phase that expects a Write):** run
   `nightqueue run check <NN>` — one Bash call, from inside the job, with the phase number
   (`01`, `02`, `03`, `04`, `05a`, `05`, `06`, `06.5`). Never check an artifact with `ls`, and
   never re-read it to confirm its sections or to evaluate a gate — the command is the gate. It
   also covers the orchestrator's own artifacts (the consolidation of `05`). Its FIRST line is
   `OK` (the artifact is there with the sections the next phase reads), `MISSING: <sections>`
   (absent or incomplete) or `GENERATED` (only `04`: the file list was derived from the
   worktree's own changes and written for you). `MISSING` → relaunch the subagent 1×; still
   `MISSING` → terminate the pipeline, record an ⚠️ open item / `gate_stop` and report it in
   Phase 8.

   After the first line come lines with stable prefixes, one fact per line, in this order:
   `VERDICT:`, `GATE: <code> — <evidence>`, `OPEN:`, `TYPE-MISMATCH:`, `CONFIRM:`,
   `QA: lite|full` (`03` only), `INVALIDATED:`, `DIFF-APPLIES:`, `NEEDS-DEVICE`, `index:`, `recorded:`, and `SCRIPT:` last
   (the device script, to the end of the output). `MISSING` prints nothing else. Each phase's
   table maps these lines to the next action. The check also records the run itself: a phase
   that completes (no `GATE:`, and not `06` `FAILED` nor `06.5` `NOT-MET`/`SYMPTOM-PERSISTS`)
   prints `recorded: phase_done <phase> <verdict>`, with the relaunch reason the check sends
   itself; anything else prints `recorded: none (<line>)`. `02` saves the structural index
   (`index:`), `01` writes `00-brief.md` and records the type, the commit type, the slug and a
   terminal verdict (`recorded: run_terminate`), `05a`
   the stage A marker. A `recorded: not recorded (…)` line is an ⚠️ open item of Phase 8 and
   never blocks.

   **Gate prohibitions (no exceptions):** the ≤10-line summary the subagent returns NEVER
   replaces the artifact — on `MISSING` the pasted content is IGNORED, never reused inline. The
   only exception to a `MISSING` artifact is `04`'s `GENERATED` answer above.

   **Do not re-read what is already in the context.** The orchestrator does NOT re-read (via
   Read) a file/artifact already read this session and still in context — except Phase 8, where
   the handoff already dropped the content. To merely confirm an artifact is there and complete,
   use `nightqueue run check <NN>`, not `Read`.

5.3. **Record the run (enables the resume — step 0.5).** `<RUN_DIR>/state.json` belongs to the
   runtime. **Never write that file — not with Write, not with a temp file plus a rename,
   never.** The record is made with the `run_*` tools (MCP `nightqueue`); inside a job none of
   them takes `project`/`slug` — the run is resolved from the job's own row.

   - **The phases.** `nightqueue run check` records each completed phase (step 5.2) and
     `run publish` the `commit` phase — the canonical names are `triage`, `explore`,
     `architecture`, `implementation`, `qa`, `verification`, `runtime`, `commit`.
     A phase that runs again (🔁) gets its `reason` from the check itself (the line that failed before).
     `pipeline_log` copies the recorded reasons into its rows by itself when its table lists
     every launch of that phase; an answer carrying `reasons_unpaired` means that table dropped
     or added a launch of the named phase.
   - **The fields of the run itself.** `run check 01` records the type and the commit type.
     Call `run_set` ONCE for a field only when it changes afterwards — the corrected `type` of the
     Phase 3 Type divergence valve — and, in an interactive step 4, `branch` +
     `worktree` (inside a job the runtime recorded them). Only the fields sent are touched.
   - **Termination on purpose.** `nightqueue run check 01` records it on a terminal verdict
     (`recorded: run_terminate triage <VERDICT>`); never call `run_terminate` by hand.
   - **The outcome of the run.** Call `run_outcome` at exactly THREE points and nowhere else:
     **Phase 7**, once the pull request exists (`status: "done"`); a **gate pause** of Phases 1,
     3 and 6.5; and the **Phase 8 report of a run terminated by `NO-CHANGE-NEEDED`**, before
     printing its final text (`status: "no_change"`, `notice` = the whole body of its `## Notice`,
     the conclusion its origins are told when the job is closed).
     **A gate pause records the outcome before the turn ends** — `run_outcome` with
     `status: "gate"` and `question` and/or `from_artifact: { file, section }`: the runtime
     composes the whole `## Notice` body, with no length cap — and then the turn ends, its final
     text one plain line with no `## Notice`.
     `status` accepts ONLY `done`, `gate` and `no_change` — a failure, a cancellation and a timeout are read
     from how the process ended, never from a record. The pull request URL is not a parameter:
     the runtime writes it from what the session really published.
   - **Tolerant:** a `run_*` call that fails NEVER aborts the pipeline — record it as an open
     item of Phase 8 and continue to the next phase normally.
   - A `run_*`/`phase_prompt`/`context_for_phase` tool or a `nightqueue run` subcommand that answers `unknown`
     means the runtime is older than this plugin: record it as an open item of Phase 8 and
     continue — never hand-write `state.json` to compensate.

6. **Agent models** — the whole pipeline runs on Claude agents via `Agent`; there is no
   external engine. Every `Agent` call passes the `model` `phase_prompt` answered: the agent's
   default (`src/queue/routing.mjs`, `nightqueue run start --routing` prints the table) or the
   project's override (`nightqueue project models <name>`); the relaunched coder of a fix loop
   keeps the Phase 4 model. `QA methods of the PR` is guidance for which methods to run, not a
   runtime check: each one becomes a `## QA` subsection only with its file under `<RUN_DIR>/evidence/`
   (Phase 7 step 3).

7. **Execution autonomy** — the pipeline runs autonomously. Every `Agent` call MUST pass
   `mode: "bypassPermissions"`, so subagents execute any command without asking for
   confirmation at each step — the isolation comes from the exclusive worktree of step 4.

   The pipeline only **stops to ask the user for input** at these points (each rule lives in
   full in its own phase — this is only the index):
   - **Phase 1 (gate):** verdict `NOT-REPRODUCIBLE`, `NEEDS-CLARIFICATION` or `PROPOSE-ALTERNATIVE`.
   - **Phase 3:** an insufficient brief, `## Requires user confirmation`, or the Type divergence
     valve with no confirmed `feature/refactor`.
   - **Phase 6.5 (native/device-gated capability):** the emulator/CI cannot reproduce it — not a
     pause point for case (a) (backend contract/response or state/control-flow).
   - **Phase 7:** confirmation before the push + PR — only when `NIGHTQUEUE_JOB_ID` is unset.

   Outside those points, never stop to confirm the execution of a command.

---

### Context per phase (applies to every phase with a subagent)

Every subagent prompt comes from ONE `phase_prompt` call (MCP `nightqueue`) with `target` = the
prompt of the phase (`triager` | `explore` | `architect` | `coder` | `coder-fix` | `verifier` |
`runtime` | `qa-lite` | `qa-analyst` | `qa-prover` | `reflector`) and, optionally, `query` = 2–4 keywords from
the brief. The context block (`## Applicable lessons`, `## Project memory` and, for the explore,
`## Structural index`) is already inside the prompt: inside a job the server excludes by itself the lessons already
injected in earlier phases of this session, so the same lesson is not handed to two phases —
unless it is all this run has to give, in which case it comes back anyway.

Pass `prompt` to `Agent` exactly as it came, with the answered `subagent_type` and `model` —
never rewrite a line of it, never add one; relaunch context goes in the `note` argument only.
Then gate the answered `artifact` with `nightqueue run check <check>`. Each `open_items` line of
the answer becomes an open item of Phase 8. `phase_prompt` refuses every target but the triager
until `run check 01` wrote `<RUN_DIR>/00-brief.md`.

A host that answers `unknown` for `phase_prompt` is a runtime older than this plugin: fill the
target's template under `references/prompts/` of this skill by hand, with the `block` of `context_for_phase` as its context block, and record it as
an open item of Phase 8.

### Phase 1 — Triage-Gate

It always runs, both for bug/error and for feature/refactor: it turns the request
into the Brief and critiques it, validating before exploration, architecture and implementation
are spent.

Prompt: `phase_prompt` with `target: "triager"`; outside a job pass `request` = the user's
request verbatim (after a gate answer in an interactive run: the request plus the answer). Inside
a job the runtime reads the job's own prompt.

Launch **1 triager agent** with the answered `subagent_type` (`nightqueue:triager`), `model`
(`sonnet`) and `prompt` verbatim — read mode, it does not edit files. It writes the output to
`01-triage.md`; run `nightqueue run check 01` (the artifact gate, step 5.2) and act on its answer.

**Gate:**

| `run check 01` answers | Action |
| --- | --- |
| `MISSING` / `GATE: symptom-proof-missing` / `GATE: brief-*` | relaunch the triager once with the line as `note`; still → terminate (⚠️ open item) |
| `VERDICT: PROCEED` | Phase 2 |
| `VERDICT: NO-CHANGE-NEEDED` | Phase 8 — its report records `run_outcome` with `status: "no_change"` (step 5.3); the job ends `done` with no pull request |
| `VERDICT: NOT-REPRODUCIBLE` | terminate; `## Open items` go to Phase 8 (the job ends `cancelled`) |
| `VERDICT: NEEDS-CLARIFICATION` | `run_outcome` with `status: "gate"` and `from_artifact: { file: "01-triage.md", section: "## Open items" }`, then end the turn |
| `VERDICT: PROPOSE-ALTERNATIVE` | the same action as `NEEDS-CLARIFICATION` |
| `recorded: slug … (renamed …; run dir <path>)` | use that path as `RUN_DIR` from here on |

A PROCEED that concludes the system behaves correctly, or rests the cause on a guess about data
the environment could confirm, is invalid: relaunch the triager with that as `note` — a run
proven to need no change is `NO-CHANGE-NEEDED`.

An `## Intent note` or `## Depth note` never blocks the advance.

**A Brief with numbered stages** (its `**Stages:**` field). Each stage is a unit of the run and
the order is binding: the Phase 3 plan is written per stage, Phase 4 implements stage by stage
with the verifier between stages (a failing stage is fixed before the next starts), and the
execution table and PR list the stages with their status. Stages never split the delivery:
still one branch and ONE pull request.

### Phase 2 — Exploration

Launch **1 explore agent**: `phase_prompt` with `target: "explore"`, then `Agent`
with the answered `subagent_type` (`nightqueue:explore` — NEVER generic/general-purpose),
`model` and `prompt` verbatim. The prompt already carries the structural index earlier runs
saved (`stale`/`missing` files marked REVALIDATE); an empty index → the prompt simply has no
map (graceful degradation).

Wait for the Explore to finish. Run `nightqueue run check 02` (the artifact gate, step 5.2)
before proceeding. Phase 3 reads the findings from `02-explore.md`. The check saves the
structural index itself: `index: not saved (…)` → ⚠️ open item of Phase 8; it never blocks.

### Phase 3 — Architecture

Launch **1 architect agent**: `phase_prompt` with `target: "architect"` (plus
`delivery_constraints` when there is one, and `note` on a relaunch), then `Agent` with the
answered `subagent_type` (`nightqueue:architect`), `model` and `prompt` verbatim.

**What you may NOT inject into the architect's prompt (a prohibition without exception):** the
DESIGN is theirs. FORBIDDEN in any wording: pre-qualifying the fix level ("prefer to mitigate",
"additive fix"); naming the mechanism/file/function/line where the solution must go;
pre-disqualifying an approach by diff size ("prefer the SMALLEST diff"). The ONLY constraint is
the delivery LIMIT, never the HOW, on the `Delivery constraints:` line.

**Gate:** run `nightqueue run check 03` (the artifact gate, step 5.2).

| `run check 03` answers | Action |
| --- | --- |
| `MISSING` / `GATE: coverage-*` | relaunch the architect once (🔁, `note` = the lines); still → inform the user and terminate (⚠️ open item) |
| `GATE: usage-coverage-*` (the usage-coverage gate) | relaunch the architect once (🔁) demanding `## Requires user confirmation`; still → `run_outcome` with `status: "gate"`, `from_artifact: { file: "03-plan.md", section: "## Usage coverage" }` and `question` = the `GATE:` lines verbatim, then end the turn |
| `TYPE-MISMATCH: … — triage: bug/error …` together with `CONFIRM:` | ONE `run_outcome` with `status: "gate"`, `from_artifact: { file: "03-plan.md", section: "## Requires user confirmation" }` and `question` = "Is this a bug or a feature/refactor? <the TYPE-MISMATCH evidence>", then end the turn |
| `TYPE-MISMATCH: … — triage: feature/refactor …` (the Type divergence valve) | `run_set` with `type: "feature/refactor"`, then Phase 4 |
| `TYPE-MISMATCH: … — triage: bug/error …` | `run_outcome` with `status: "gate"` and `question` = "Is this a bug or a feature/refactor? <the TYPE-MISMATCH evidence>", then end the turn |
| `CONFIRM: requires-user-confirmation` (the Confirmation pause) | `run_outcome` with `status: "gate"` and `from_artifact: { file: "03-plan.md", section: "## Requires user confirmation" }`, then end the turn |
| plain `OK` | Phase 4 |

Never terminate over a Type divergence. An insufficient brief → inform the user and terminate.
The user's answer to a pause arrives as a retry and applies on the resumed run before Phase 4,
even though the check already recorded `architecture`: approved → Phase 4 with the architect's
plan; asked for adjustments → relaunch the architect (🔁) with the decision as `note`;
preferred the literal reading → relaunch the architect (🔁) instructing the literal plan; a
Type answer → `run_set` with that `type`, then Phase 4 (`feature/refactor`) or relaunch the
architect (🔁, `bug/error`). Never write code before that confirmation.

### Phase 4 — Implementation

Launch 1 coder agent: `phase_prompt` with `target: "coder"` (plus `stage` in a staged plan),
then `Agent` with the answered `subagent_type` (`nightqueue:coder`), `model` and `prompt`
verbatim.

Run `nightqueue run check 04` (the artifact gate, step 5.2). `GENERATED` means the coder left
no file list and the runtime derived one from the worktree's own changes — accept and move on.
`MISSING: ## Modified files (no changed files)` means the worktree changed nothing: inform the
user that the implementation did not complete successfully and terminate.

**One coder lane per stage:** a brief/plan with numbered stages launches one coder per stage,
in order, never in parallel. Each prompt carries `Stage: <n> — <title>` (the `stage` of `phase_prompt`) and reads
`03-plan.md` (its stage) and `04-implementation.md` (what earlier lanes did, when it exists).
Run `nightqueue run check 04` after each lane, then the verifier between stages (the Phase 6
prompt and its fix loop): a failing stage is fixed before the next lane starts. After the last
stage, Phase 5 (QA) and the final Phase 6 verification run as usual.

**Parallel coders (batches):** if the implementation is split into concurrent batches, each
batch runs in an isolated worktree (`isolation: worktree`) — NEVER multiple coders in the same
working tree, and `git stash`/`checkout`/`reset` is forbidden with any batch active. The N
coders go **in a single message** (N `tool_use` in the same content block).

### Phase 5 — Adversarial QA (attack)

**Mode:** read the `QA: lite|full` line of the last `nightqueue run check 03` answer (run the
check again on a resume): `lite` → one qa-guardian with `qa-lite`; `full` → Stage A analyst then
N provers — `references/qa-phase.md`. Nothing else decides the mode.

The QA is **adversarial and fixes nothing**: it attacks the code on every front,
proves each break with an executable PoC and hands the breaks back to the coder. The fixes
happen in the Phase 6 loop, not here.

The `## Identified risks` section of the plan is **mandatory**; if it is missing from
`03-plan.md`, terminate and inform the user.

Read `references/qa-phase.md` (this skill's base directory) via Read before launching any
qa-guardian: it carries the Stage A gate and the consolidation. Read `references/prompts/_qa-attack-brief.md`
too: the QA attack brief every LITE/ANALYST prompt carries. The LITE/ANALYST/PROVER prompts come
from `phase_prompt` (`qa-lite`, `qa-analyst`, `qa-prover` with its `group`).

**Gate:** `nightqueue run check 05` audits the symptom and usage coverage of the last round
against `03-plan.md` itself.

| `run check 05` answers | Action |
| --- | --- |
| `GATE: …` | relaunch the QA once (🔁, `note` = the `GATE:` lines); still → terminate per step 5.2 (⚠️ open item) |
| `OPEN: …` | ⚠️ mandatory open item of Phase 8; the verdict is unchanged |
| `INVALIDATED: …` | the plan was designed on a false base: relaunch the **architect** once (🔁, the same model as Phase 3) with the lines as `note`, then back to Phase 4 with the revised plan; a second one → terminate without a commit (Phase 8) |
| `VERDICT: APPROVED` | Phase 6, with the PoCs as a regression net |
| `VERDICT: NEEDS FIX` | Phase 6: `## Proven breaks` go to the coder, `## Generated PoCs` to the verifier to confirm the fix |

In `full` the verdict is the aggregate of the consolidation.

### Phase 6 — Verification (final gate + correction loop)

Launch 1 verifier agent: `phase_prompt` with `target: "verifier"` (plus `stage` between the
stages of a staged plan), then `Agent` with the answered `subagent_type` (`nightqueue:verifier`),
`model` (the ✅ verifier's, step 6) and `prompt` verbatim.

The verifier runs **after** the QA and is the independent executor: it **reproduces** the
breaks proven by the QA (it runs the PoCs, it checks the static ones by grep). A PoC that
still fails = the break remains — neither the QA nor the coder validates its own work; the
verifier is the one who confirms.

**Gate and fix loop:** run `nightqueue run check 06` (the artifact gate, step 5.2).

| `run check 06` answers | Action |
| --- | --- |
| `VERDICT: PASSED` | Phase 7 (Phase 6.5 first unless the change is purely static) |
| `VERDICT: PASSED-STATIC` | checks ok, but the runtime path of the bug was not executed — do NOT treat it as PASSED: run Phase 6.5 covering the exact flow of the bug before Phase 7. If 6.5 is not viable (no emulator/environment), take to the user the explicit decision of committing without real execution — never decide on your own nor present it as verified |
| `VERDICT: FAILED` | a project check OR a QA PoC failing: relaunch the coder on the **same model** as Phase 4 passing the verifier's failures + the QA's `## Proven breaks` still open + the validated brief, then relaunch the verifier (the same `model` as Phase 6) |

- **Maximum of iterations**: **max 2 fix iterations**.
  If it still fails after the limit, **do not mask it**: skip Phase 7 (no commit),
  go to Phase 8 and report the remaining failures/breaks to the user.

Prompt of the coder in the fix: `phase_prompt` with `target: "coder-fix"` and `note` = what the
relaunch is about (the iteration and its failures, in one line). Relaunch the coder agent with the
answered `subagent_type`, `model` and `prompt` verbatim. After it returns, run
`nightqueue run check 04` (the artifact gate, step 5.2) before relaunching the verifier.

**Manual acceptance never runs against the operator's own home.** Any manual run of a
CLI/MCP command in this phase (and in Phase 6.5) goes through `nightqueue sandbox <cmd>`;
never export a home yourself. A temporary home alone would still repoint the operator's
live Claude settings at a directory about to be deleted — the operator's live Claude
settings must never be repointed. The operator's home, database, queue and Claude settings are never a
test fixture: nothing is created, cancelled or deleted there to prove that a command
works. A verification that can only run against the real home is reported as
`not verifiable here`, never performed.

These rules govern Phases 5 and 6.5 and every subagent launched from them:

**Real pull requests and nightqueue guards — hard rules.**

- **(a)** Never unset, stub, override or work around a nightqueue guard or its environment variables (`NIGHTQUEUE_JOB_ID`, `NIGHTQUEUE_JOB_HOME`, `NIGHTQUEUE_JOB_CLAUDE_DIR`, or any refusal nightqueue prints) — not in a child env, not by calling the internal function behind the refusing command, not by a 'simulation'. A refusal is the guard working. A verification that can only proceed by bypassing one stops and is reported as a gate (`## Requires user confirmation`), never worked around.
- **(b)** Any verification that creates, merges or closes a real pull request runs only in `~/Dev/nstest-demo` (remote `maykonVinicius/nstest-demo`) — never in the project's own repository or any other remote. If that checkout does not exist on this machine, no real pull request is created, merged or closed: the scenario is reported as a gate. The only publication ever made to the project's own origin is `nightqueue run publish`, which opens it through the `nightqueue run pr` path.

### Phase 6.5 — Runtime validation (real execution)

> A purely static change (typo, config, rename, types, pure logic already covered by a test) → does not execute: the
> Phase 6 checks are enough.

Runs when the change (fix OR feature) is **observable at runtime**
(UI/screen/flow/integration). Passing tsc/lint does NOT prove that the bug is gone nor that the
feature delivers what was asked — only executing proves it. A manual CLI/MCP run here obeys
the isolation rule of Phase 6: it goes through `nightqueue sandbox <cmd>`.
The method lives in the verifier's `## Proving by execution` and the format in
`prompts/runtime.md`; this phase launches the lane and applies the consequences below.

Launch **1 verifier agent**: `phase_prompt` with `target: "runtime"`, then `Agent` with the
answered `subagent_type` (`nightqueue:verifier`), `model` and `prompt` verbatim, with the header
`📱 RUNTIME · <what it is about to run>`.

Run `nightqueue run check 06.5` (the artifact gate, step 5.2). Only move on to Phase 7 with the
change confirmed at runtime; a field position/value or a control-flow merely ASSUMED does not pass.

| `run check 06.5` answers | Action |
| --- | --- |
| `VERDICT: CONFIRMED` | Phase 7 |
| `VERDICT: NOT-MET` or `GATE: runtime-not-met` | the Phase 6 coder loop (same limit) |
| `VERDICT: SYMPTOM-PERSISTS` + `DIFF-APPLIES: no` | the Phase 6 coder loop |
| `VERDICT: SYMPTOM-PERSISTS` + `DIFF-APPLIES: yes` | re-triage (below) |
| `GATE: runtime-no-attempt` | relaunch the runtime lane once (🔁) — the attempt is the lane's, never the coder's |
| `OPEN: <scenario> — to confirm` | ⚠️ on the 6.5 line (it forces the non-happy path of Phase 8) + mandatory open item; never back to the coder, never blocks Phase 7 |
| `NEEDS-DEVICE` | `run_outcome` with `status: "gate"` and `from_artifact: { file: "06-runtime.md", section: "## Runtime verdict" }` (the device script verbatim), then end the turn; the retry answer: a positive device verdict → Phase 7, a negative one → the Phase 6 coder loop |
| `VERDICT: UNAVAILABLE` | ⚠️ open item |

**Symptom persisting with the plan applied → the CAUSE is wrong (bug).** Hammering the coder
with the same plan is guaranteed waste. Relaunch the **triager** (🔁, the same model as
Phase 1) with the original diagnosis + the applied diff + the evidence of the execution (the
output that shows the symptom alive) and the instruction: "the confirmed cause was fixed and the
symptom persists — the diagnosis is incomplete; look for the underestimated path (order of
gates, preceding branch, race, data source)". With the new diagnosis, follow Phase 3 → 4 → 6 →
6.5. **At most 1 re-triage per pipeline** — if it persists again, terminate without a commit and
take the complete history to the user (Phase 8).

Case (a) needs its 2 proofs, case (b) its screenshot, case (c) the user's verdict, and cases
(d)/(d2) every line `MET` or `NOT MET / to confirm`.

### Phase 7 — Commit and PR

Only execute this phase if Phase 6 returned `## Verification: PASSED` **and** Phase
6.5 (when applicable) confirmed the change at runtime (a real payload confirmed in
case (a), a screenshot in case (b), the user's verdict in case (c), the complete acceptance
criteria in case (d)). If the verification failed after the fix iterations,
or if the runtime validation showed the bug persisting, **do not commit** — go
straight to Phase 8 and report.

The command below owns the mechanics — staging, the commit, the branch name, the push and
`gh pr create`. What stays yours is the judgment: which files, which message, which body.

1. **Decide what goes into the commit and write its message.**
   - The list is `## Modified files` of `<RUN_DIR>/04-implementation.md` plus the QA's
     real, hermetic tests that passed (including the bug's `*.regression.test.*`), each added with one
     `--extra <pathspec>`; a PoC lives under `<RUN_DIR>/poc/` and is never committed (`run publish` refuses `*.poc.*`, `*SCRATCH*`, `*-QA-*`). Leave out Phase 6.5's screenshots/artifacts and anything Step 2.7 of
     the verifier flags; `.claude/`, `tmp/` and lockfiles the command refuses on its own. Check
     `git status --short` first: a file that is neither in `## Modified files` nor a QA test is
     left out and recorded as an ⚠️ open item — never opened, never included in the dark; a file
     IN the scope that mixes pre-existing unrequested hunks (read from the verifier's
     diff-hygiene finding in `06-verification.md`) → ask the user BEFORE committing.
   - Follow the `commitTemplate` `run start` answered; when its `source` is `nightqueue` (the
     fallback), read `references/commit-template.md` first.
   - The message is yours: follow the convention the repository declares (`run start` answered it as `commitConvention`; the command prints it again as
     `CONVENTION: <what it found>`) or, with none declared, **Conventional Commits** with the
     `<type>` of Phase 0. Include a body when the task is not trivial, with a `Tests:` line
     listing only the checks that actually passed and the tracker's canonical ID (e.g. `Fixes
     PROJ-123`) when the task came from one. No `Co-Authored-By` trailer, agent, model or
     vendor name. Never write a `Refs:` trailer; `run publish` adds it.
   - Write the message with Write to `<RUN_DIR>/commit-message.txt`, which lives outside the
     worktree and is therefore never committed.

2. **Before any external action, show the user and wait for confirmation — only when
   `NIGHTQUEUE_JOB_ID` is unset:** the branch/worktree name, the complete commit message,
   `git diff --stat` and a status line (e.g. "QA ✅ · Verification ✅ · Runtime ✅"). Do not
   repeat the execution table here — it only reappears in the Phase 8 report if the run is not
   happy. Ask whether to go ahead with push + PR. Inside a queued job (`NIGHTQUEUE_JOB_ID`
   set) there is no operator to answer: go straight to step 3.

3. **Open the pull request** (one command, `nightqueue run publish`):
   - The template of the body is the `prTemplate` `run start` answered — the repository's own
     (`source: "repo"`, its `label`) or nightqueue's fallback — with its `headings` in order: never
     decide it yourself, and never Read the repository's template file. Assemble the title and the
     body per `references/pr-template.md` for THAT template, filling every section with this run's
     artifacts (`01-triage.md`, `03-plan.md`, `04-implementation.md`, and the last `## Round` of
     `05-qa.md` and `06-verification.md`). Invent nothing. In the PR description, identify the automation, when
     needed, by the nickname `nightqueue` — never an agent, model or vendor name, and no
     `Co-Authored-By` trailer.
   - **How it was validated goes inside the template's own test section.** Nightqueue template:
     the `## QA` section, one `###` subsection per method that really ran, one bullet per test, each backed by a non-empty file
     under `<RUN_DIR>/evidence/<method>-<name>.<ext>` (`<method>` ∈ `automated`, `api`,
     `browser`, `emulator`), then the `Not tested:` line. The evidence files are already there: the
     verifier wrote `automated-verification.md` (Phase 6) and the runtime lane wrote
     `api-*.log`, `browser-*.png|.log`, `emulator-*.png|.log` (Phase 6.5); when the QA
     produced `05-qa.md`, you may add `automated-qa.md` with Write from its last round's PoC excerpt. A
     method with no evidence file has no row. Repository template: its own test section, in its own
     format.
   - **No bare `#<number>` in the title or body** — GitHub cross-references an unrelated
     issue/PR and notifies it. The only `#<number>` allowed is a real issue of this repository in the `Fixes`/`Closes` line.
   - **No job ref (`J-24`), run slug, `Refs` line or `Opened by nightqueue` line in the body**
     — `nightqueue run publish` appends the traceability footer from the job row and refuses a
     body that carries one.
   - Write the body with Write to `<RUN_DIR>/pr-body.md` (outside the worktree, like the message
     of step 1) and run
     `nightqueue run publish --message-file <RUN_DIR>/commit-message.txt --body-file <RUN_DIR>/pr-body.md`,
     with one `--extra <pathspec>` per file outside the artifact's list. It checks the body BEFORE
     anything is committed, stages exactly the list — never a blind `git add -A` — and commits it
     ONCE (a retry answers `COMMITTED: <sha> (already committed)`), renames the branch to its final
     name (a job's `worktree-<slug>` becomes `<commit type>/<slug>`, the type read from the commit
     subject; an interactive `worktree-<type>+<slug>` becomes `<type>/<slug>`), pushes it and opens
     the pull request, answering `CONVENTION:`, `COMMITTED: <sha> (<n> files)`, `BRANCH:`,
     `PR: <url>` and `WORKTREE: <path>`. You never run `git add`, `git commit`, `git branch -m`,
     `git push` or `gh pr create` by hand.
   - `REFUSED: <path> (<reason>)` names a path the pipeline never commits (`.claude/`, `tmp/`, a
     lockfile, anything outside the worktree) and nothing was committed: `--extra` does not
     override it — drop that path (with `--files-from` a list of your own under `<RUN_DIR>` when
     it came from the artifact), call the command again and record the refusal as an ⚠️ open
     item of Phase 8.
   - `REJECTED: <reason>` and `MISSING: <what>` (one line per violation; the evidence one
     reads `MISSING: evidence for QA section <method>`) mean the body failed the check of the
     template in effect (a heading missing or out of order, a nightqueue heading against a
     repository template, the `## QA` subsections or the `Not tested:` line, a bare `#<number>`, a
     placeholder or a leftover `<...>` example) and nothing was pushed. Fix the body or the
     evidence and call the command again.
   - **The delivery is recorded by the command itself** — `nightqueue run publish` records
     `status: "done"` the moment the pull request exists; do NOT call `run_outcome` for it.
     The pull request URL is not a parameter. No pull request opened → no outcome recorded.
   - If `gh` is not installed or could not open the pull request, the command says so with the
     branch already pushed: inform it and leave the pull request to be opened by hand.

4. **Close the worktree immediately after the PR is created** (interactive `/resolve` only;
   inside a queued job skip this step: the runtime removes the worktree after the finish when
   it is clean and pushed). Interactive (or after confirming that the commit stayed local):
   call `ExitWorktree` with `action: "delete"`. The branch is already on the remote via push
   and the PR is open.
   - Inform the user of the PR link and warn: **"Worktree removed. The branch
     `<type>/<slug>` is on the remote — use `git checkout <type>/<slug>` or
     open a new worktree for new edits."**

5. **Cycle closing belongs to the runtime, not to this pipeline.** The pipeline ends at an
   open PR. Merge, delivery (e.g. an over-the-air update, a deploy), the issue tracker /
   crash reporter (e.g. Sentry, Linear, GitHub Issues) and the executive notice → they belong
   to the runtime's closing flow — even if the user asked for "push, PR, merge and
   tracker" in the same message. Never run those steps inline.

### Phase 8 — Report

Use the visual identity of the legend and the status icons throughout the report.

**Open the report with `nightqueue run report`, pasted verbatim** (Bash, inside the job; outside
one, with `--project <project> --slug <slug>`). It prints the `## 🗂️ Report — <slug>` header, then
the summary table per step — every step, `⏭️` only for a step the run legitimately skipped; then a
`Happy: yes|no — <first failing gate>` line decided by the fail-safe rule below from the run's
own records and, when the run is not happy, the complete execution table with the Time column the
runtime measured and its `**Total:**`. Your judgment may only turn a `Happy: yes` into not
happy — never the reverse — and then names the gate right below the pasted output.

**Decide the outcome before continuing — the fail-safe rule.** A **happy** run requires
POSITIVE confirmation of a clean success in EACH gate below, by the real verdict
returned by each phase (not by the icon of the summary table, which may not capture
nuance) — any deviation, a verdict different from the one listed, or a doubt about any
of them already makes the run **not happy**:

- Triager: verdict `PROCEED` (not `NO-CHANGE-NEEDED`, `NOT-REPRODUCIBLE`, `NEEDS-CLARIFICATION` nor `PROPOSE-ALTERNATIVE`).
- Architect: no `## Requires user confirmation` in the plan.
- QA-Guardian: verdict `APPROVED` (not `NEEDS FIX` nor `NEEDS DISCUSSION`).
- Verifier: verdict `## Verification: PASSED` (not `PASSED-STATIC` nor `FAILED`).
- 6.5 Runtime: acceptance criteria confirmed in real execution, OR a legitimate `⏭️`
  only by a purely static change — NEVER `⏭️` for a deferred/unviable 6.5
  (that case is always `⚠️`, even with an explicit decision by the user to commit
  without real execution).
- Execution record: no line with the status `🔁` (no loop re-run).
- Pipeline: `outcome` is `pr_opened` or `local_commit` (not `no_commit`) **and**
  no `gate_stop` was triggered.

**Golden rule:** when in doubt about any of the points above, treat it as
**not happy** — the complete detail is the safe behavior; hiding is the risk.

**Section `## Notice` — mandatory on BOTH paths.** It is the executive notice that
the operator reviews in the cockpit before closing the job; without it the job ends without a
notice and the closing gets stuck. The header is exactly `## Notice`, with no emoji and no
suffix, as a level-2 section of the report, and it does **not** count towards the cap of
~30 lines of the happy path. **Everything below — the character cap, the "no line may start
with `# `/`## `" rule and the writing/shape checks — governs a `done`/`failed` notice of THIS
phase only.** A gate notice (the pauses of Phase 1, the Confirmation pause and the
usage-coverage gate of Phase 3) is never written here: the runtime composes it from the
`run_outcome` record of the gate pause (step 5.3), with NO length cap.

- The body goes as direct text under the header. **Never** inside a code
  block (` ``` `): this text is read by machine.
- No line of the body may start with `# ` or `## ` (that would end the section).
- Plain, executive and **non-technical** language: no function, file, component or
  internal identifier name. Describe the effect for whoever uses it, not the code mechanism.
- The job does **not know** a ticket ID nor a form of delivery, and the v1 runtime has
  neither an issue tracker nor a delivery channel. **The notice must never contain a
  placeholder in double curly braces; when a value is unknown, omit the line.** The notice
  carries no delivery line: the PR link, the merge and the status are shown by the runtime
  from the job's own fields, so never write a `Record:` line nor repeat the PR URL. Never
  invent a PR number, a hash, a ticket ID nor a channel.
- **The cap is a writing constraint, not a target.** Target: **≤1000 characters**; hard
  cap: **1900 characters** — the runtime refuses the whole notice above it. The number is
  inherited from the runtime and is not re-derived here. Write it already fitting: trim to
  the maximum, do not write long expecting someone to cut it.
- **Above the cap the notice is REFUSED as a whole** — the writing does not truncate: the job
  is left without a notice, the open item shows up in the cockpit with the measured size and the
  closing is stuck until someone rewrites it by hand. Emitting above the cap does not deliver
  half a notice: it delivers nothing.
- **Count the characters of the body before emitting** (code points). Past 1000:
  cut CONTENT — a whole bullet, the least important conditional section, an
  example, a sentence of context — never half a sentence, never the outcome line,
  never a section header.
- **Trimming is never an excuse to hide.** Cutting content can NEVER remove a real
  open item ("Still open") nor the QA's result ("What the review found"): omitting an open item
  to make the message look clean is the most expensive mistake of this notice. If it does not fit with
  the mandatory sections, cut the description and the context of the other sections, never the mandatory ones.
- No line of the body may start with `QUEUE_` (a control line of the queue
  ends the section).
- "What the review found" is **mandatory when there was adversarial QA in the
  cycle** (the qa-guardian ran and returned a verdict): one line per break
  found and fixed, in user language, at most 3 bullets. With no QA
  in the cycle, omit the whole section.
- "Still open" is **mandatory when there is a real open item** (a ticketed
  follow-up, a part that depends on another system, a validation that was not possible
  to do), at most 3 bullets. Omitting an open item to make the message look clean is
  the most expensive mistake of this notice. With no open item, omit the whole section.
- **The open item can NEVER be read as a caveat about the delivery.** Whoever reads the
  notice needs to know, without interpreting, whether the reported problem was solved or
  not — a "Still open" right below "Fixed" is read as "so it did not really
  fix it". That is why the section header declares the relation with the
  delivery, and the choice between the two forms is DERIVED from the run's artifacts, not
  judged again here (never the dry label):
  - `Still open — a DIFFERENT problem, does not affect this fix:` when the
    open item comes out of `## Suggestions` of the last `## Round` of `05-qa.md` with the literal
    `dedicated ticket: yes` — a distinct defect (even if of a similar cause or
    discovered in this investigation), and each bullet says in one sentence that it will be
    handled separately.
  - `Still open IN THIS FIX:` when the open item comes out of a `not-covered`
    vector in the `## Symptom coverage` table of the `03-plan.md` or of a
    `NOT MET` line (with or without `/ to confirm`) in the acceptance gate of Phase
    6.5 — the open item limits what was delivered. In that case the notice header
    may NOT be of the `✅` family: use `⚠️ Partially fixed — <what was left out>`.
  There is only doubt when NO artifact brings those signals; when in doubt between the two,
  it is the second one: saying "solved" in excess is the expensive mistake.
- **The outcome is the first line, not a deduction.** The header answers
  on its own "was it solved or not, and does the user already have it?" and is also derived:
  `⚠️ Partially fixed — <what was left out>` is MANDATORY when the
  `03-plan.md` has a `not-covered` vector in `## Symptom coverage` or the acceptance
  gate of Phase 6.5 has a `NOT MET` line; with none of those signals use the
  `✅` family — `✅ Fixed and live` when the fix is in production at the
  moment of the notice, `✅ Fixed — goes out in the next release` when it is still going
  out, `✅ Delivered — <what changed>` when the task is not a bug fix. Do not
  let the reader infer the outcome from the support line down in the middle of the text.
- **A run terminated by `NO-CHANGE-NEEDED`.** Its header is `✅ Resolved — no code change needed`;
  the body is the conclusion with its evidence, in user language (why nothing in this repository
  has to change). The runtime appends the line telling the operator to close the job; the notice
  does NOT write it (it would reach the origins). Record it BEFORE printing the final text: `run_outcome`
  with `status: "no_change"` and `notice` = the whole body of this `## Notice` (step 5.3) — the
  job then ends `done` with no pull request, and that body is what its origins are told on close.
- **What the writing checks (a closed enum).** The writing refuses the notice as a
  whole — the same mechanism as the character cap, nothing is written and the closing
  is stuck until someone rewrites it in the cockpit — when:
  - the first line does not start with `✅ Fixed`, `✅ Delivered`, `⚠️ Partially fixed`, or
    (only for a run terminated by `NO-CHANGE-NEEDED`) `✅ Resolved`;
  - some line starts with `Still open` without being exactly
    `Still open — a DIFFERENT problem, does not affect this fix:` or
    `Still open IN THIS FIX:` (the dry label `Still open:` is
    refused);
  - the label is `Still open IN THIS FIX:` and the header is of the `✅` family;
  - the run's artifacts record a partial delivery and the header is of the `✅` family.
    That signal is read **in a table**, only in the cell of the `Status`/`Result`/
    `Verdict` column: `not-covered` in the `## Symptom coverage` table of the
    `03-plan.md`, or `NOT MET` (with or without `/ to confirm`) in the table of the acceptance
    gate of Phase 6.5. A gate written in prose is **not** read mechanically.
  - some line carries a placeholder in double curly braces instead of a real value — an
    unknown value is omitted, never templated.

Model (the fence below delimits the MODEL in this document; the real report emits
the content **without** a fence):

```
## Notice

✅ Fixed and live — <short symptom>

What was happening: <the symptom in user language, with the cause in one sentence>.

What was done: <the fix and how it is now, from the point of view of whoever uses it>.

What the review found: <only when there was adversarial QA; max 3 bullets>
• <break 1 in user language>

How it was validated: <what was in fact exercised>.

For support to guide whoever uses it: <how whoever uses it gets the fix; only when there is a real delivery channel, otherwise omit the whole line>

Still open — a DIFFERENT problem, does not affect this fix: <only when there is one; max 3 bullets>
• <open item 1 (TICKET when there is one), saying in one sentence that it will be handled separately>
```

In a task that is not a bug fix (feature, refactor), swap only the header
for `✅ Delivered — <what changed>` and adapt "What was happening" to
"What was missing"; the rest of the model is the same.
The header only ends with a `(<ID>)` when the task came from an issue tracker with a real ID; with no tracker — the v1 default — there is no parenthesis.

**Happy path — output ≤~30 lines.** Print only the `run report` output above and,
right after, the section **🎯 Objective met**: repeat the `Expected outcome` of Phase 0
and the concrete evidence that proves it was met (a without-fix/with-fix proof, a screenshot,
or the acceptance gate item by item), closing with the PR link (or "local commit,
no PR" when applicable). Re-read only what is necessary for those lines —
`01-triage.md` (## Validated brief, the Expected outcome field / ## Diagnosis if
a bug) and the verification
evidence in `06-verification.md`. Do NOT print the complete execution table
nor the 🔍 Diagnosis / QA / Verification / 🛡️ Prevention sections — the phase records
and the phase artifacts continue to exist and feed the telemetry below;
only the display to the user is cut. Print also the `🪞 Reflection:` line (Phase 9) and the
`## Notice` section (rules above); both are mandatory and do not enter the ~30-line cap.

**Non-happy path (any ⚠️, ❌, 🔁 or gate_stop) — keep today's complete
output:** the `run report` output already carries, right after the summary, the **complete
execution table** — one line per phase recorded, including loop
re-entries (🔁), with the Time column the runtime measured and its `**Total:**`.
Never compute a duration and never write a timestamp: the times belong to the runtime.

**Re-read the artifacts via Read when assembling the detail** — legitimate here because the
handoff already dropped their content from context: `01-triage.md` (## Diagnosis), `05-qa.md`
(breaks/risks/PoCs, last round), `06-verification.md` (checks/rounds) and `03-plan.md` when necessary.
A missing artifact (a pipeline ended at a gate before generating it) → record the ⚠️ open item
on the corresponding line, without trying to reconstruct the content nor failing the report.

After the tables, detail only what needs more than one line:

0. **🎯 Objective met**: repeat the `Expected outcome` of Phase 0 (the canonical
   criterion) and the concrete evidence that proves it was met — a without-fix/with-fix proof
   (bug), a screenshot, or the acceptance gate item by item (feature). If any item was left
   NOT MET, the report says so in the first line — never declare success
   against a criterion different from the canonical one.
1. **🔍 Diagnosis (bug only)**: reproduce the `## Diagnosis` section of the triager — a table with the hypotheses raised, how each one was validated (evidence of confirmation/refutation) and the confirmed root cause with the direct evidence that proves it. It makes explicit why the chosen cause is the right one and why the competing ones were discarded.
2. **QA — proven breaks**: what the qa-guardian broke (including regressions in callers and the result of the Robustness test, when applicable) and the PoCs it generated; the result of each item of the `## Validated risks` section, with severity 🔴🟡🟢. The fixes were made by the coder in the Phase 6 loop — reference the 🔁 iterations.
3. **Verification**: the checks + the QA's PoCs run and the final result; the number of fix iterations 🔁.
4. **🛡️ Prevention**: the QA's recommendations to avoid recurrence.
5. **Notice**: the `## Notice` section (rules above), already within the cap of 1900
   characters. Above that the writing refuses the whole notice and the job is left without a
   notice — cut content until it fits before emitting; automatic
   truncation no longer exists.

If the pipeline ended without a commit (a gate rejected or verification ❌ after the
limit of iterations), leave the corresponding line with ❌/⚠️ and explain the
block right below the table.

**A finding out of scope (a dedicated ticket to open) — mandatory on BOTH paths**, and it does
not count towards the ~30-line cap of the happy path: when the `## Suggestions` of `05-qa.md`'s last round has an
item with the literal `dedicated ticket: yes`, list it with `file:line` + 1 line of the risk —
the runtime's closing flow opens the ticket, never this pipeline (Phase 7, step 5). The same
paragraph collects `unconfirmed decisions:` of the QA's `Usage coverage:` line and the `NOT MET /
to confirm` lines of Phase 6.5. All of them become open items, reflected in `## Notice`'s "Still open" in user language (no file, no identifier).

On both paths, proceed to the Telemetry below.

**Telemetry (mandatory — one call per run, any outcome):** after
assembling the tables, persist the run via `pipeline_log` (MCP `nightqueue`). Send only what is
judgment: `task_type`, `outcome` (`pr_opened` | `local_commit` | `no_commit`; `investigated`/`queued` belong to the operator and are refused inside a job), `gate_stop` when
there was no delivery (which gate ended it: `triage` | `architect` | `qa` |
`verification` | `runtime` | `user`), and `phases` = one entry per
line of the complete table, in order (phase, status `ok`/`failed`/`skipped`, `retry: true` on
the 🔁 re-runs, note ≤ 1 line).

The rest of the record is the runtime's, not yours:
- `project` and `slug` come from the job's own row and are ignored here; send them only on a run
  started outside the queue.
- **No duration and no model is sent.** They are measured from the session stream and fill the
  record afterwards; a `duration_s` assembled here would only be overwritten.

A failure in `pipeline_log` does not block the report: record the ⚠️ open item and continue.

### Phase 9 — Reflect (every run that reaches Phase 8)

It runs ONCE per attempt, after `nightqueue run report` and the `pipeline_log` Telemetry (so the
run timeline has this attempt's rows), and BEFORE the final text. It runs on a delivered run, a
`no_commit` run and a terminated run (`run_terminate`, a `gate_stop`, an artifact `MISSING`, the
loop limits). It does NOT run at a gate pause (Phase 1, the Confirmation pause, the
usage-coverage gate, NEEDS-DEVICE): the resumed run reflects at its end.

Launch:
1. Print the header `🪞 REFLECTOR · reflecting over the run`.
2. `phase_prompt` with `target: "reflector"`.
3. `Agent` with the answered `subagent_type` (`nightqueue:reflector`) and `model`, and the
   `prompt` verbatim.

There is no artifact, no `nightqueue run check` and no `run_phase_done` for this phase; the
reflector applies the rubric and saves the run's lessons and memories on its own.

**Report line:** from the reflector's return, ONE line: `🪞 Reflection: L<id>, M<id>, …` with
every ref it returned, or `🪞 Reflection: none` when it saved nothing. If `phase_prompt` or
`Agent` failed, or the host answers `unknown` for `phase_prompt`:
`🪞 Reflection: not run — <reason>` - it is never retried and never blocks. The line sits
after the `run report` output and the 🎯 Objective block, ABOVE `## Notice`: `## Notice` stays
the LAST section of the final text. The line does not count towards the ~30-line cap, never
enters the Notice, and never turns a run `Happy`.
