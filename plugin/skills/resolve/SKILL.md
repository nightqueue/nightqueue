---
name: resolve
description: >-
  Orchestrates an autonomous team of agents to solve any coding task.
  Pipeline: interpretation → routing → triage-gate → exploration → architecture →
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
≤10-line subagent return, in every tier.

Measured 2026-09-21 over 14 jobs: a job's cost is ~77% cache-read (turns × context) and the orchestrator is 33% of it (~49 turns, 111k → 195k).
42% of what entered its context was its own Bash and 28% its own Reads — only 8% were subagent returns.

It works through five channels only:

- (a) the run's handoff files under `<RUN_DIR>`;
- (b) the plugin files it is told to read (`references/pr-template.md`, the qa-guardian paths of Phase 5);
- (c) the `nightshift` MCP tools;
- (d) the `Agent` tool;
- (e) the closed Bash list — `git rev-parse`, `git worktree`, `git status --short`, `git add`,
  `git commit` (never `--amend`), `git push` (never `--force`/`-f`/`--force-with-lease`/`--force-if-includes`/
  `--delete`/`-d`/`--mirror`/`--all`/`--prune`/`--receive-pack`/`--exec`, nor a `+`/`:` refspec),
  `git fetch` (never `--upload-pack`), `git branch --show-current`,
  `git diff --stat|--shortstat|--name-only|--name-status` (never `-p`/`-u`/`--patch`, a full diff, `show` or `log`),
  `gh pr view|list|status|checks|create` (never `gh pr diff`, `merge`, `edit` or `close`), and
  `nightshift run check|log|index-save|commit|pr` — each as the bare program name followed by its
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

**Phase header (mandatory):** when starting any phase that launches an
agent, print a line in this format first:

```
🔍 TRIAGER · <tier> · <what it is about to do in ≤1 line>
```

(swap the marker/title for the agent of that phase). On a loop re-run, append
🔁 at the end: `⚙️ CODER · complex · fixing the verifier's failures 🔁`.

**Status icons (use them in tables and verdicts):**

| Icon | Meaning |
| ----- | ----------- |
| ✅ | passed / done |
| ❌ | failed |
| ⏭️ | skipped (does not run in this tier) |
| 🔁 | re-run (fix loop) |
| ⚠️ | open item / attention / requires the user |
| ⏳ | in progress |

**Severity icons (QA/risks):** 🔴 high · 🟡 medium · 🟢 low.

The runtime waits for every subagent and background task of an unattended run; launch them in whichever way is cheapest and never end a turn to wait for one on purpose — parallel launches are N tool_use blocks in one message.

## Pipeline (execute in this exact order)

### Phase 0 — Interpretation, routing, worktree and tasks

0.1. **Memory preflight (before anything else in Phase 0).** Call `lesson_recall` (MCP
   `nightshift`) ONCE, with `project` = the current project, only to prove the server is
   reachable — the return is not used here; the per-phase `context_for_phase` (below) is the
   one that feeds the prompts. There is no memoryless mode.

   - **The tool does not exist in the host** → **STOP the run right here**: print one short
     line — `nightshift memory unavailable: run nightshift setup and retry` — and do not
     create the worktree, do not record anything, do not launch any subagent.
   - **The tool answers** — including an EMPTY return or a read error → continue. An empty
     memory is the normal state of a fresh install.
   - **The standing decisions are already in your context** — the `## Standing decisions`
     section of the `# Nightshift context` block injected at the start of the session carries
     them: EVERY accepted title of the project and of its org, org rows first, each already
     named `#<number>` or `<owner>#<number>`, followed by `## Standing decisions in detail`
     with the text of the 8 most recently updated. No preflight
     call fetches them; `decision_recall` stays the way to refine them by query (step 1).
     When the block is absent, ONE `decision_list` with `status: "accepted"` gives the titles.
     A `## Proposed (not binding)` section of the same block lists, by title only, the
     decisions still `proposed`: they bind nothing.
   - One call answers both levels: `decision_recall` with `project` returns the project's
     decisions AND its org's, org rows first, each carrying `scope` and `owner`.
   - **`decision_recall` failed or is unavailable while `lesson_recall` answered** (an older
     runtime) → continue WITHOUT a `## Standing decisions` section and record it as an open
     item of Phase 8. An empty return is different: it means the project has no accepted
     decision, and the section is simply omitted, with no open item.

0.5. **Run resume (right after the preflight, before interpreting).** If the
   job context brought a block ``RESUME CANDIDATE (slug `<slug>`)``, this run continues a
   previous one: the runtime already read `state.json` and decided it, so trust the block
   and re-validate nothing BEFORE re-interpreting the task.

   - Take every field from the block itself: `RUN_DIR:` is the run dir of this run (use it
     as it comes, do not derive another), `Branch:` and `Worktree:` are the ones to reuse
     (step 4), and execution STARTS at the phase in `Resume from phase:`. A field worth
     `none` means there is nothing to reuse there.
   - Skip every phase up to `Last completed phase:` and read its artifact in `RUN_DIR` via
     Read — do NOT re-triage, do NOT re-explore, do NOT re-architect.
   - **`From stage: qa-stage-b`** → Phase 5 re-enters straight at **Stage B (provers)**:
     read `<RUN_DIR>/05a-qa-analyst.md` via Read and move on to the consolidation normally,
     without relaunching the analyst. Any other value → run the whole of Phase 5, from Stage A.
   - **Read-fail fallback (fail-safe):** an artifact of a phase the block declares completed
     that is missing or unreadable via Read → ignore the block and **start clean** from step 1.
   - Safety invariant: the resume only happens on a retry of a job in a TERMINAL status
     (gate/failed/budget) — NEVER reuse the worktree of a job that is still running.
   - No candidate block in the context: proceed normally from step 1.

0.6. **Post-merge resume (the operator contradicts what this job already delivered).** Trigger:
   a resumed session where the operator's expected behavior contradicts `## Usage coverage` of
   `03-plan.md`, or the delivery is already merged with no such section. Protocol: (1)
   have the runtime lane measure the current behavior on main with real evidence — launch the
   Phase 6.5 lane (verifier, `Mode: RUNTIME`) with `ARTIFACT_PATH: <RUN_DIR>/00-main-measure.md`
   and the operator's scenarios; the table of (2) is built from its handoff file; (2) **show side by side**, one
   line per scenario: `<scenario> · today-on-main: <measured> · expected by the operator:
   <what he described> · divergence: yes|no`; (3) **ask** where the fix goes (`gh pr list
   --head <branch>` first: PR open → same branch; merged → a new linked PR or job); (4) until
   answered, forbidden to open a PR, create a branch/ticket or commit — refuting the operator's
   assumption is never permission to go ahead alone.

1. **Interpret the input inline** (no subagent — you already have the input in the
   context). Compress the user's request into a compact **brief** (≤ 30 lines). Extract and
   synthesize; never drag the raw input forward. Fixed format:

   ```
   ## Brief
   **Affected area:** [module / component / file(s) — specific]
   **Context:** [current state in 1-2 sentences]
   **Objective:** [what to change or create, 1 sentence]
   **Expected outcome:** [observable success criterion]
   **Type:** [bug/error | feature/refactor]
   **Bug account:** [phone/email/user ID from the ticket that reproduces the bug — or "not identified"]
   **Key evidence:** [max 5 lines of the stack trace — omit if feature]

   ## Standing decisions   [omit the whole section when the log has no accepted decision]
   - #<number> <title>                       [every accepted title, copied from the session block]
   - <owner>#<number> <title>                [a row whose `scope` is `org`]
   ### In full (the 8 closest to this Brief)
   - #<number> <title> — <the `decision` field in 1 line>

   ## Proposed (not binding)   [omit when the session block has no such section]
   - #<number> <title>                       [titles only, copied from the session block]
   ```

   **How `## Proposed (not binding)` is filled in.** Copy the titles of the section of the
   same name of the session block, in the order they came; nothing else feeds it. These
   decisions were proposed and nobody accepted them yet: they bind nothing, and a plan may
   go against them.

   **How `## Standing decisions` is filled in.** The source is the `## Standing decisions`
   section of the `# Nightshift context` block you already received at the start of the
   session: copy EVERY title from it, in the order it came. When that section is absent,
   take the titles from ONE `decision_list` (MCP `nightshift`) with `project` = the current
   project and `status: "accepted"`. The `### In full` part comes from ONE `decision_recall`
   (MCP `nightshift`) with `project` = the current project, `limit: 8` and
   `query` = the `**Affected area:**` plus the `**Objective:**` of the Brief. ONE call
   answers both levels: the project's own decisions and the decisions of its org, with the
   org rows FIRST — never call the tool a second time. Name each row the way it comes: a
   row whose `scope` is `project` is written `#<number>`, a row whose `scope` is `org` is
   written `<owner>#<number>` (`acme#3`), because two levels may hold the same number. Both
   sources only ever carry accepted decisions, so a `proposed`, a `superseded` or
   a `rejected` one can never reach this section. Keep the order received in both parts;
   a row marked `via: "fallback"` did not match the query and is dropped from the full part.
   No accepted title at all (or the tools failed, per step 0.1) → omit the section.

   The **raw input is never passed to Explore**. Only the triager (Phase 1), on bugs, may
   receive the raw error/stack trace block, the only agent that needs that detail to
   reproduce. The `**Type:**` field adjusts the behavior of Phase 1.

   **A request to "document":** when it includes documenting something AND there is a tracker
   issue involved (e.g. Linear, Sentry, GitHub Issues), confirm the destination — a comment on
   the tracker vs a file in the repository — before creating any `.md`.

   The `**Expected outcome:**` field is the CANONICAL criterion of the pipeline: the triager
   (Phase 1) and the architect (Phase 3) **refine** that target, never replace it. A phase that
   concludes the canonical target is wrong writes an Intent note / `## Requires user
   confirmation`, never a silent redefinition. Phase 6.5 and Phase 8 validate against it.

   The `**Bug account:**` field is critical for a bug about status/access/user data: extract
   the ticket's identifier — the TARGET of every payload validation (Phases 1 and 6.5).
   Validating against a generic test account or the emulator's own account may reproduce a
   different state and invert the diagnosis. With none in the ticket, record "not identified"
   and flag in triage that the cause depends on getting the real account.

   **A brief with numbered stages.** Each stage is a unit of the run and the order is binding:
   the Phase 3 plan is written per stage, Phase 4 implements stage by stage with the verifier
   between stages (a failing stage is fixed before the next starts), and the execution table
   and PR list the stages with their status. Stages never split the delivery: still one branch
   and ONE pull request.

2. **Classify the risk** of the task to choose the execution track — the risk the
   change carries, never the size of the diff.

   **An operator tier replaces this classification.** When the prompt of this run
   carries the line
   `Tier: <tier> (set by the operator - the pipeline may only raise it, with evidence, never lower it)`,
   that tier IS the tier of this run: do not reclassify it. The pipeline may **RAISE**
   it (trivial → simple → complex) only when Phase 0 or Phase 1 finds concrete evidence:
   - a stack trace;
   - a security, concurrency or money surface;
   - a schema, contract or tool change the brief did not name;
   - an ambiguous brief.
   A raise is written into the Brief, on its own line:
   `Tier raised: <from> -> <to>: <evidence>`.
   The pipeline **never lowers an operator tier**, and it may
   raise only on evidence found, never on the shape of the change. With no operator
   tier, classify by the criteria below.

   | Tier | Criteria | Track |
   | ----------- | --------------------------------------------------------- | ----------- |
   | **trivial** | the result is fully described by the brief and carries no behaviour decision — docs, README, copy, config values, CLI messages, table columns, a rename, a comment, a test-only change | Fast Lite |
   | **simple** | a local change with behaviour the brief defines, even when it adds or changes a condition, in one subsystem, with existing test patterns to follow | Fast |
   | **complex** | needs a design decision (new table, tool, flag, contract, schema, public API) · touches concurrency, security, money, auth or payments · crosses more than one subsystem · the brief needs a plan (stages) | Standard |

   Classify **before** launching any agent, from the brief alone. **When in doubt:**
   pick the tier the criteria say and write the doubt in the Brief — a doubt is not
   evidence, and the verifier's full test suite is the safety net of the `simple`
   tier. Declare it explicitly: `"Track: Fast Lite / Fast / Standard"`.

2.5. **Request critique (gate — mandatory on simple/complex; skip on trivial).**
   Before routing, answer inline in this fixed format (≤ 8 lines):

   ```
   ## Request critique
   **Core assumption:** [what the request assumes to be true]
   **What would refute it:** [concrete evidence that would invalidate the assumption]
   **XY check:** [is the request a self-prescribed solution to a bigger problem? which one? — or "no"]
   **Simpler alternative:** [cheaper path to the same Expected outcome — or "there is none"]
   **Verdict:** EXECUTE | PROPOSE-ALTERNATIVE | ASK
   ```

   - `EXECUTE` → follow the pipeline normally.
   - `PROPOSE-ALTERNATIVE` → stop the run with the gate block below, carrying the
     alternative and its trade-off in ≤ 5 lines.
   - `ASK` → stop the run with the gate block below, carrying ONE objective question.

   **The gate block is the only documented way to stop and wait.** Both non-`EXECUTE`
   verdicts end the run by printing it as the final text, outside any code fence (the
   runner ignores fenced lines), in exactly this order:

   ```
   ## Notice

   ## Requires user confirmation

   <the alternative and its trade-off, or the single objective question — ≤ 5 lines>

   Answer with: nightshift queue retry <id> --note "<your answer>"
   ```

   `<id>` is the number of this job, in the header of the run ("Unattended run, job #N").
   **The `## Notice` body IS the `## Requires user confirmation` block, VERBATIM** — the
   heading line itself plus every point of it (what was expected, the problem, the proposed
   solution, the expected result, the closing question) — followed by the answer line.
   Summarizing it, or pointing at the plan instead of repeating it ("see 03-plan.md") is
   FORBIDDEN: the runtime's classifier checks that the notice actually carries the question,
   and a notice that does not is recorded `failed`, not `gate`, with a fixed message —
   the whole point of this run then stopping is lost on the operator. `## Notice` has to be
   the LAST section of the final text, because the runtime reads the body of the last
   `## Notice` to the end of the text; the `## Requires user confirmation` line stays
   INSIDE that body on purpose — it is still the standalone heading that marks the job
   `gate`, wherever it sits in the text. A final text without this structure no longer stops
   at the gate: the runtime records the job as `failed`, because a gate nobody can read is
   worse than a failure. Unlike a done/failed notice (Phase 8), **a gate notice has no
   length cap.**

   **Before printing the gate block, record the outcome** — call `run_outcome` (MCP
   `nightshift`, step 5.3) with `status: "gate"` and `notice` = the whole body of `## Notice`
   (the block verbatim + the answer line). The runtime reads that record before it reads the
   stream, so a gate survives any paraphrase of the two headings.

   **A brief that depends on another job's pull request is not executable here.** When the
   request conditions the work on another job ("after job #N", "once PR #N is merged",
   "depends on job ..."), the verdict is `PROPOSE-ALTERNATIVE` — this case adds no new
   verdict — and the alternative is fixed. Print the gate block above with exactly this
   body under `## Requires user confirmation`, inside the `## Notice` section:

   ```
   This brief depends on another job's pull request. A job must be self-contained: fold this work into that job (as a stage) or make it independent. Nothing was changed.
   ```

   Stop there, before step 3 — nothing was created, since the worktree of step 4 does not
   exist yet — and record `gate_stop: critique` in the run telemetry (`pipeline_log`).

   Rules: a non-`EXECUTE` verdict requires concrete evidence — not a style
   opinion; do not stall the pipeline over preciousness. These count as evidence: lessons and
   memory injected into the session, the conversation history, and the paths `index_recall`
   answers for the Affected area (paths only — this gate never opens a repository file).
   Without evidence, the verdict is `EXECUTE`.
   Ambiguity in *reading* the request is NOT resolved here — that is Step 3.5
   of the architect. This gate only decides whether **this is worth executing**.
   **An empty repository is greenfield, never a reason to stop:** a repository with no
   tracked files (or with a single empty commit) whose request creates files is executable
   as it is — record `greenfield repository` in the Brief of step 1 and keep `EXECUTE`.
   What the repository is *for*, when two readings are plausible, is the architect's Step
   3.5, never this gate.

   After the user's answer (`PROPOSE-ALTERNATIVE`/`ASK`): update the
   affected fields of the Brief with the decision and proceed from step 3. If the gate avoided
   a wrong execution (the user accepted the alternative or reformulated the request),
   record it via `lesson_save`, building the payload with every field of the **Lesson payload**
   block of `Lessons per phase` — that is the kind of hit that should become a pattern.

   **In the `simple` tier the critique is ONE line**, not the block above:
   `## Request critique — <EXECUTE | PROPOSE-ALTERNATIVE | ASK>: <the core assumption,
   or the question/alternative in one sentence>`. A non-`EXECUTE` verdict stops the run
   with the same gate block, in either tier.

3. **Define the commit type** (Conventional Commits) that describes the task.
   That type names the branch/worktree and prefixes the Phase 7 commit:

   | type       | when to use                                |
   | ---------- | ------------------------------------------ |
   | `feat`     | new capability                             |
   | `fix`      | bug fix                                    |
   | `refactor` | refactoring without behavior change        |
   | `docs`     | documentation only                         |
   | `style`    | formatting/lint                            |
   | `build`    | dependencies/build                         |
   | `chore`    | configs, auxiliary tasks                   |
   | `test`     | tests                                      |

   Also define a short **kebab-case slug** describing the change
   (e.g. `login-google`, `fix-pagination`).

4. **Decide whether to create the exclusive worktree**:

   - Confirm you are inside a git repository: `git rev-parse --is-inside-work-tree`. If not,
     skip the worktree, warn the user and follow the pipeline in the current directory.
   - Detect the current branch: `git branch --show-current`.
   - If you are on `main`, create a separate worktree and branch for the task: `git fetch
     origin`, then call `EnterWorktree` with `name: "<type>/<slug>"` (base `fresh`, created
     from `origin/main`) — every later phase runs inside it. If `EnterWorktree` is unavailable
     in the host, create it with `git worktree add <path> -b <type>/<slug> origin/main` and
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
   - **On a valid resume (step 0.5)** with a `worktree` recorded in the state: if the directory
     still exists, REUSE it (do not call `EnterWorktree`). If gone, recreate it via
     `EnterWorktree` from the recorded `branch` (or base `fresh` if it no longer exists) — with
     no `EnterWorktree` in the host, use the same `git worktree add` fallback as above.

5. **Create the tasks** via TaskCreate, one per pipeline phase relevant to the chosen track.
   The `subject` of each task MANDATORILY follows the format `<phase>: <short summary>`, with
   `<phase>` being exactly one of: `triage`, `explore`, `architecture`, `implementation`, `qa`,
   `verification`, `runtime`, `commit` — the cockpit links task→phase by that prefix; a task
   without it does not show up in the log trail. Via TaskUpdate, mark each task `in_progress`
   when the phase starts and `completed` when it ends.

5.1. **Initialize the execution log** — a table you keep inline (not in a file), one line per
   agent launched, icon + title in the Agent column:

   ```
   | Step | Agent | Status | Summary (<1 line) | Time |
   ```

   Status: ✅ done · ❌ failed · 🔁 re-run · ⏳ in progress. For each agent launched (any phase,
   including loop re-entries): Summary is one sentence of what it delivered in that execution;
   Time stays empty while running — **Never time an agent yourself**, the runtime measures every
   phase from the session stream and Phase 8 fills this column from `nightshift run log`. If QA
   (Phase 5) rejects and the coder is relaunched (Phase 6 loop), add a **new "coder" line** —
   never overwrite the previous one, the history must show every round trip.

   This table feeds the "full execution table" of Phase 8 (shown only when the run is unhappy)
   and, line by line, the telemetry at the end of Phase 8 regardless of outcome. The pre-commit
   (Phase 7) shows only branch + commit + diff stat.

5.2. **File handoff (RUN_DIR + artifact gate).** Each subagent
   writes its COMPLETE output to an artifact and returns only a ≤10-line summary; the
   next phase reads the artifact via Read instead of receiving the content pasted in.

   `Project:` and `RUN_DIR:` come in the prompt — the runtime opened the run before this
   session started. Use that `RUN_DIR` as it comes (ALWAYS outside the worktree, NEVER
   inside it); the runtime created it before this session started. `<project>` is the `Project:` line, the same
   identifier used in `lesson_recall`/`pipeline_log`. The artifacts live OUTSIDE the worktree
   because Phase 7 (`ExitWorktree`) deletes the worktree BEFORE Phase 8 reads the artifacts.

   **Renaming the run is ONE declaration**, only when the kebab slug of this Phase 0 differs
   from the one in `RUN_DIR`: print ONCE, alone on a line, exactly `SLUG: <slug> TYPE: <type>`
   — `<slug>` is the kebab slug, `<type>` is the `**Type:**` of the Brief (step 1), `bug/error`
   or `feature/refactor`. The runtime renames the run directory, binds the slug to the job and
   records the type. The FIRST declaration wins: a second one is ignored, and a name another
   run of the project already took is refused. No `RUN_DIR:` line in the prompt → derive
   `RUN_DIR` from `<project>/<slug>` as before and print `QUEUE_SLUG: <slug>` once.

   Artifact map (author via Write → readers via Read):

   | Artifact | Author (Write) | Read by (Read) |
   | --- | --- | --- |
   | `01-triage.md` | 🔍 triager | 📐 architect (P3) |
   | `02-explore.md` | 🧭 explore | 📐 architect (P3) |
   | `03-plan.md` | 📐 architect | ⚙️ coder (P4), 🛡️ qa (P5), orchestrator (gate/pause) |
   | `04-implementation.md` | ⚙️ coder (every tier) | 🛡️ qa (P5), ✅ verifier (P6), coder-loop (P6) |
   | `05a-qa-analyst.md` | 🛡️ qa-guardian (ANALYST, complex only) | provers (P5-B) |
   | `05-qa.md` | 🛡️ qa-guardian (LITE) OR **orchestrator** (consolidation, complex) | ✅ verifier (P6), coder-loop (P6), Phase 8 |
   | `06-verification.md` | ✅ verifier (append per iteration, every tier; also `evidence/automated-verification.md`) | coder-loop (P6), Phase 8 |
   | `06-runtime.md` | 📱 runtime lane (✅ verifier, Mode: RUNTIME; also `evidence/api-*`, `browser-*`, `emulator-*`) | orchestrator (6.5 gate), Phase 7, Phase 8 |

   Each subagent receives its `ARTIFACT_PATH` (RUN_DIR + the phase's file) and the
   **handoff contract** at the TOP of the prompt (stable block), with the variable data
   (RUN_DIR, brief, repository, tier) at the END (stable-first). The contract:

   ```
   ## File handoff (contract — read first)
   ARTIFACT_PATH: <RUN_DIR>/<NN-phase>.md
   Read before acting (via Read): <source artifacts of this phase — or "none">
   Write the COMPLETE output (all your mandatory sections) to ARTIFACT_PATH via Write.
   Return to the orchestrator AT MOST 10 lines: verdict/status + the handoff file written + open items — never file contents, never a diff.
   Do NOT paste the complete sections in the response.
   ```

   **Artifact gate (apply after every phase that expects a Write):** run
   `nightshift run check <NN>` — one Bash call, from inside the job, with the phase number
   (`01`, `02`, `03`, `04`, `05a`, `05`, `06`, `06.5`). It answers `OK` (the artifact is there with the
   sections the next phase reads), `MISSING: <sections>` (absent or incomplete) or `GENERATED`
   (only `04`: the file list was derived from the worktree's own changes and written for you).
   `MISSING` → relaunch the subagent 1×; still `MISSING` → terminate the pipeline, record an
   ⚠️ open item / `gate_stop` and report it in Phase 8. Never check an artifact with `ls`, and
   never re-read it just to confirm that its sections are there — the command is the gate. It
   also covers the orchestrator's own artifacts (the consolidation of `05`).

   **Gate prohibitions (no exceptions):** the ≤10-line summary the subagent returns NEVER
   replaces the artifact — on `MISSING` the pasted content is IGNORED, never reused inline. The
   only exception to a `MISSING` artifact is `04`'s `GENERATED` answer above.

   **Do not re-read what is already in the context.** The orchestrator does NOT re-read (via
   Read) a file/artifact already read this session and still in context — except Phase 8, where
   the handoff already dropped the content. To merely confirm an artifact is there and complete,
   use `nightshift run check <NN>`, not `Read`.

5.3. **Record the run (enables the resume — step 0.5).** `<RUN_DIR>/state.json` belongs to the
   runtime. **Never write that file — not with Write, not with a temp file plus a rename,
   never.** The record is made with the `run_*` tools (MCP `nightshift`); inside a job none of
   them takes `project`/`slug` — the run is resolved from the job's own row.

   - **A phase completed.** When EACH phase completes SUCCESSFULLY (artifact written +
     artifact gate passed), call `run_phase_done` with `phase`, `artifact` = `<NN-phase>.md`
     and `verdict` = the verdict of the phase (`note` = anything else worth keeping). The
     `phase` is one of the 8 canonical names — `triage`, `explore`, `architecture`,
     `implementation`, `qa`, `verification`, `runtime`, `commit`. **NEVER** record a phase that
     ended in `gate_stop`.
   - **The fields of the run itself.** Call `run_set` ONCE for each field the moment it becomes
     known: `type` (`bug/error` | `feature/refactor`, the same one from the Brief of step 1),
     `tier`, and `branch` + `worktree` (step 4). Only the fields sent are touched.
   - **Termination on purpose.** When the pipeline terminates by the VERDICT of a phase that
     **was completed and recorded**, call `run_terminate` with that `phase` and the summarized
     verdict as `reason` — today only **Phase 1** with `NOT-REPRODUCIBLE`/`NEEDS-CLARIFICATION`.
     **NEVER** call it when the phase stopped halfway and was never recorded (artifact gate,
     `gate_stop`, timeout, gate 2.5, an insufficient brief or `## Requires user confirmation`).
   - **The outcome of the run.** Call `run_outcome` at exactly TWO points and nowhere else:
     **Phase 7**, once the pull request exists (`status: "done"`), and the **gate block**,
     immediately before printing it (`status: "gate"`, `notice` = the body of `## Notice`).
     `status` accepts ONLY `done` and `gate` — a failure, a cancellation and a timeout are read
     from how the process ended, never from a record. The pull request URL is not a parameter:
     the runtime writes it from what the session really published.
   - **Tolerant:** a `run_*` call that fails NEVER aborts the pipeline — record it as an open
     item of Phase 8 and continue to the next phase normally.
   - A `run_*`/`context_for_phase` tool or a `nightshift run` subcommand that answers `unknown`
     means the runtime is older than this plugin: record it as an open item of Phase 8 and
     continue — never hand-write `state.json` to compensate.

6. **Track routing** — the whole pipeline runs on Claude agents via `Agent` (every call MUST
   pass `model`); there is no external engine. The three tracks execute the SAME pipeline and
   differ ONLY in the routing below: this table is rendered once, and every phase reads its
   tier's column from here instead of restating it.

   | Routing | trivial | simple | complex |
   | ------------- | ------- | ------- | -------- |
   | Track | Fast Lite | Fast | Standard |
   | Phases that run | 0 · 4 · 6 · 7 · 8 | 0 · 1 (bug only) · 4 · 6 · 7 · 8 | every phase, 0 to 8 |
   | 🔍 triager       | —       | haiku (bug only) | sonnet   |
   | 🧭 Explore       | —       | —       | sonnet   |
   | 📐 architect     | —       | —       | opus     |
   | ⚙️ coder         | sonnet  | sonnet  | opus     |
   | 🛡️ qa-guardian   | —       | —       | sonnet   |
   | ✅ verifier      | haiku   | haiku   | sonnet   |
   | Verifier scope | tsc + lint + the tests of the files that were touched (no build, no full suite) | tsc + lint + the project's FULL test suite (no QA PoCs in this tier) | the project's real checks (typecheck, lint, build, tests) + the QA's PoCs |
   | QA methods of the PR | automated; + api for an API change; + emulator for a UI change in an Expo repo; + browser for a UI change in a web repo | automated; + api for an API change; + emulator for a UI change in an Expo repo; + browser for a UI change in a web repo | automated; + api for an API change; + emulator for a UI change in an Expo repo; + browser for a UI change in a web repo |
   | Max fix iterations | 1 | 2 | 2 |
   | Request critique (step 2.5) | skipped | mandatory | mandatory |
   | `<CWD>/CLAUDE.md` | not named to the coder | named to the coder when it exists | named to the coder (Phase 4) |
   | `index_recall` | no | yes, to locate the affected files | yes, in Phase 2 before the Explore |
   | `context_for_phase` for the coder | no | yes | yes |
   | `04-implementation.md` | written by the coder, gate `nightshift run check 04` | written by the coder, gate `nightshift run check 04` | written by the coder, gate `nightshift run check 04` |
   | Time target | under 5 minutes | under 15 minutes | none — the depth is the target |

   `—` = the agent does not run in that tier. `haiku (bug only)` = in `simple` the
   triager runs only when the request is a bug. In the fix loops, the relaunched coder
   keeps the `model` of the task's tier. Each phase below repeats the expected `model`
   in parentheses — in case of divergence, this table is the source of truth.
   `QA methods of the PR` is guidance for which methods to run, not a runtime check: each
   one becomes a `## QA` row only with its file under `<RUN_DIR>/evidence/` (Phase 7
   step 4), and the trivial tier runs no Phase 6.5, so there its non-automated methods
   apply only when that evidence exists.

   The **rationale** behind this table is in **Appendix A** (end of the file). Consult it when
   changing any routing line.

7. **Execution autonomy** — the pipeline runs autonomously. Every `Agent` call MUST pass
   `mode: "bypassPermissions"`, so subagents execute any command without asking for
   confirmation at each step — the isolation comes from the exclusive worktree of step 4.

   The pipeline only **stops to ask the user for input** at these points (each rule lives in
   full in its own phase — this is only the index):
   - **Phase 0 (gate 2.5):** verdict `PROPOSE-ALTERNATIVE` or `ASK`.
   - **Phase 1 (gate):** verdict `NOT-REPRODUCIBLE` or `NEEDS-CLARIFICATION`.
   - **Phase 3:** an insufficient brief, `## Requires user confirmation`, or the Type divergence
     valve with no confirmed `feature/refactor`.
   - **Phase 6.5 (native/device-gated capability):** the emulator/CI cannot reproduce it — not a
     pause point for case (a) (backend contract/response or state/control-flow).
   - **Phase 7:** confirmation before the push + PR — only when `NIGHTSHIFT_JOB_ID` is unset.

   Outside those points, never stop to confirm the execution of a command.

---

### Fast tracks — execute this block if the tier is "trivial" or "simple"

> One block for the two fast tracks: every value that changes with the tier — the `model`
> of each agent, the verifier's scope, the fix iterations, `<CWD>/CLAUDE.md`,
> `index_recall`, the time target — is read from **your tier's column in the Track routing
> table (step 6)**. The phases the row does not list are skipped; once done, go straight to
> Phase 7.

1. **Locate the affected files** — not yourself: hand the coder the `**Affected area:**` of
   the brief plus, in the tier whose row allows it, the PATHS `index_recall` (MCP `nightshift`)
   answered — paths only, never content. The coder locates the rest itself and lists what it
   touched in `04-implementation.md`.
   The coder receives the LIST of paths, never their content pasted inline: it has Read.

2. **Triager — only when `Type = bug/error` and the row gives the triager a `model`** (a
   feature/refactor, and the whole `trivial` tier, goes straight to step 3): run **Phase 1**
   exactly as written. The bug is reproduced before a line is changed;
   `NOT-REPRODUCIBLE`/`NEEDS-CLARIFICATION` terminates the run there.

3. **Launch 1 coder agent** (subagent_type="nightshift:coder", the `model` of the row):

   ```
   ## File handoff (contract — read first)
   ARTIFACT_PATH: <RUN_DIR>/04-implementation.md
   Read before acting (via Read): [only when the triager ran:] `<RUN_DIR>/01-triage.md` — ## Validated brief and the confirmed cause. [otherwise: none]
   Write the COMPLETE output (all your mandatory sections) to ARTIFACT_PATH via Write.
   Return to the orchestrator AT MOST 10 lines: verdict/status + the handoff file written + open items — never file contents, never a diff.
   Do NOT paste the complete sections in the response.

   Brief:
   [BRIEF FROM PHASE 0]

   Affected files (read them yourself, via Read):
   Affected area: [AFFECTED AREA]
   [PATHS FROM index_recall — omit in the tier whose row says no]

   [Include only when the row names CLAUDE.md and <CWD>/CLAUDE.md exists:]
   Project conventions (via Read): <CWD>/CLAUDE.md

   [Include only when the row calls it — paste the `block` of `context_for_phase` (target: "coder"), omitted when it came back empty:]
   [CONTEXT BLOCK]

   Apply the simplest possible change the brief defines. Do not introduce abstractions.
   [Include only in the simple tier:] Follow the test patterns already in the project and
   cover the new behaviour in the test file that already covers this area.

   Write `04-implementation.md` per your Required output (`## Modified files`, `## Done`,
   `## Left`, `## How it was tested`).

   Repository: [CWD PATH]
   Project: [PROJECT — the same identifier used in RUN_DIR]
   ```

3.5. Run `nightshift run check 04` (the artifact gate, step 5.2) — `GENERATED` and
   `MISSING: ## Modified files (no changed files)` are read as in Phase 4.

4. **Launch 1 verifier agent** (subagent_type="nightshift:verifier", the `model` of the row):

   ```
   ## File handoff (contract — read first)
   ARTIFACT_PATH: <RUN_DIR>/06-verification.md (append per iteration)
   Read before acting (via Read): <RUN_DIR>/04-implementation.md — ## Modified files
   Write the COMPLETE output (all your mandatory sections) to ARTIFACT_PATH via Write.
   Return to the orchestrator AT MOST 10 lines: verdict/status + the handoff file written + open items — never file contents, never a diff.
   Do NOT paste the complete sections in the response.

   Repository: [CWD PATH]
   Project: [PROJECT — the same identifier used in RUN_DIR]

   Tier: [trivial | simple]

   Run: [the `Verifier scope` cell of this tier's column in the Track routing table].
   Produce the verdict ## Verification: PASSED or ## Verification: FAILED.
   ```

   Then run `nightshift run check 06`.

5. **Fix loop — the `Max fix iterations` cell of the row is the limit**:
   - `PASSED` → go to Phase 7.
   - `FAILED` → relaunch the coder with the Phase 6 fix prompt (it reads
     `06-verification.md`), then the verifier.
   - Still failing after the last allowed iteration → **do not commit**, go to Phase 8 and
     report the failures.

The run is recorded by step 5.3 as in any other run, with the canonical phase names
(`triage` when the triager ran, `implementation`, `verification`, `commit`) — the phase
order never changes.

---

### Context per phase (applies to every phase with a subagent)

Before launching each subagent (Phases 1–6), call `context_for_phase` (MCP `nightshift`)
ONCE with `target` = the target phase (`triager` | `explore` | `architect` | `coder` | `qa`
| `verifier`) and `query` = 2–4 keywords from the brief. For `target: "explore"`, also pass
`repo_root` = the pipeline's CWD.

The call answers a `block` already formatted: `## Applicable lessons` (up to 4 preventions,
1 line each, starting with the real `[L<id>]`), `## Project memory` (up to 4 `[M<id>]
<key>: <value>` pairs) and, for the explore, `## Structural index`. Paste `block` into the
subagent's prompt exactly as it came, at the placeholder each phase's prompt already carries —
never rewrite a line of it. An empty `block` means there is nothing to inject, so the
placeholder simply disappears.

Nothing else is computed by hand: inside a job the server reads the run from the caller's own
job row: it takes the project from there and excludes by itself the lessons already
injected in earlier phases of this session, so the same lesson is not handed to two phases —
unless it is all this run has to give, in which case it comes back anyway. `project` and
`exclude_ids` are optional and exist for a call made outside a job.

A host that answers `unknown` for `context_for_phase` is a runtime older than this plugin:
launch the subagent without the block and record it as an open item of Phase 8.

#### Lesson payload

Every `lesson_save` call, at any of the points below, builds its payload from these fields —
one per line, in this order:

- `title` — one line, the pattern (what went wrong, as a class).
- `root_cause` — why it failed the first time.
- `solution` — what fixed it.
- `prevention` — the rule that avoids it next time; this is the line that gets injected into
  future runs.
- `attempts` — the real count of attempts, an integer; `1` means there is no lesson to save,
  so do not call the tool at all.
- `project` — the current project.
- `target` — the phase the lesson belongs to (`triager` | `architect` | `coder` | `qa` |
  `verifier`).

`title`, `root_cause`, `solution` and `prevention` are mandatory strings. A rejected call is
fixed ONCE by rebuilding the payload from this list — never retried as it was sent.

### Lesson-capture filter (shared rule for the four points below)

Four points in this pipeline relaunch an agent or end the run with no delivery because of a
finding: Phase 5's invalidated-assumption return to the architect, Phase 6's fix loop back to
the coder, Phase 6.5's symptom-persisting return to the triager, and the gate_stop points of
Phase 1 (triager refuses) and Phase 3 (architect refuses) — the last two counted together as a
single block. At each of those points, apply both conditions below before recording anything;
record only if both hold:

- **(a) Real correction loop:** an agent was actually relaunched (marked by the re-run icon) or
  the run ended at a gate with no delivery (`gate_stop`) — not a cosmetic tweak or a first-pass
  improvement.
- **(b) Cause generalizes:** the root cause would recur on another task in this project, not
  something isolated to this one ticket; the record describes a class of error, not a one-off.
  Positive example: "the plan assumed the session payload always includes a field the backend
  sometimes omits — defensive reads on optional backend fields become mandatory in this
  project." Negative example: "a typo on line 42 caught by the verifier" — an isolated slip, no
  class in other tasks, do not record.

One capture per loop, not one per individual finding inside it. A failed capture call never
blocks the run: record it as an open item in Phase 8 and continue, the same way a
`pipeline_log` failure is handled (step 5.3 / Phase 8 Telemetry).

### Phase 1 — Triage-Gate

> Tier scoping: the 🔍 triager row of the **Track routing** table (step 6) — a `—` there
> means this phase does not run, and in the fast tracks it is the block above that launches
> it, on the same artifact and the same gates.

It always runs, both for bug/error and for feature/refactor, validating before exploration,
architecture and implementation are spent.

The triage methodology (≥2 hypotheses, ban on hedging, REAL payload vs TS type, bug account +
discrimination gate, executable simulation, native SDK/crash reporter, symptom proof) lives in
`triager.md`. The skill's prompt only injects the data and demands the output format.

Prompt:

```
ARTIFACT_PATH: <RUN_DIR>/01-triage.md
Read before acting (via Read): none.
Return summary (≤10 lines, per the handoff contract of step 5.2): verdict + artifact path +
whether it emitted ## Intent note / ## Depth note + open items.

Follow your triage methodology. On a bug, validate the cause with the REAL data of the bug
account (not by reading/guessing/TS type) and prove the symptom before PROCEED.
Finish with: ## Verdict · ## Diagnosis (bug only, incl. Symptom proof) ·
## Validated brief · ## Out of scope · ## Request gaps ·
## Intent signals (bug only) · ## Open items.

Brief:
[BRIEF FROM PHASE 0]

[Include only if Type = bug/error:]
Raw evidence from the user:
[RAW ERROR BLOCK / STACK TRACE — on a crash from a crash reporter (e.g. Sentry), ≥3
events with stack + breadcrumbs + tags in_foreground/device/os/release]

Type: [bug/error | feature/refactor]

[Paste the `block` of `context_for_phase` (target: "triager") — omit when it came back empty:]
[CONTEXT BLOCK]

Repository: [CWD PATH]
Project: [PROJECT — the same identifier used in RUN_DIR]
```

Launch **1 triager agent** (subagent_type="nightshift:triager", `model`: `haiku` if the tier
is simple, `sonnet` if the tier is complex) — read mode, it does not edit files. It writes the
output to `01-triage.md`; run `nightshift run check 01` (the artifact gate, step 5.2)
before evaluating the verdict.

**Bug from a crash reporter:** when an MCP for it is available, pull ≥3 events (stack +
breadcrumbs + tags) before launching the triager and include them in the `Raw evidence` —
never only the ticket's title/culprit.

**Gate:** only advance to Phase 2 if the verdict is `PROCEED` **and** the `## Symptom proof`
shows the path that produces the reported symptom — without hedging and with no assumed
payload. A PROCEED that concludes the system behaves correctly, or that rests the cause on a
guess about data the logged-in emulator would allow confirming, is invalid: reject it and send
it back to the triager. NOT-REPRODUCIBLE or NEEDS-CLARIFICATION → **terminate the pipeline**
and take `## Open items` to the user. BEFORE terminating, record it (step 5.3):
`run_phase_done` with `phase: "triage"` **and** `run_terminate` with `phase: "triage"` and the
verdict as `reason`. Apply the lesson-capture filter above before terminating; if both
conditions hold, call `lesson_save` with `target: "triager"`, building the payload with every
field of **Lesson payload** above. This same gate_stop rule covers Phase 3's
insufficient-brief gate below, with `target: "architect"` there instead of `triager`.

If the triager's return signals that it emitted `## Intent note` or `## Depth note`, the
architect reads them straight from `01-triage.md` in Phase 3 — neither blocks the advance; the
architect decides whether to pause in their own Step 1.5.

### Phase 2 — Exploration

> Tier scoping: the 🧭 Explore row of the **Track routing** table (step 6) — a `—` there
> means this phase does not run.

**Structural index (recall — before launching the Explore):** call `index_recall`
(MCP `nightshift`) with `project` = the current project, `repo_root` = the pipeline's CWD
and `query` = 1-2 words from the Affected area. The return brings the already known map of the
project with real per-file freshness: `stale`/`missing` = revalidate; the rest are
fresh. An empty index → proceed exactly as before (graceful degradation).

**complex** — launch **1 explore agent** (subagent_type="nightshift:explore",
`model: "sonnet"`) — NEVER generic/general-purpose.

```
ARTIFACT_PATH: <RUN_DIR>/02-explore.md
Read before acting (via Read): none.
Return summary (≤10 lines, per the handoff contract of step 5.2): status + artifact path +
"index saved: N files" (or the reason for not having saved it) + open items.

Find the files related to: [AFFECTED AREA]
Task objective: [OBJECTIVE]

[Include only if index_recall returned files:]
Already known map of the project (index from earlier runs):
[LIST: path — responsibility (mark the ones with stale/missing as "REVALIDATE")]
Already known libs: [lib@version, ...]
Do NOT rediscover the fresh files of the map — trust them and complement only what
is missing for this area. Revalidate ONLY the ones marked REVALIDATE (they changed or
disappeared since the indexing). Fix the responsibilities that are wrong.

The index is persisted by the runtime from your artifact (`nightshift run index-save`); these two lines only name where it lands:
project: [PROJECT — the same identifier used in RUN_DIR]
repo_root: [CWD PATH]

[Paste the `block` of `context_for_phase` (target: "explore") — omit when it came back empty:]
[CONTEXT BLOCK]

Produce also the `## Access map` of the target code (max 3 hops, each consumer walked up to
a terminal) and the `unimplemented intent: <param> · governs <scope | filter |
auth | other>` lines for every parameter/field/flag read and not used in a decision. The cap of
30 files includes the files of the map.

Limit: at most 30 relevant files.
```

Wait for the Explore to finish. Run `nightshift run check 02` (the artifact gate, step 5.2)
before proceeding. Phase 3 reads the findings from `02-explore.md`.

Then persist the structural index from the artifact — the Explore no longer saves it:

```sh
nightshift run index-save <RUN_DIR>/02-explore.md --project <PROJECT> --repo-root <CWD>
```

It prints `index saved: N files, M libs`. A failure here NEVER blocks the run: record it as an
open item of Phase 8, the same as an empty index.

### Phase 3 — Architecture

> Tier scoping: the 📐 architect row of the **Track routing** table (step 6) — a `—` there
> means this phase does not run.

Launch **1 architect agent** (subagent_type="nightshift:architect", `model: "opus"`) —
complex only:

**What you may NOT inject into the architect's prompt (a prohibition without exception):** the
DESIGN is theirs. You inject context and a DELIVERY constraint — never a solution. FORBIDDEN in
any wording: pre-qualifying the fix level ("prefer to mitigate", "additive fix", "fix only path
X"); naming the mechanism/file/function/line where the solution must go ("reconcile it in the
listener that already exists, L162-170"); pre-disqualifying an approach by diff size or
regression surface ("prefer the SMALLEST diff"). The ONLY constraint you may pass is
**delivery** — the LIMIT of what may be delivered, never the HOW ("it must not touch native" is
delivery; "additive fix in the existing listener" is design in disguise) — on the `Delivery
constraints:` line. The architect decides the fix level in their own Step 1.5 and takes the
trade-off to the user via `## Requires user confirmation` when the risk deserves it.
The `## Standing decisions` section of the prompt below is NOT an exception to this
prohibition: it is binding context, in the same family as `Delivery constraints:`, and it
never names the mechanism, file or line where THIS task's solution goes.

```
ARTIFACT_PATH: <RUN_DIR>/03-plan.md
Read before acting (via Read):
- `<RUN_DIR>/01-triage.md` — ## Validated brief; on a bug, ## Diagnosis (the plan MUST
  attack this cause; the symptom proof is the baseline that Phase 6.5 re-runs
  without-fix vs with-fix); ## Intent note and ## Depth note when they exist.
- In the complex tier: `<RUN_DIR>/02-explore.md` — the Explore's findings.
Return summary (≤10 lines, per the handoff contract of step 5.2): status + artifact path +
whether it emitted ## Requires user confirmation + open items.

Type: [bug/error | feature/refactor]

In the complex tier, the `## Access map` of 02-explore.md is a mandatory input of axis 3 of
your Step 1.5. Declare `**Diff axis:**` and `**Always-gate class:**`, and produce
`## Usage coverage` when the conditions of your Step 5 match.

Delivery constraints (the limit of what may be delivered — NEVER design; omit the line if there is none):
[e.g. it must ship over-the-air; it must not touch native/build code]

Project conventions: read `<CWD>/CLAUDE.md` yourself via Read if it exists (the orchestrator no longer reads repository files).

[Paste the `block` of `context_for_phase` (target: "architect") — omit when it came back empty:]
[CONTEXT BLOCK]

[Include only if the Standing decisions section of the Brief exists:]
## Standing decisions
- #<number> <title>
### In full (the 8 closest to this Brief)
- #<number> <title> — <decision>
These are the standing constraints of the project and of its org, decided before this task
(a number written `<owner>#<number>` belongs to the org and binds every project of it).
They are binding context, never a proposed solution: a design that contradicts one either
follows the decision or takes the conflict to `## Requires user confirmation` naming its
number.

[Include only if the Proposed (not binding) section of the Brief exists:]
## Proposed (not binding)
- #<number> <title>
These decisions were proposed and nobody accepted them yet: they bind nothing, and a design
may go against them without a confirmation.

Repository: [CWD PATH]
Project: [PROJECT — the same identifier used in RUN_DIR]
```

**How to fill in `Type:`** — it holds whenever a phase needs the Type (3, 5, 6.5), not
only here. Walk this order and stop at the first one that resolves it:
1. the `**Type:**` of the Brief of Phase 0, if it is still in context (a clean run — you
   produced it yourself in step 1);
2. the `type` field of `<RUN_DIR>/state.json` (recorded with `run_set` in step 5.3) — the
   canonical source on the 0.5 resume, where the Brief is not in context;
3. structural derivation from `01-triage.md`, **bidirectional**: `## Diagnosis` present and
   filled in (it has `Confirmed root cause` / `Symptom proof`) → `bug/error`;
   `## Diagnosis` absent or empty **and** `## Validated brief` with no symptom/wrong
   behavior reported → `feature/refactor`. The triager only emits that section on a bug
   (`agents/triager.md:246`);
4. real doubt after 1-3 → write `bug/error`. The fail-safe **requires** the coverage section,
   it never waives it — the gate below has the **divergence valve** for when it got it wrong.
This same value decides the coverage gate below.

The architect produces `## Implementation plan` + `## Assumptions` + `## Pre-mortem` +
`## Identified risks` (mandatory in any type) and, when `Type = bug/error`, also `## Symptom
coverage` and, when the conditions of their Step 5 match (a bug touching 2+ scenarios of the
`## Access map`, or `**Always-gate class:** yes`), `## Usage coverage` (format and rules in
`architect.md`). Risks and assumptions feed the QA; the coverage sections enumerate every path
that produces the symptom.

**Gate:** run `nightshift run check 03` (the artifact gate, step 5.2 — it requires
`## Implementation plan`, `## Assumptions`, `## Pre-mortem` and `## Identified risks`).
`MISSING` after the 1× relaunch, or an insufficient brief, → inform the user and terminate; on
the insufficient-brief branch, apply the same gate_stop lesson-capture rule as Phase 1's
terminal gate, with `target: "architect"`. With the gate closed, read `03-plan.md` via Read.

**Proposed decision (right after that gate, before any other gate and before Phase 4):** if
`03-plan.md` contains a `## Proposed decision` block, call `decision_save` (MCP `nightshift`)
with `project` = the current project, the block's **Title**, **Context**, **Decision** and
**Consequences** fields and `status: "proposed"`; keep the returned `number` and carry it to
Phase 7 — saving it here (not at Phase 8) is what survives a run that later stops at a gate.
The runtime refuses a second proposal from the same job while the first is still `proposed`;
that refusal is not an error of the run, which keeps the number of the first save.
A failed `decision_save` NEVER blocks the run — it becomes an open item; the
block is optional and most plans do not have one:
no block → nothing is saved, nothing is recorded, and the run proceeds normally. A
`decision_save` whose `status` is missing or invalid is stored as `proposed` and answers
`status_defaulted: true`.

**A `needs_review` answer:** `decision_save` answers `status: "needs_review"` with `candidates`
when the proposal overlaps a standing or proposed decision, and nothing is saved. If the
block has an `**Unrelated to:**` line whose numbers cover EVERY candidate number, call
`decision_save` again ONCE with `unrelated` = those numbers. Otherwise do NOT save: record the
open item `Proposed decision not saved: it touches #a, #b (needs_review); the operator decides
it with decision_save outside the queue` for Phase 8, and the run proceeds. Never pass
`supersedes` from a run: superseding a decision is the operator's call.

**Coverage gate (bug):** also require `## Symptom coverage`, each vector marked `covered` or
`not-covered` **with a reason**, and `**How I enumerated:**` filled in with a **re-runnable**
command or criterion — a generic sentence with no command nor criterion fails just like a
missing section. Waive it ONLY when the `Type` is confirmed `feature/refactor`; doubt about the
Type still requires it. Missing, empty or "not applicable"/"n/a" on a bug → relaunch the
architect (🔁) once; if it persists, inform the user and terminate. A `not-covered` vector
**without** `## Requires user confirmation` is a broken contract: relaunch the architect (🔁).
With `## Requires user confirmation`, the flow is the **Confirmation pause** below.

**Type divergence valve:** if the plan brings, in place of the table, the line `**Type
mismatch:** <cited evidence>`, **do not relaunch in a loop and do not terminate**. Re-read the
`## Validated brief` of `01-triage.md` and decide: it confirmed `feature/refactor` → record the
correction of the Type (`run_set` with the corrected `type`) and move on to the coder without
the section; it did not confirm → ask the user ONE objective question ("is this a bug or a
feature/refactor?") and follow the answer. Terminating the pipeline over a Type divergence is
FORBIDDEN. That valve holds only for the `**Type mismatch:**` line with cited evidence — `not
applicable`/`n/a` still fails.

**Usage coverage gate (mechanical — holds in any Type):** with `03-plan.md` already read, run
the **literal** check below (a text search, not a judgment). Conditions 1 and 2 are
**anchored** (like 4): only what is inside the section `## Usage coverage` of `03-plan.md`
counts (from the heading to the next `## `), outside a code block, on the line indicated in
each condition. It fires if ANY of them is true:
1. a **scenario line** (starting with `- `) contains `changed=yes · source=pipeline`;
2. a line **starting with** `**Always-gate class:**` matches `**Always-gate class:** yes`;
3. an `unimplemented intent: <param> · governs <axis>` line of `02-explore.md` has `<axis>`
   **equal** to the plan's `**Diff axis:**` (one is enough, by axis, never by count);
4. the **request** (Brief of Phase 0, `## Usage scenarios` of the spec, or `01-triage.md`)
   contains a **scenario line** (starting with `- `, containing ` · `) whose value is exactly
   `to confirm`; a mention in prose does not count.

It fired and the plan does **not** contain `## Requires user confirmation` → relaunch the
architect (🔁) **once**, citing the exact line that fired and demanding the section. If it
persists, it is FORBIDDEN to move on to the coder and FORBIDDEN to terminate: **you build the
gate yourself** — print the gate block of step 2.5, with, under `## Requires user
confirmation` inside the `## Notice` body, the `## Usage coverage` of the plan (only the
`changed=yes` and `to confirm` lines) and by which condition fired, VERBATIM — never a
summary, never "see the plan" — followed by the answer line. Record the outcome
(`run_outcome`, `status: "gate"`, `notice` = that whole `## Notice` body) before printing it,
same as step 2.5. Pause by the same mechanism as the **Confirmation pause** below — there is
no second pause mechanism.

**Confirmation pause (intent/ambiguity):** if `03-plan.md` contains `## Requires user
confirmation`, **do not advance to the coder**. Stop the run with the gate block of step 2.5:
its `## Notice` body is the plan's `## Requires user confirmation` section VERBATIM — the
heading line itself plus every field (what the ticket expected · why it is a problem ·
proposed solution · expected result · question) — never summarized, never "see the plan" —
followed by the answer line, and record the outcome the same way. The user's answer arrives as
a retry: approved → move on to Phase 4 with the architect's plan; asked for adjustments →
relaunch the architect (🔁) with the decision; preferred the literal reading → relaunch the
architect (🔁) instructing the literal plan. Never write code before that confirmation.

### Phase 4 — Implementation

> Tier scoping: the ⚙️ coder row of the **Track routing** table (step 6) — in `trivial` and
> `simple` the coder is the one the fast-tracks block launches, with the prompt written
> there; this phase is the `complex` launch.

Launch 1 coder agent (subagent_type="nightshift:coder", `model: "opus"`).
The `coder.md` already requires the `## Modified files` section
and the completeness rule on a textual refactor — the prompt only injects the data:

```
ARTIFACT_PATH: <RUN_DIR>/04-implementation.md
Read before acting (via Read):
- `<RUN_DIR>/01-triage.md` — ## Validated brief.
- `<RUN_DIR>/03-plan.md` — the complete implementation plan (attack on the cause/criterion).
Return to the orchestrator AT MOST 10 lines: verdict/status + the handoff file written + open
items — never file contents, never a diff.

Apply the plan following the project's standards (CLAUDE.md). The simplest possible
solution. Write ARTIFACT_PATH per your Required output.

[Paste the `block` of `context_for_phase` (target: "coder") — omit when it came back empty:]
[CONTEXT BLOCK]

Repository: [CWD PATH]
Project: [PROJECT — the same identifier used in RUN_DIR]
```

Run `nightshift run check 04` (the artifact gate, step 5.2). `GENERATED` means the coder left
no file list and the runtime derived one from the worktree's own changes — accept and move on.
`MISSING: ## Modified files (no changed files)` means the worktree changed nothing: inform the
user that the implementation did not complete successfully and terminate.

**One coder lane per stage:** a brief/plan with numbered stages launches one coder per stage,
in order, never in parallel. Each prompt carries `Stage: <n> — <title>` and reads
`03-plan.md` (its stage) and `04-implementation.md` (what earlier lanes did, when it exists);
each lane appends its `### Stage <n>` block and rewrites the cumulative `## Modified files`.
Run `nightshift run check 04` after each lane, then the verifier between stages (the Phase 6
prompt and its fix loop): a failing stage is fixed before the next lane starts. After the last
stage, Phase 5 (QA) and the final Phase 6 verification run as usual.

**Parallel coders (batches):** if the implementation is split into concurrent batches, each
batch runs in an isolated worktree (`isolation: worktree`) — NEVER multiple coders in the same
working tree, and `git stash`/`checkout`/`reset` is forbidden with any batch active. The N
coders go **in a single message** (N `tool_use` in the same content block).

### Phase 5 — Adversarial QA (attack)

> Tier scoping: the 🛡️ qa-guardian row of the **Track routing** table (step 6) — a `—` there
> means this phase does not run and the track goes from the coder straight to the verifier.

The QA is **adversarial and fixes nothing**: it attacks the code on every front,
proves each break with an executable PoC and hands the breaks back to the coder. The fixes
happen in the Phase 6 loop, not here.

The QA reads the file list of `04-implementation.md` (## Modified files) and the
risks/assumptions/pre-mortem sections (and, on a bug, the symptom coverage one too)
of `03-plan.md` via Read. The `## Identified risks` section of the plan is **mandatory**; if
it is missing from `03-plan.md`, terminate and inform the user.

The methodology (fronts as attack vectors, coercion/truthiness, regression in
callers, Robustness test, an executable PoC per vector, the fallback-zero criterion on
a bug) lives in `qa-guardian.md`. The prompt only injects the data and selects the mode
by the tier. Every qa-guardian runs in **read/PoC mode, it does not edit source** (it only
creates PoC/test files).

**Before launching any qa-guardian, resolve the plugin root once:** `Glob` for
`skills/qa-guardian/SKILL.md` with `path` = the plugin root — the directory two levels above
this skill's base directory (never a Glob of the repository) — and take the directory that
CONTAINS `skills/` as `[PLUGIN_ROOT]`, then substitute it into the `QA_SKILL:` / `RISK_MATRIX:` / `FUZZ_TEMPLATE:`
lines of the three prompts below. If it does not resolve, omit those three lines
entirely — the agent keeps its own `Glob` fallback for that case.

**complex → two stages (analyst → parallel provers):** the analysis stays in a single
head — it groups breaks by root (4 symptoms with the same cause = 1 fix, not 4) and crosses
callers and interactions between files. The proof — the write→run→iterate loop of each PoC,
the serial bottleneck of the phase — is distributed across parallel provers. Stages A and B
below replace the single launch.

#### QA attack brief (shared by LITE and ANALYST)

The orchestrator pastes this brief into each prompt below, at the line that points here.

[Include only if 03-plan.md has ## Usage coverage:] Step 0 — BEFORE reading 03-plan.md: read
`<RUN_DIR>/04-implementation.md` (## Modified files) and the target code and write YOUR
## Access map (QA), in the format and vocabulary of agents/explore.md — a Map written after the
plan is a rubber stamp, not an enumeration.

What `03-plan.md` (once open) demands: ## Identified risks (MANDATORY to attack each one),
## Assumptions (attack each one with real evidence), ## Pre-mortem (validate each declared
mitigation AND attack each "accepted because" justification).

Pre-mortem mitigations — two attacks, both mandatory, on every item. (1) "mitigation:
adjustment already made in the plan": confirm it ACTUALLY exists in the diff — a mitigation
declared and not implemented is a break in ## Proven breaks. (2) "mitigation: accepted because <reason>":
attack the JUSTIFICATION with real evidence — it is the most fragile hypothesis of the plan
and today nobody checks it; "Accepted" never waives the attack. A false justification is a
live and unmitigated risk: what you prove goes to ## Proven breaks (or ## Break hypotheses in
ANALYST mode, when it depends on runtime); if you knock the justification down without proving
the failure, report it in ## Invalidated assumptions (back to the architect, not the coder).

[Include only if Type = bug/error:] ## Symptom coverage — TWO attacks, both
mandatory. (1) Is each vector marked `covered` ACTUALLY covered in the diff? Covered in the
plan and absent from the diff = a break. (2) Is the list COMPLETE? Do NOT trust it: re-run
the command declared in `**How I enumerated:**` and widen it on your own (writers of the
state, entry points, handlers/listeners, jobs, error paths). A path that
produces the ticket's symptom and is NOT in the table is an **omitted vector** = a break in
## Proven breaks, with the command used and `file:line`. Record it as the FIRST line of
## Validated risks:
`Symptom coverage: <N vectors of the plan's table> · <command/criterion of your
re-enumeration> · omitted: <file:line | none>` — the orchestrator audits that line.
`N vectors of the plan's table` = the total of lines of the ## Symptom coverage table of the
plan (`covered` + `not-covered`), NOT the number of vectors you confirmed in the diff:
a `not-covered` vector counts towards N even without being in the diff (by definition it is
not), and an omitted vector that YOU discovered does NOT enter N — it goes only in the
`omitted:` field.

[Include only if 03-plan.md has ## Usage coverage:] ## Usage coverage — with YOUR
## Access map (QA) of step 0 already written, only then read 02-explore.md and that section
of the plan and diff the two against it. Every prohibition of ## What to avoid and every
`source=pipeline` line is a hypothesis to attack: a named consumer (file:line + entry point) →
a proven break; without one → the label `the decision remains unconfirmed by the operator`,
and `HELD` is FORBIDDEN on those items. ## Access map (QA) is mandatory whenever this front
applies. Record it in ## Validated risks, right after the `Symptom coverage: ...` line when it
exists (otherwise as the first line):
`Usage coverage: <N lines of the plan> · <M own scenarios> · divergences: <file:line, ...|none> · unconfirmed decisions: <item, ...|none>`
`N lines of the plan` = the total of scenario lines (the ones starting with `- `) inside the
cut of the `## Usage coverage` section of `03-plan.md` — from the heading to the next `## `,
outside a code block; the `**Diff axis:**`, `**Always-gate class:**` and `**Scenarios
consulted:**` lines do NOT count. `M own scenarios` = the total of entry-point lines of the
`## Access map (QA)` of the QA report; the `partial:` line and the `unimplemented intent:`
lines do NOT count. The orchestrator audits that line with these same definitions.

Prompt of the LITE mode (the single-flow mode of `qa-guardian.md`; no tier routes here
today — `complex` always runs the two stages below):

```
ARTIFACT_PATH: <RUN_DIR>/05-qa.md
Read before acting (via Read):
- `<RUN_DIR>/04-implementation.md` — ## Modified files (the files to attack).
- `<RUN_DIR>/03-plan.md` (open it only AFTER step 0 of the Access map (QA), when it
  applies) — see the QA attack brief above, pasted here by the orchestrator.

Mode: LITE

Attack every pre-mortem mitigation per the QA attack brief above; prove the consequence with an
executable PoC and report it in ## Proven breaks.

Try to break each risk (execute the architect's steps or derive equivalents;
HELD/BROKE) and apply your adversarial methodology. Attack each
assumption too: if you find evidence that invalidates it, report it in ## Invalidated
assumptions — the plan was designed on top of it. On a bug, use the criterion of the
break from the user's point of view (fallback-zero in the bug's scenario = BROKE). Do NOT
fix anything — prove each break with an executable PoC and hand it back to the coder.

[Include only if Type = bug/error:]
MANDATORY (the bug's regression net): besides the break PoCs, create
<module>.regression.test.* encoding the EXACT SCENARIO of the bug (state of the bug
account + input of the symptom) asserting the correct behavior. It must PASS
against the fixed code; when feasible, prove that it would fail without the fix
(git stash → run → git stash pop). Without a scenario exercisable at runtime,
justify it explicitly in ## Generated PoCs.

Finish with ## Proven breaks, ## Validated risks, ## Generated PoCs and
## Invalidated assumptions (or "None").

[Paste the `block` of `context_for_phase` (target: "qa") — omit when it came back empty:]
[CONTEXT BLOCK]

Repository: [CWD PATH]
Project: [PROJECT — the same identifier used in RUN_DIR]
[Include the three lines only if [PLUGIN_ROOT] resolved:]
QA_SKILL: [PLUGIN_ROOT]/skills/qa-guardian/SKILL.md
RISK_MATRIX: [PLUGIN_ROOT]/skills/qa-guardian/references/risk-matrix.md
FUZZ_TEMPLATE: [PLUGIN_ROOT]/skills/qa-guardian/references/fuzz-template.md
```

**Stage A — Analyst (complex):** launch 1 qa-guardian
(subagent_type="nightshift:qa-guardian", `model: "sonnet"`), header
`🛡️ QA-GUARDIAN · complex · ANALYST · ...`:

```
ARTIFACT_PATH: <RUN_DIR>/05a-qa-analyst.md
Read before acting (via Read):
- `<RUN_DIR>/04-implementation.md` — ## Modified files (the files to attack).
- `<RUN_DIR>/03-plan.md` (open it only AFTER step 0 of the Access map (QA), when it
  applies) — see the QA attack brief above, pasted here by the orchestrator.

Mode: ANALYST

Attack every pre-mortem mitigation per the QA attack brief above: static proof (by reading)
goes to ## Proven breaks, runtime-dependent proof becomes a ## Break hypotheses item.

Apply the COMPLETE analytical attack (fronts, risks, assumptions, callers,
robustness), but follow the rules of the ANALYST Mode: do NOT write or run a runtime
PoC — each runtime break becomes a hypothesis in ## Break hypotheses
(grouped by probable root, with type, minimum context and an assigned PoC name).
A static break (proof by reading) is yours: report it in ## Proven breaks.
Discover and record the project's ## Test recipe — the provers are going to use it
without rediscovering the setup. On a bug, use the criterion of the break from the user's point of view
(fallback-zero in the bug's scenario = BROKE).

[Include only if Type = bug/error:]
MANDATORY: include in ## Break hypotheses an item with type=regression with the
EXACT SCENARIO of the bug (state of the bug account + input of the symptom) and the name
<module>.regression.test.* — the prover is going to build it to PASS against the
fixed code.

Finish with ## Proven breaks (static), ## Break hypotheses,
## Test recipe, ## Validated risks (analytical HELD or "→ hypothesis
H<n>") and ## Invalidated assumptions (or "None").

[Paste the `block` of `context_for_phase` (target: "qa") — omit when it came back empty:]
[CONTEXT BLOCK]

Repository: [CWD PATH]
Project: [PROJECT — the same identifier used in RUN_DIR]
[Include the three lines only if [PLUGIN_ROOT] resolved:]
QA_SKILL: [PLUGIN_ROOT]/skills/qa-guardian/SKILL.md
RISK_MATRIX: [PLUGIN_ROOT]/skills/qa-guardian/references/risk-matrix.md
FUZZ_TEMPLATE: [PLUGIN_ROOT]/skills/qa-guardian/references/fuzz-template.md
```

**Stage A gate:** run `nightshift run check 05a` (the artifact gate, step 5.2) over
`05a-qa-analyst.md`, which must carry `## Break hypotheses` and `## Test recipe` — on
`MISSING`, relaunch the analyst (🔁) once; if it persists, terminate and inform the user. Zero
runtime hypotheses → skip stage B and go straight to the consolidation.

As soon as that gate closes, call `run_set` with `qa_stage_a` = `{ "artifact":
"05a-qa-analyst.md", "verdict": "<the analyst's verdict>" }` — BEFORE launching stage B,
never by writing the file: this is what makes a resume skip the analyst if the provers die
halfway.

**Stage B — Provers (complex):** launch **N qa-guardian in parallel, all in a single message**
(subagent_type="nightshift:qa-guardian", `model: "sonnet"`, `mode: "bypassPermissions"`) — one
per root group of the hypotheses (never one per symptom). The `description` of each prover's Agent call MUST start with
`H<N> (group: <group>): ` — the cockpit identifies each prover lane and its verdict by that
prefix. Single header of the phase: `🛡️ QA-GUARDIAN · complex · PROVERS ×N · ...`. On a resume
whose block says `From stage: qa-stage-b`, `05a-qa-analyst.md` is already on disk: read it and
start from here, without rebuilding stage A. Prompt of each one:

```
Read before acting (via Read): `<RUN_DIR>/05a-qa-analyst.md` — stick to YOUR group
of hypotheses (## Break hypotheses: <IDs/label of the assigned group>) and to the ## Test
recipe. Write ONLY the assigned PoC files — with no .md artifact of your own.
Return summary (≤10 lines): verdict per hypothesis + open items.

Mode: PROVER

Group of hypotheses under your responsibility (read the detail in 05a-qa-analyst.md):
[IDs/LABEL OF THE SAME-ROOT GROUP ASSIGNED TO THIS PROVER]

Follow the rules of the PROVER Mode: write ONLY the PoC files with the assigned
names; never touch the git state (other provers run in this same
working tree). type=break → iterate until the PoC FAILS against the current code by the real
break; type=regression → iterate until it PASSES. NEVER report PROVEN without the output
of a real failure.

Finish with the verdict per hypothesis: PROVEN (PoC + output of the failure) |
REFUTED (evidence) | INCONCLUSIVE (what was missing).

Repository: [CWD PATH]
Project: [PROJECT — the same identifier used in RUN_DIR]
[Include the three lines only if [PLUGIN_ROOT] resolved:]
QA_SKILL: [PLUGIN_ROOT]/skills/qa-guardian/SKILL.md
RISK_MATRIX: [PLUGIN_ROOT]/skills/qa-guardian/references/risk-matrix.md
FUZZ_TEMPLATE: [PLUGIN_ROOT]/skills/qa-guardian/references/fuzz-template.md
```

**Consolidation (inline, by yourself — no subagent):** assemble the single report in the
contract that Phase 6 consumes:
- `## Proven breaks` = the analyst's static ones + the `PROVEN` hypotheses of the provers,
  keeping the analyst's grouping by root (same root = 1 item with its PoCs).
- `## Validated risks` = the analyst's, resolving each "→ hypothesis H<n>" to HELD (REFUTED)
  or BROKE (PROVEN).
- `## Generated PoCs` = the provers' files + a note that the without-fix proof via stash was
  delegated to the verifier.
- `## Invalidated assumptions` = the analyst's.
- `INCONCLUSIVE` **never becomes HELD**: relaunch ONE prover (🔁) for that hypothesis with
  what was missing; if it remains inconclusive, record an ⚠️ open item.
- Aggregate verdict: any proven break → `NEEDS FIX`; nothing proven and no open item →
  `APPROVED`.
- Record 5.1: one line per agent — `🛡️ QA-Guardian (analyst)`, `🛡️ QA-Guardian (prover
  <group>)`.

Write the consolidated report to `05-qa.md` via Write and run `nightshift run check 05`
(the artifact gate, step 5.2) — the artifact Phase 6 and Phase 8 re-read via Read.

**Validation of the coverage (only when `Type = bug/error` — LITE and complex):** confront
`05-qa.md`'s `Symptom coverage: ...` line (opening `## Validated risks`) with the `## Symptom
coverage` table of `03-plan.md`, using the QA attack brief's `N vectors of the plan's table` and
`omitted:` definitions above — N matches the table's total, the re-enumeration cites a concrete
method (not "I reviewed the plan"), `omitted:` is filled in. Any mismatch or missing line → the
QA skipped the attack: fail the phase and relaunch the QA (🔁).

**Validation of the usage coverage (when `03-plan.md` has `## Usage coverage` — LITE and
complex, also mandatory with `**Always-gate class:** yes`):** confront `05-qa.md`'s `##
Access map (QA)` and its `Usage coverage: ...` line with `## Usage coverage` of `03-plan.md`,
using the brief's `N` and `M` definitions above — `N` and `M` match, `divergences:` and
`unconfirmed decisions:` are filled in, and no `## What to avoid`/`source=pipeline` item shows
up as `HELD`. Any mismatch or missing piece → fail the phase and relaunch the QA (🔁), exactly
as with the coverage. `unconfirmed decisions:` different from `none` does **not** change the
verdict — it becomes a mandatory open item of Phase 8.

**Gate:** if the QA's verdict is `APPROVED` (in the complex tier, the aggregate of the
consolidation), go straight to Phase 6 with the PoCs as a regression net. If `NEEDS FIX`,
capture `## Proven breaks` + `## Generated PoCs` — they enter the Phase 6 loop: breaks to the
coder, PoCs to the verifier to confirm the fix.

**Invalidated assumption (back to the architect, not to the coder):** if `## Invalidated
assumptions` is not "None", the plan was designed on a false base — patching in the coder is
masking. Relaunch the **architect** (🔁, the same model as Phase 3) with the original plan +
the invalidated assumption(s) + the QA's evidence, obtain the revised plan and go back to
Phase 4 with it. **At most 1 return to the architect per pipeline** — if an assumption falls
again, terminate without a commit and take it to the user (Phase 8). Apply the lesson-capture
filter above before relaunching; if both conditions hold, call `lesson_save` with
`target: "architect"`, building the payload with every field of **Lesson payload** above.

### Phase 6 — Verification (final gate + correction loop)

Launch 1 verifier agent (subagent_type="nightshift:verifier", the `model` of the ✅ verifier
row of the **Track routing** table, step 6). The `verifier.md` already covers the detection
of checks, running the QA's PoCs (a PoC missing when there was a changed input/API =
FAILED; a PoC that fails = the break is still present) and the Runtime API Check (when the diff
uses a third-party API). The prompt only defines the scope:

```
## File handoff (contract — read first)
ARTIFACT_PATH: <RUN_DIR>/06-verification.md (append per iteration)
Read before acting (via Read):
- `<RUN_DIR>/05-qa.md` — ## Generated PoCs (run them all); items with Proof=reading of
  ## Proven breaks (confirm by grep that they are gone).
- `<RUN_DIR>/04-implementation.md` — ## Modified files (the files to verify).
Write the verdict and the detail to ARTIFACT_PATH via Write; if it already exists (a re-run 🔁),
read it and rewrite it preserving the previous iterations, appending
## Verification — iteration N at the end. Return to the orchestrator AT MOST 10 lines:
verdict/status + the handoff file written + open items — never file contents, never a diff.
Do NOT paste the complete detail.

Tier: [trivial | simple | complex]

Run: [the `Verifier scope` cell of this tier's column in the Track routing table].
Apply your methodology (the QA's PoCs and the Runtime API Check when they apply).
A PoC that fails = the break is still present → FAILED.
Final verdict: ## Verification: PASSED, ## Verification: PASSED-STATIC
(runtime of the bug not executed) or ## Verification: FAILED.

[Paste the `block` of `context_for_phase` (target: "verifier") — omit when it came back empty:]
[CONTEXT BLOCK]

Repository: [CWD PATH]
Project: [PROJECT — the same identifier used in RUN_DIR]
```

The verifier runs **after** the QA and is the independent executor: it **reproduces** the
breaks proven by the QA (it runs the PoCs, it checks the static ones by grep). A PoC that
still fails = the break remains — neither the QA nor the coder validates its own work; the
verifier is the one who confirms.

**Fix loop:**
- If the verdict is `## Verification: PASSED` → go on to Phase 7.
- If it is `## Verification: PASSED-STATIC` (checks ok, but the runtime path
  of the bug was not executed) → do NOT treat it as PASSED: run Phase 6.5 covering the
  exact flow of the bug before Phase 7. If 6.5 is not viable (no emulator/
  environment), take to the user the explicit decision of committing without real execution —
  never decide on your own nor present it as verified.
- If it is `## Verification: FAILED` (a project check OR a QA PoC failing) →
  relaunch the coder on the **same model** as Phase 4 passing the verifier's failures +
  the QA's `## Proven breaks` still open + the validated brief, then
  relaunch the verifier (the same `model` as Phase 6 for the tier). Apply the
  lesson-capture filter above before relaunching; if both conditions hold, call
  `lesson_save` with `target: "coder"`, building the payload with every field of
  **Lesson payload** above — the lesson is the implementation pattern that
  failed verification plus what the verifier confirmed passing.
- **Maximum of iterations**: the `Max fix iterations` cell of this tier's column in the
  **Track routing** table (step 6).
  If it still fails after the limit, **do not mask it**: skip Phase 7 (no commit),
  go to Phase 8 and report the remaining failures/breaks to the user.

Prompt of the coder in the fix:

```
## File handoff (contract — read first)
ARTIFACT_PATH: <RUN_DIR>/04-implementation.md
Read before acting (via Read):
- `<RUN_DIR>/06-verification.md` — the last iteration (## Verification — iteration N): the
  verifier's failures to fix.
- `<RUN_DIR>/05-qa.md` — ## Proven breaks still open (pending).
- `<RUN_DIR>/04-implementation.md` — ## Modified files so far.
Rewrite `## Modified files` in ARTIFACT_PATH with the complete cumulative list via Write.
Return to the orchestrator AT MOST 10 lines: verdict/status + the handoff file written + open
items — never file contents, never a diff. Do NOT paste the complete section.

The verification failed. Fix exactly the failures/breaks reported in the
06-verification.md and the pending ## Proven breaks of the 05-qa.md, without introducing
a regression and keeping the project's standards. Make the PoCs pass by fixing the
cause — never by altering or deleting the PoC.

Repository: [CWD PATH]
Project: [PROJECT — the same identifier used in RUN_DIR]
```

Relaunch the coder agent with the prompt above. After it returns, run
`nightshift run check 04` (the artifact gate, step 5.2) before relaunching the verifier.

**Manual acceptance never runs against the operator's own home.** Any manual run of a
CLI/MCP command in this phase (and in Phase 6.5) goes through `nightshift sandbox <cmd>`;
never export a home yourself. A temporary home alone would still repoint the operator's
live Claude settings at a directory about to be deleted — the operator's live Claude
settings must never be repointed. The operator's home, database, queue and Claude settings are never a
test fixture: nothing is created, cancelled or deleted there to prove that a command
works. A verification that can only run against the real home is reported as
`not verifiable here`, never performed.

These rules govern Phases 5 and 6.5 and every subagent launched from them:

**Real pull requests and nightshift guards — hard rules.**

- **(a)** Never unset, stub, override or work around a nightshift guard or its environment variables (`NIGHTSHIFT_JOB_ID`, `NIGHTSHIFT_JOB_HOME`, `NIGHTSHIFT_JOB_CLAUDE_DIR`, or any refusal nightshift prints) — not in a child env, not by calling the internal function behind the refusing command, not by a 'simulation'. A refusal is the guard working. A verification that can only proceed by bypassing one stops and is reported as a gate (`## Requires user confirmation`), never worked around.
- **(b)** Any verification that creates, merges or closes a real pull request runs only in `~/Dev/nstest-demo` (remote `maykonVinicius/nstest-demo`) — never in the project's own repository or any other remote. If that checkout does not exist on this machine, no real pull request is created, merged or closed: the scenario is reported as a gate. The only publication the pipeline ever makes to the project's own origin is Phase 7's `nightshift run pr`.

### Phase 6.5 — Runtime validation (real execution)

> Tier scoping: only the `complex` column of the **Track routing** table (step 6) lists this
> phase; the fast tracks go from the verifier to Phase 7. A purely static change (typo,
> config, rename, types, pure logic already covered by a test) → does not execute: the
> Phase 6 checks are enough.

Runs when the change (fix OR feature) is **observable at runtime**
(UI/screen/flow/integration). Passing tsc/lint does NOT prove that the bug is gone nor that the
feature delivers what was asked — only executing proves it. A manual CLI/MCP run here obeys
the isolation rule of Phase 6: it goes through `nightshift sandbox <cmd>`.
The methodology — the cases (a)–(d2), the `Result` table and the `unavailable due to the
environment` rule — lives in `verifier.md` (`Mode: RUNTIME`); this phase launches the lane and
reads its verdict.

Launch **1 verifier agent** (subagent_type="nightshift:verifier", the `model` of the ✅ verifier
row of the **Track routing** table, step 6), with the header
`📱 RUNTIME · complex · <what it is about to run>`:

```
## File handoff (contract — read first)
ARTIFACT_PATH: <RUN_DIR>/06-runtime.md
Read before acting (via Read): <RUN_DIR>/01-triage.md (## Validated brief, ## Diagnosis on a bug) ·
<RUN_DIR>/03-plan.md (## Usage coverage when present) · <RUN_DIR>/04-implementation.md · <RUN_DIR>/06-verification.md
Write the COMPLETE output (all your mandatory sections) to ARTIFACT_PATH via Write.
Return to the orchestrator AT MOST 10 lines: runtime verdict + the handoff file written + open
items — never file contents, never a diff.

Mode: RUNTIME
Type: [bug/error | feature/refactor]
Bug account: [the Brief's field]
Expected outcome: [the Brief's field]
Apply your Mode: RUNTIME cases (a)–(d2); every manual CLI/MCP run goes through `nightshift sandbox <cmd>`.

Repository: [CWD PATH]
Project: [PROJECT — the same identifier used in RUN_DIR]
```

Run `nightshift run check 06.5` (the artifact gate, step 5.2). The lane's verdict
(`## Runtime verdict`) decides: `CONFIRMED` → Phase 7; `NOT-MET` → the Phase 6 coder loop (same
limit); `SYMPTOM-PERSISTS` → the discrimination below; `NEEDS-DEVICE` → the pause of step 7
with the lane's device script, verbatim, in the gate block; `UNAVAILABLE` → ⚠️ open item per
the rules the lane followed (a scenario with no recorded attempt is not `to confirm`).

**Symptom persisting — diagnosis before a loop (bug):** if the execution shows
the bug STILL present, do NOT relaunch the coder automatically. First discriminate:

1. **Does the diff apply the plan?** Read the `Diff applies plan:` line of `06-runtime.md` —
   never the diff itself. `no` → relaunch the coder (the Phase 6 loop).
2. **The diff applies the plan AND the symptom persists → the CAUSE is wrong.** Hammering
   the coder with the same plan is guaranteed waste. Relaunch the **triager** (🔁,
   the same model as Phase 1) with the original diagnosis + the applied diff + the
   evidence of the execution (the output that shows the symptom alive) and the instruction:
   "the confirmed cause was fixed and the symptom persists — the diagnosis is
   incomplete; look for the underestimated path (order of gates, preceding branch,
   race, data source)". With the new diagnosis, follow Phase 3 → 4 → 6 → 6.5.
   **At most 1 re-triage per pipeline** — if it persists again, terminate without a commit and
   take the complete history to the user (Phase 8). Apply the lesson-capture filter above
   before relaunching; if both conditions hold, call `lesson_save` with `target: "triager"`,
   building the payload with every field of **Lesson payload** above — the lesson is why the
   confirmed cause was incomplete and which underestimated path the new diagnosis had to cover.

**Gate:** only move on to Phase 7 with the change confirmed at runtime — case (a)
the 2 proofs, case (b) the screenshot, case (c) the user's verdict, case (d) every item
of the acceptance criteria MET. A field position/value or a control-flow merely
ASSUMED does not pass. Acceptance criteria not met (feature) → back to the coder
(the Phase 6 loop, the same limit); a bug persisting → the discrimination flow above.
A bug with `## Usage coverage` (item (d2)): move on with every scenario line `MET` or
`NOT MET / to confirm` — the second case marks `⚠️` and becomes an open item, it never goes back to the
coder; `NOT MET` without `to confirm` blocks like any criterion not met.

### Phase 7 — Commit and PR

Only execute this phase if Phase 6 returned `## Verification: PASSED` **and** Phase
6.5 (when applicable) confirmed the change at runtime (a real payload confirmed in
case (a), a screenshot in case (b), the user's verdict in case (c), the complete acceptance
criteria in case (d)). If the verification failed after the fix iterations,
or if the runtime validation showed the bug persisting, **do not commit** — go
straight to Phase 8 and report.

The two commands below own the mechanics — staging, the commit, the branch name, the push and
`gh pr create`. What stays yours is the judgment: which files, which message, which body.

1. **Decide what goes into the commit and write its message.**
   - The list is `## Modified files` of `<RUN_DIR>/04-implementation.md` plus the QA's
     PoCs/tests that passed (including the bug's `*.regression.test.*`), each added with one
     `--extra <pathspec>`. Leave out Phase 6.5's screenshots/artifacts and anything Step 2.7 of
     the verifier flags; `.claude/`, `tmp/` and lockfiles the command refuses on its own. Check
     `git status --short` first: a file that is neither in `## Modified files` nor a QA PoC is
     left out and recorded as an ⚠️ open item — never opened, never included in the dark; a file
     IN the scope that mixes pre-existing unrequested hunks (read from the verifier's
     diff-hygiene finding in `06-verification.md`) → ask the user BEFORE committing.
   - The message is yours: follow the convention the repository declares (the command prints
     `CONVENTION: <what it found>`) or, with none declared, **Conventional Commits** with the
     `<type>` of Phase 0. Include a body when the task is not trivial, with a `Tests:` line
     listing only the checks that actually passed and the tracker's canonical ID (e.g. `Fixes
     PROJ-123`) when the task came from one. No `Co-Authored-By` trailer, agent, model or
     vendor name.
   - Write the message with Write to `<RUN_DIR>/commit-message.txt`, which lives outside the
     worktree and is therefore never committed.

2. **Create the commit:** `nightshift run commit --message-file <RUN_DIR>/commit-message.txt`,
   with one `--extra <pathspec>` per file outside the artifact's list. It stages exactly that
   list — never a blind `git add -A` — and answers `COMMITTED: <sha> (<n> files)`.
   `REFUSED: <path> (<reason>)` names a path the pipeline never commits (`.claude/`, `tmp/`, a
   lockfile, anything outside the worktree) and nothing was staged: `--extra` does not override
   it — drop that path, commit the rest and record the refusal as an ⚠️ open item of Phase 8.

3. **Before any external action, show the user and wait for confirmation — only when
   `NIGHTSHIFT_JOB_ID` is unset:** the branch/worktree name, the complete commit message,
   `git diff --stat` and a status line (e.g. "QA ✅ · Verification ✅ · Runtime ✅"). Do not
   repeat the execution table here — it only reappears in the Phase 8 report if the run is not
   happy. Ask whether to go ahead with push + PR. Inside a queued job (`NIGHTSHIFT_JOB_ID`
   set) there is no operator to answer: go straight to step 4.

4. **Open the pull request:**
   - Run `nightshift run pr --template` first. It answers `TEMPLATE: repo (<path>)` or
     `TEMPLATE: nightshift (fallback)` and `HEADINGS: <the headings in order>`, and records
     them as `prTemplate` in `state.json`: that is the template of the body — never decide it
     yourself. The repository template is the `HEADINGS:` line `nightshift run pr --template`
     answers — never Read the repository's template file. Assemble the title and the body per `references/pr-template.md` for THAT
     template, filling every section with this run's artifacts (`01-triage.md`, `03-plan.md`,
     `04-implementation.md`, `05-qa.md`, `06-verification.md`). Invent nothing. In the PR
     description, identify the automation, when needed, by the nickname `nightshift` — never
     an agent, model or vendor name, and no `Co-Authored-By` trailer.
   - **How it was validated goes inside the template's own test section.** Nightshift template:
     the `## QA` table, one row per method that really ran, each backed by a non-empty file
     under `<RUN_DIR>/evidence/<method>-<name>.<ext>` (`<method>` ∈ `automated`, `api`,
     `browser`, `emulator`), then the `Not tested:` line. The evidence files are already there: the
     verifier wrote `automated-verification.md` (Phase 6, every tier) and the runtime lane wrote
     `api-*.log`, `browser-*.png|.log`, `emulator-*.png|.log` (Phase 6.5); when the tier
     produced `05-qa.md`, you may add `automated-qa.md` with Write from its PoC excerpt. A
     method with no evidence file has no row. Repository template: its own test section, in its own
     format.
   - **A decision proposed by this run is NOT part of the PR body.** When Phase 3
     saved a `## Proposed decision` block, it is reported only in Phase 8, where the
     operator decides whether it deserves a ticket.
   - **No bare `#<number>` in the title or body** — GitHub cross-references an unrelated
     issue/PR and notifies it. Write a queue job id or decision number without the `#`
     (`job 24`, `decision 1`); the only `#<number>` allowed is a real issue of this
     repository in the `Fixes`/`Closes` line.
   - Write the body with Write to `<RUN_DIR>/pr-body.md` and run
     `nightshift run pr --body-file <RUN_DIR>/pr-body.md`. The command checks the body,
     renames the branch to its final name (the worktree creates it with the `worktree-` prefix
     and `+` in place of `/`), pushes it and opens the pull request, answering `BRANCH:`,
     `PR: <url>` and `WORKTREE: <path>`. You never run `git branch -m`, `git push` or
     `gh pr create` by hand.
   - `REJECTED: <reason>` and `MISSING: <what>` (one line per violation; the evidence one
     reads `MISSING: evidence for QA row <method>`) mean the body failed the check of the
     template in effect (a heading missing or out of order, a nightshift heading against a
     repository template, the `## QA` table or the `Not tested:` line, a bare `#<number>`, a
     placeholder or a leftover `<...>` example) and nothing was pushed. Fix the body or the
     evidence and call the command again.
   - **The delivery is recorded by the command itself** — `nightshift run pr` records
     `status: "done"` the moment the pull request exists; do NOT call `run_outcome` for it.
     The pull request URL is not a parameter. No pull request opened → no outcome recorded.
   - If `gh` is not installed or could not open the pull request, the command says so with the
     branch already pushed: inform it and leave the pull request to be opened by hand.

5. **Close the worktree immediately after the PR is created** (or after confirming
   that the commit stayed local): call `ExitWorktree` with `action: "delete"`. The branch is
   already on the remote via push and the PR is open.
   - Inform the user of the PR link and warn: **"Worktree removed. The branch
     `<type>/<slug>` is on the remote — use `git checkout <type>/<slug>` or
     open a new worktree for new edits."**

6. **Cycle closing belongs to the runtime, not to this pipeline.** The pipeline ends at an
   open PR. Merge, delivery (e.g. an over-the-air update, a deploy), the issue tracker /
   crash reporter (e.g. Sentry, Linear, GitHub Issues) and the executive notice → they belong
   to the runtime's closing flow — even if the user asked for "push, PR, merge and
   tracker" in the same message. Never run those steps inline.

### Phase 8 — Report

Use the visual identity of the legend and the status icons throughout the report.

**Fast tracks (trivial and simple)**: present it in 2–3 lines — what was
changed, the result of the verification (✅/❌) and the PR link (if opened).

**Standard Track (complex)**: ALWAYS start with the **summary table per step** —
it opens the report in any outcome. Steps that did not run in the tier → ⏭️.

```
## 🗂️ Report — <slug>

| Step | Agent | Status | Highlight |
|-------|--------|--------|----------|
| 1 Triage        | 🔍 Triager      | ✅ | <bug: confirmed root cause (number of hypotheses tested) / feature: validated requirements> |
| 2 Exploration   | 🧭 Explore      | ✅/⏭️ | <number of files / libs mapped> |
| 3 Architecture  | 📐 Architect    | ✅ | <approach + libs consulted; number of risks 🔴🟡🟢> |
| 4 Implementation| ⚙️ Coder        | ✅ | <summary of what it delivered> |
| 5 QA            | 🛡️ QA-Guardian  | ✅/⚠️ | <proven breaks, risks attacked, PoCs generated> |
| 6 Verification  | ✅ Verifier     | ✅/❌ | <checks; number of iterations 🔁> |
| 6.5 Runtime     | 📱 Runtime      | ✅/⏭️/⚠️ | <real payload confirmed (a) / screenshot of the emulator (b) / verdict on a physical device (c); ⏭️ only if a static change of the trivial tier — if PASSED-STATIC with 6.5 unviable, use ⚠️ (open item), never ⏭️> |
| 7 Commit/PR     | 🚀 Commit/PR    | ✅/⚠️ | <branch + PR link or pending state> |
```

**Lesson-capture audit line (mandatory on BOTH paths, printed right after this summary table; it
does not count towards the ~30-line cap of the happy path — the same exemption the `## Notice`
section already gets):** count every lesson successfully recorded during this run through the
correction-loop capture points (Phase 5, Phase 6's fix loop, Phase 6.5's symptom-persisting
loop, and the gate_stop block of Phase 1/Phase 3) and print one line: `Lessons saved: N
(targets: <unique target list>)` when N > 0, or
`Lessons saved: 0` when none were recorded. A failed capture call does not count towards N;
record it as a separate open item and keep the run going, exactly like a `pipeline_log` failure.

**Decide the outcome before continuing — the fail-safe rule.** A **happy** run requires
POSITIVE confirmation of a clean success in EACH gate below, by the real verdict
returned by each phase (not by the icon of the summary table, which may not capture
nuance) — any deviation, a verdict different from the one listed, or a doubt about any
of them already makes the run **not happy**:

- Triager: verdict `PROCEED` (not `NOT-REPRODUCIBLE` nor `NEEDS-CLARIFICATION`).
- Architect: no `## Requires user confirmation` in the plan.
- QA-Guardian: verdict `APPROVED` (not `NEEDS FIX` nor `NEEDS DISCUSSION`).
- Verifier: verdict `## Verification: PASSED` (not `PASSED-STATIC` nor `FAILED`).
- 6.5 Runtime: acceptance criteria confirmed in real execution, OR a legitimate `⏭️`
  only by the trivial tier/a purely static change — NEVER `⏭️` for a deferred/unviable 6.5
  (that case is always `⚠️`, even with an explicit decision by the user to commit
  without real execution).
- Record 5.1: no line with the status `🔁` (no loop re-run).
- Pipeline: `outcome` is `pr_opened` or `local_commit` (not `no_commit`) **and**
  no `gate_stop` was triggered.
- A gate of a phase that does not run in this tier counts as satisfied (it is `⏭️`, never a
  deviation): in `trivial`/`simple` that covers the triager when the request is not a bug,
  the architect, the QA and 6.5.

**Golden rule:** when in doubt about any of the points above, treat it as
**not happy** — the complete detail is the safe behavior; hiding is the risk.

**Section `## Notice` — mandatory on BOTH paths.** It is the executive notice that
the operator reviews in the cockpit before closing the job; without it the job ends without a
notice and the closing gets stuck. The header is exactly `## Notice`, with no emoji and no
suffix, as a level-2 section of the report, and it does **not** count towards the cap of
~30 lines of the happy path. **Everything below — the character cap, the "no line may start
with `# `/`## `" rule and the writing/shape checks — governs a `done`/`failed` notice of THIS
phase only.** A gate notice (step 2.5, the Confirmation pause and the usage-coverage gate of
Phase 3) is never written here: it follows its own rule above — the `## Requires user
confirmation` block verbatim, followed by the answer line, with NO length cap.

- The body goes as direct text under the header. **Never** inside a code
  block (` ``` `): this text is read by machine.
- No line of the body may start with `# ` or `## ` (that would end the section).
- Plain, executive and **non-technical** language: no function, file, component or
  internal identifier name. Describe the effect for whoever uses it, not the code mechanism.
- The job does **not know** a ticket ID nor a form of delivery, and the v1 runtime has
  neither an issue tracker nor a delivery channel. **The notice must never contain a
  placeholder in double curly braces; when a value is unknown, omit the line.** Name the
  PR by its real URL — Phase 7 already opened it and knows the link. The line has
  exactly three forms, one per value of `outcome` in the telemetry below: the real
  URL, closing the line with nothing after it (`pr_opened`); `local commit, no PR`
  when there is a commit but nothing was pushed (`local_commit`);
  `no delivery — stopped at the <gate> gate`, naming the gate recorded in
  `gate_stop`, when the run ended before any commit (`no_commit`). The last two never
  carry a URL. Never invent a PR number, a hash, a ticket ID nor a channel.
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
    open item comes out of `## Suggestions` of the `05-qa.md` with the literal
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
  moment of the notice, `✅ Fixed — ships in the next release` when it is still going to
  ship, `✅ Delivered — <what changed>` when the task is not a bug fix. Do not
  let the reader infer the outcome from the support line down in the middle of the text.
- **What the writing checks (a closed enum).** The writing refuses the notice as a
  whole — the same mechanism as the character cap, nothing is written and the closing
  is stuck until someone rewrites it in the cockpit — when:
  - the first line does not start with `✅ Fixed`, `✅ Delivered` or
    `⚠️ Partially fixed`;
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

Record: • PR <the real URL of the PR opened in Phase 7; or "local commit, no PR"; or "no delivery — stopped at the <gate> gate" when the run ended before any commit>
```

In a task that is not a bug fix (feature, refactor), swap only the header
for `✅ Delivered — <what changed>` and adapt "What was happening" to
"What was missing"; the rest of the model is the same.
The header only ends with a `(<ID>)` when the task came from an issue tracker with a real ID; with no tracker — the v1 default — there is no parenthesis.

**Happy path — output ≤~30 lines.** Print only the summary table above and,
right after, the section **🎯 Objective met**: repeat the `Expected outcome` of Phase 0
and the concrete evidence that proves it was met (a without-fix/with-fix proof, a screenshot,
or the acceptance gate item by item), closing with the PR link (or "local commit,
no PR" when applicable). Re-read only what is necessary for those lines —
`01-triage.md` (## Validated brief, the Expected outcome field / ## Diagnosis if
a bug) and the verification
evidence in `06-verification.md`. Do NOT print the complete execution table
nor the 🔍 Diagnosis / QA / Verification / 🛡️ Prevention sections — record 5.1
and the phase artifacts continue to exist and feed the telemetry below;
only the display to the user is cut. Print also the `## Notice` section and the
lesson-capture audit line (rules above); both are mandatory and do not enter the ~30-line cap.

**Non-happy path (any ⚠️, ❌, 🔁 or gate_stop) — keep today's complete
output:**

Right after the summary table, the lesson-capture audit line (rules above), followed by the
**complete execution table** (the record of step 5.1) — one line per agent launched, including
loop re-entries (🔁), with Time:

```
| Step | Agent | Status | Summary | Time |
|-------|--------|--------|--------|-------|
... one line per agent, in the order in which they ran ...

**Total:** ⏱️ the `total` line of `nightshift run log`
```

**The Time column is read, never computed.** Run `nightshift run log` (Bash, inside the job): it
prints one tab-separated `<phase>  <model>  <status>  <duration>` line per phase plus a final
`total  <duration>` line — paste each into its row and the total into the Total, leaving `-`
where the runtime measured no lane. `nightshift run log --json` answers the same rows with each
phase's `at` stamp, when the report needs order instead of durations.
Never compute a duration and never write a timestamp: the times belong to the runtime.

**Re-read the artifacts via Read when assembling the detail** — legitimate here because the
handoff already dropped their content from context: `01-triage.md` (## Diagnosis), `05-qa.md`
(breaks/risks/PoCs), `06-verification.md` (checks/iterations) and `03-plan.md` when necessary.
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
not count towards the ~30-line cap of the happy path: when `05-qa.md`'s `## Suggestions` has an
item with the literal `dedicated ticket: yes`, list it with `file:line` + 1 line of the risk —
the runtime's closing flow opens the ticket, never this pipeline (Phase 7, step 6). The same
paragraph collects `unconfirmed decisions:` of the QA's `Usage coverage:` line, the `NOT MET /
to confirm` lines of Phase 6.5 and, when Phase 3 saved a `## Proposed decision` block, one line
`` Proposed decision <number>: <title> — recorded as `proposed`; accept or reject it with `decision_update`. ``
(bare number, never `#<number>`) — this report is the ONLY place it surfaces. All of them become
open items, reflected in `## Notice`'s "Still open" in user language (no file, no identifier).

On both paths, proceed to the Telemetry below.

**Telemetry (mandatory — one call per run, any outcome):** after
assembling the tables, persist the run via `pipeline_log` (MCP `nightshift`). Send only what is
judgment: `task_type`, `outcome` (`pr_opened` | `local_commit` | `no_commit`), `gate_stop` when
there was no delivery (which gate ended it: `critique` | `triage` | `architect` | `qa` |
`verification` | `runtime` | `user`), `tier_operator` (the tier of the `Tier:` line of the
prompt, when the operator set one; omit it when there was none), and `phases` = one entry per
line of the complete table, in order (phase, status `ok`/`failed`/`skipped`, `retry: true` on
the 🔁 re-runs, note ≤ 1 line).

The rest of the record is the runtime's, not yours:
- `project` and `slug` come from the job's own row and are ignored here; send them only on a run
  started outside the queue.
- `tier` and `tier_raise_reason` are left out: the tier was recorded with `run_set` and the
  raise was read from the Brief's `Tier raised: <from> -> <to>: <evidence>` line.
- **No duration and no model is sent.** They are measured from the session stream and fill the
  record afterwards; a `duration_s` assembled here would only be overwritten.

A failure in `pipeline_log` does not block the report: record the ⚠️ open item and continue.

---

## Appendix A — Routing rationale

The routing table (Phase 0) is the source of truth. When changing it, decide the
Claude model by these 3 questions — the **dominant** capability of the phase wins:

| Question (YES →) | Model |
| ---------------- | ------ |
| Does it write/edit code or require deep design judgment? | `opus` (complex) / `sonnet` (simple) |
| Does it require reasoning or a broad search without generating code in bulk? | `sonnet` (exploration, QA, complex triage) |
| Is it a deterministic and cheap gate (it only runs commands and gives a verdict)? | `haiku` |

Exceptions: **QA** does not edit source (it only writes PoCs) and its core is adversarial
reasoning + regression analysis → `sonnet`, not `opus`. **Triager** does not edit,
but reproduces the bug by running/instrumenting the
code → `haiku` (simple) / `sonnet` (complex). Phases 0/7/8 run in the orchestrator
(the skill's model, without routing).

The `simple` tier has no architect and no qa-guardian: its safety net is the verifier's full
test suite, not a second reviewer — a tier is raised to `complex` on evidence found, never on
the shape of the change.
