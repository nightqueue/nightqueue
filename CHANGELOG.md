# Changelog

Every notable change of this project is recorded here, newest first. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the
versions follow [semantic versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

### Added

- An unattended job now runs isolated from the operator's own environment by default:
  `--strict-mcp-config --setting-sources project,local` plus a `--settings` payload
  carrying only this package's own hooks and a `claudeMdExcludes` entry that keeps the
  operator's own `CLAUDE.md` out of the ancestor walk. A job sees only this package's
  MCP server, plugin and hooks, plus the project's own settings - never the operator's
  own MCP servers, plugins, skills, agents or user hooks (measured on the real spawn
  path: 39 MCP servers, 95 skills, 20 agents and a ~114k first turn before; 1, 21, 11
  and ~68k after). `queue.inheritUserEnvironment: true`
  restores the old, unfenced behaviour; `nightshift doctor` reports which mode is in
  effect in a new `job environment` row.
- Each job records `baseline_ctx` (schema v13): the input, cache-read and
  cache-creation tokens the orchestrator's FIRST turn already carried before the run
  did anything of its own, from its first attempt that started fresh (a `--resume`
  attempt records none). Shown by
  `queue status <id>` (human, `--json`, MCP) the same way `bash_timeouts` is shown.
- The runtime configures the `claude` it spawns for a job:
  `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` plus `BASH_DEFAULT_TIMEOUT_MS` and
  `BASH_MAX_TIMEOUT_MS` from the new `queue.bashTimeoutS` (default
  `{ "default": 900, "max": 3600 }` seconds). A command that outlives its timeout now
  dies in the foreground with `Command timed out` instead of being moved to the
  background and killed later as an orphan task; an inherited value of these variables
  never leaks into the child. When a job's stream still shows a backgrounded task, its
  notice and the runner log get one warning line.
- Each job records `bash_timeouts`, `tasks_backgrounded` and `tasks_killed` (schema v12),
  shown by `queue status <id>` (human, `--json`, MCP) only when not zero, and
  `nightshift doctor` sums them over the last 20 finished jobs in a `host commands` row.
- A long-lived MCP server that runs a superseded runtime says so in the hints of
  `queue_status`, `queue_run` and `queue_add`.
- A detached runner is launched from the installed current runtime, never from the tree
  of the process that started it, and its registration names that tree.
- `npm test` runs with `--test-timeout=60000`, so a hung test fails in 60 s by name.

- `nightshift queue status <id>` (CLI, human and `--json`, and the MCP tool
  `queue_status` with `job_id`) now also answers `run_notice` whenever the
  run's own `## Notice` - read fresh from the log the row's `result.logPath`
  names - differs from the row's `notice_md`: both are shown, the row's under
  `notice` and the run's whole own, never truncated, under `run_notice`. A
  pure read: no write, no network, and a missing or unreadable log simply
  leaves the field absent.
- `nightshift queue run --watch --from HH:MM --until HH:MM` works the queue inside
  one local wall-clock window and exits at its end. `--from` defaults to now;
  `--until` is always the next occurrence of that time after `from`, so a window
  that crosses midnight (`--from 22:00 --until 04:00`) needs no special syntax.
  Before `from` the runner is alive and registered but claims nothing; at `until`
  it stops claiming, the job it is running finishes - the window never kills or
  shortens a job's own timeout - and the process exits `0` with its registration
  gone, printing `window closed at 04:00 - 3 jobs still pending` when jobs are
  left. `queue status` shows the window on the runner line
  (`watch every 60 s · window 22:00-04:00 · opens in 3h12` / `· closes in 5h40`),
  and `queue status --json` and the MCP `queue_status` carry
  `window: { from, until }` as ISO instants. The window is one-shot: nightshift
  starts no scheduler and no runner ever starts another runner, so a recurring
  overnight run is an OS-level job (`launchd`, `systemd`) the operator sets up.

- `queue.keepAwake` (`"auto"` default, `"always"`, `"off"`) keeps the machine from
  sleeping while a runner or one of its jobs is alive. On macOS every runner holds
  a `caffeinate` process bound to its own pid (`-s` on AC power under `auto`, `-i`
  under `always`), and an extra `-i` hold is bound to a job's child while it runs;
  each hold dies with what it was protecting. It is a no-op on every other
  platform, and a missing or failing `caffeinate` only warns once and never fails
  a runner or a job. The display can still sleep and nothing here wakes an
  already-sleeping machine, so a windowed night run needs the lid open (or an
  external display). `nightshift doctor` reports the mode, whether `caffeinate`
  was found, and this same limitation.

- `nightshift decision update <number> --status accepted|rejected|superseded
  [--superseded-by <n>]` settles a proposal a closed job left behind, or
  changes a decision's status by hand, from the terminal - the same write the
  MCP tool `decision_update` does. `superseded` requires `--superseded-by
  <n>`, the number of the decision that replaced it (of the same owner); any
  other status refuses that flag. It prints the updated decision the way
  `decision show` does.

- `nightshift queue session <id>` and the MCP tool `queue_session` open the
  `claude` session of a job's LAST attempt - `last_session_id` when the job
  recorded one, else its first `session_id` - and resume it with `claude
  --resume <session>` in the cwd the run itself used: the run's worktree while
  it is still on disk, or the project's checkout once it was released, flagged
  `worktree_released: true` (`(worktree released, using the checkout)` on the
  CLI). A `pending` or a `running` job is refused by name, and so is a job that
  never reached the agent. `--print` prints the equivalent `cd <cwd> && claude
  --resume <session>` line instead of running it, and `--json` prints
  `{ jobId, attempt, session, cwd, worktreeReleased, command }`; the MCP tool
  only ever reads and never resumes or executes anything itself.

- `nightshift decision export <number> [--dir <path>] [--force]` writes one
  decision as `<dir>/<nnnn>-<slug>.md` (default `docs/decisions/`), reading
  the database read-only like `show`. `nightshift decision import <file.md>
  [--status <status>] [--superseded-by <n>] [--supersedes <n,...>] [--unrelated
  <n,...>]` reads that shape - or a hand-written ADR of the same one - back
  through the same review `decision_save` uses, prints `imported as <label>`
  and stamps the pointer line into the file's header so a re-run of the same
  file is refused as already imported. The runtime itself never reads
  `docs/decisions/`; publishing an exported file stays a deliberate pull
  request of the operator.

- `decision_save` (and `decision import`) is gated against the owner's own
  log: before saving, the title, and for the MCP tool the title plus the
  decision text, is checked against every accepted and proposed decision of
  the same owner, lexical and semantic. An overlap saves nothing and answers
  `needs_review` with the candidates it found; the caller names every one of
  them on a second call - `supersedes <n,...>` for the ones the new decision
  replaces WHOLE (they become `superseded`, pointing at the new row, in the
  same transaction), `unrelated <n,...>` for the ones it leaves untouched.
  Inside a queue job `supersedes` is refused outright, a second proposal while
  the first is still `proposed` is refused too, and the saved row is stamped
  with the job's `job_id`.

- `nightshift queue close <id>...` and `nightshift queue close --merged` now
  settle the decisions the jobs they close proposed and never settled: on a
  TTY, without `--decisions`, each open proposal is asked `accept / reject /
  keep` (default `keep`); `--decisions accept|reject|keep` answers every one
  without asking, and no terminal or `--json` keeps them all `proposed`. Each
  settled proposal prints a `decision <label> <title>: accepted|rejected|kept
  (proposed)` line, and `--json` carries them under `decisions`. The MCP
  `queue_close` still only closes the job and leaves its proposals alone.

- `nightshift doctor` gains two more `warn` checks. `worktree <project>/<dir>
  left over` names, for every registered project with a `.claude/worktrees/`
  directory, each directory there that no open job still owns, with the exact
  command that cleans it (`git worktree remove`, `git worktree unlock && ...
  remove`, or `rm -rf` for one orphaned from git) - it never runs that command
  itself. `decision proposals` names every decision a queue job proposed and
  nobody settled before its job was closed, by number and job, with the hint
  to settle it with `decision_update` or, next time, with `nightshift queue
  close <id> --decisions accept|reject`.

- The block the `SessionStart` hook injects now carries the title of EVERY
  accepted decision of the project and of its org under `## Standing
  decisions`, not only the closest few, followed by `## Standing decisions in
  detail` with the text of the 8 most recently updated, and a `## Proposed
  (not binding)` section listing the title of every decision still `proposed`
  - nobody accepted it yet, so it binds nothing. Each section keeps to its own
  budget so the lessons always keep a floor, giving way to an omission line
  first.

- `nightshift run pr` checks the body against the target repository's own pull
  request template first. It resolves the run's checkout, then takes the first
  of `.github/PULL_REQUEST_TEMPLATE.md`, `.github/pull_request_template.md`,
  `docs/PR_TEMPLATE.md`, or a pull request section of `CONTRIBUTING.md` or
  `CLAUDE.md` (the first fenced markdown block of that section carrying
  headings); it prints `TEMPLATE:` and `HEADINGS:` and records them as a
  top-level `prTemplate` in `state.json`. A body must carry every heading of that
  template in its order, and no nightshift heading the template does not have.
  `nightshift run pr --template` prints and records the template alone, reads no
  body and pushes nothing, so Phase 7 reads it instead of deciding.

- `nightshift queue close <id>` and the MCP tool `queue_close` (twenty-four tools
  now): the operator's act that takes a delivered job from `done` to `closed`.
  Any other status is refused by name and nothing is written; `pr_url` is kept.
  A runner's witness can never close a job.

- A subagent of an unattended run is never killed for taking too long to answer.
  The runner starts the agent with `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0`, so
  the CLI waits for every background task the run still has open instead of
  killing one after ten minutes and exiting `0`; the job timeout and the idle
  timeout already bound the attempt. A new `PreToolUse` hook,
  `nightshift hook agent-foreground`, closes the other half: inside a job it
  rewrites every `Agent`/`Task` launch to `run_in_background: false`, whether the
  call asked for the background or simply left the field out. It normalises the
  call and never blocks it, and `setup` and `doctor` now register and check four
  hooks instead of three.

- A pending job a preflight block is holding back is now visible instead of
  looking like it is only waiting for a runner: `jobs.blocked_code` is an
  orthogonal column, the same shape `notice_md` already carries beside a
  `gate` - `status` answers where the job is, `blocked_code` answers why it
  is not moving right now. `queue status` breaks it out of the pending count
  (`pending=3 (1 blocked)`), shows `⛔ <code>: <message>` in the table and the
  detail view, and a new `--blocked` filter lists only those jobs; the field
  is exposed the same way on `queue_status` (MCP). `blocked` is not `gate`:
  a gate needs `queue_retry`, a block clears itself the moment the drain
  claims the job again, once the operator fixes the cause.

- `nightshift run` is the family the pipeline calls from inside a job, each
  subcommand acting on the run of the job it was called from: `run check <NN>`
  is the artifact gate of a phase (`OK`, `MISSING: <sections>`, or `GENERATED`
  when it derives `## Modified files` from the changes of the worktree),
  `run log` prints the phases of the run with the model and the duration the
  runtime measured, `run commit` stages exactly what the implementation listed
  and refuses `.claude/`, `tmp/`, any lockfile and any path outside the
  worktree, and `run pr` checks the body, renames the branch the worktree
  mangled, pushes it, opens the pull request and records the outcome. Naming
  another run from inside a job is refused; outside one, `--project` and
  `--slug` are required.

- Five MCP tools, twenty-three in all. `run_phase_done`, `run_terminate`,
  `run_outcome` and `run_set` record the run in `state.json` - the phase
  completed, a deliberate stop, how the run ended and the fields of the run
  itself - and `run_outcome` with `status: "done"` also closes the roadmap item
  the job came from. `context_for_phase` returns the whole context block of one
  pipeline phase, already formatted, so a subagent prompt is one call instead of
  two plus the bookkeeping of what the run had already been given.

- The block the `SessionStart` hook injects opens with `## Standing decisions`:
  the accepted decisions of the project and of its org, one line each, before
  the lessons and the memories it already carried.

- The mechanical work the pipeline's subagents used to describe in prose is now
  three runtime commands. `nightshift verify [--scope touched|full|+poc]
  [--files <list>]` detects the project's own checks from its lockfile and
  manifests and runs them in the fixed order typecheck, lint, build, test, poc,
  diff-hygiene, printing one `PASSED|FAILED|SKIPPED <check> <duration_s>s` line
  each and exiting `1` on any failure; a workspace root runs the checks its
  members declare, each in its own package, and a run that detected nothing says
  so instead of reading as a clean pass; it never installs anything, never writes
  the repository under test, and spawns every check against a throwaway
  `NIGHTSHIFT_HOME` and `CLAUDE_CONFIG_DIR`. `nightshift libs <name>...` prints
  the version of each lib actually installed, read from the lockfile, never the
  range. `nightshift run` also holds two steps the subagents call: `index-save <artifact>` persists the
  `## File map` and `## Third-party libraries` of an explore artifact into the
  project index, and `secrets-sweep --files <list>` reports the log calls whose
  arguments - or the lines those arguments are built from - may carry a secret.
  A job spawned by the queue now also carries an `Open pull requests matching
  this job:` block, looked up once before the spawn without blocking the dispatch
  of the other jobs, with a 5 s timeout and skipped entirely under
  `NIGHTSHIFT_NO_PR_CHECK=1`; the titles and branches it carries are framed as
  untrusted data and capped, since whoever opened the pull request wrote them. The six agent files stopped
  doing all of that by hand, so what they do is now testable from `test/`
  instead of only observable in a run. Documented in `docs/cli.md`.

- `nightshift sandbox <command> [args...]` runs one command, its arguments
  forwarded verbatim, against a throwaway `NIGHTSHIFT_HOME` and
  `CLAUDE_CONFIG_DIR` created before the spawn and removed once it exits,
  whatever the exit code - the same isolation `verify` gives its own checks,
  now available for a `nightshift` command typed by hand. Stdin, stdout,
  stderr, the rest of the environment and the current directory are inherited
  unchanged, and the exit code is the child's own.

- `nightshift queue repair <id>` re-derives the outcome of a job left in `gate`
  or `failed` from its own log and its own `state.json`, and writes the
  corrected row and witness. It is the way to settle a job that really opened a
  pull request but was recorded without it, with no hand-edited database. It
  never runs by itself: the automatic witness sweep is unchanged.

### Fixed

- A kill now fails the run only when it ended it. Before this fix, ANY
  `task_updated {status: "killed"}` in the last attempt made the job `failed`
  with a fixed notice ("...after its wait ceiling; the run did not finish;
  ...the hook did not run"), even when the run went on for hundreds more
  lines, opened its pull request and wrote its own `## Notice` - the real
  notice was then lost (job #49). A kill is now TERMINAL only when the CLI's
  own wait-ceiling line is in the log (it literally says "terminating"), or no
  `result` event carrying a `## Notice` ever followed it AND `state.json`
  recorded no outcome of its own; a terminal kill still fails exactly as
  before, with a notice that now says only what the stream proves: the
  ceiling clause only with the raw line, "; the run did not finish" only with
  no settling notice, and a hint naming what happened to the killed Bash call
  - launched with `run_in_background: true` (the hook should have caught it)
  or moved to the background by the Bash tool's own timeout, never both. A
  non-terminal kill classifies exactly as if it had never happened
  (`done`/`gate`/`failed` from the run's own record), with one line appended
  to whatever notice results, never replacing it: `⚠️ a command was
  abandoned mid-run: <command, truncated to 120 code points>`. `queue repair`
  and the runner's own retry decision follow the same terminal/non-terminal
  read.

- `nightshift queue status --follow` redraws the table over itself on a
  terminal instead of clearing the screen every tick, which piled one copy of
  the table per tick in the scrollback of iTerm2 and Terminal.app. The frame
  is cut to the width and the height of the terminal (`… +N more lines` when
  the queue is taller), the cursor is hidden while it runs and given back on
  the way out, and a resize redraws from the top. A pipe still only prints
  what changed.

- A run the CLI killed at its background-wait ceiling is no longer recorded as a
  job waiting for a decision. A stream carrying the ceiling line, or a task the
  CLI marked `killed`, is a failure whatever the final text says, whatever
  `state.json` recorded and even with a pull request in it, and the reason names
  the background task that was killed. The same pass tightened the gate itself: a
  clean exit with no pull request only waits for a human when the run actually
  asked for one - by recording the gate in `state.json` or by printing
  `## Requires user confirmation` - and is `failed` otherwise, keeping its final
  text as the reason. A last line like "Verifier running. Waiting for its
  verdict" used to be enough to buy a gate; it now reads as what it is, a run
  that stopped without delivering. Neither is a transient failure, so no attempt
  is spent re-running one, and `queue retry` takes both without `--note`.

- A retried job no longer degrades into a clean run. The job keeps the slug and
  the run directory of the attempt it is resuming, the resume is counted in
  `state.json` by the runtime, and the pipeline reads the phase to resume from
  out of the prompt instead of re-deriving a decision it could get wrong.

- The roadmap item of a job is closed by every path that lands its row on
  `done`, not only by the live finalize: `nightshift queue repair`, the
  reconciliation from the witness and `run_outcome` all go through the same
  closure in the store, so a job that really delivered never leaves its item
  queued.

- The pull request of a run is read from the `code_change_published` event the
  host emits when it publishes the change, ahead of the record in `state.json`
  and of the text of the session: a run whose final message contradicts what it
  really published is no longer recorded without its link. Only an event with
  `action: "created"` for the run's own repository counts, so a pull request the
  session opened for another repository - or an event about a pull request it
  closed - is never delivered as the run's own, whichever arrives last.

- `state.json` is written under a lock of its own run. The pipeline's record is
  now written from two processes - the MCP tools of the agent and the queue
  runner - and each read and its write are one critical section, so a phase the
  agent recorded is no longer erased by a fact the runner recorded at the same
  moment.

- `nightshift run commit` refuses `.claude/`, `tmp/` and the lockfiles whatever
  the case of the path: on a filesystem that resolves `.Claude/hook.js` to
  `.claude/hook.js`, the refusal used to be walked past by spelling the
  directory differently, in the list of the implementation and in `--extra`.

- The reason a gated job carries is the `## Notice` the run itself wrote, not
  the summary the pipeline had recorded in `<RUN_DIR>/state.json`: a gate was
  stored with a one-paragraph digest where the run had written the whole
  explanation, and the operator answered it without ever reading what it said.
  `state.json` keeps ruling the status (the pull request URL now comes first from the
  `code_change_published` event, see below), and its summary
  stays the fallback for a run that printed no `## Notice`, with the whole final
  text of the orchestrator as the last resort. `nightshift queue repair <id>`
  now also writes a correction that is only a notice - it compared the status
  and the pull request URL alone, answered that there was nothing to correct and
  dropped the text it had just re-derived - and it leaves the witness of the run
  untouched when nothing but the notice moved. `queue log` and the refusal of
  `queue retry` say where the whole notice is read (`nightshift queue status
  <id>`) when they had to cut it, which `queue status <id>` never does: a gate
  is answerable again from the detail of the job.

- `lesson_save` no longer loses a lesson because the payload arrived
  incomplete: `root_cause`, `solution` and `prevention` are now optional at the
  MCP boundary, and `attempts` below 2 is stored as `null` instead of refusing
  the call. A missing `title` still refuses, but with a one-line message
  naming it instead of the full contract dump. The answer now carries
  `incomplete`, the fields still empty, so a follow-up call with the same
  title fills in only what was missing. A lesson stored with an empty
  `prevention` has nothing to inject and is excluded from `lesson_recall`,
  though it stays visible in the CLI. `decision_save` mirrors the same
  tolerance: a missing or invalid `status` is stored as `proposed` instead of
  refusing the call, and the answer flags it with `status_defaulted: true`.

- A run that opened its pull request and then said one more sentence was
  recorded as `gate` with no pull request URL. Of the three signals the runtime
  read from the session, two already looked back over the whole run and the
  third read only the last message, so a delivery announced one message earlier
  was lost. All three now look back the same way. The pipeline also records the
  outcome of a run in `<RUN_DIR>/state.json`, and the runtime prefers that
  record over the text it reads from the session for the status and the pull
  request URL: a run that describes its own result in different words is no
  longer misread. The text stays the fallback.

- `nightshift queue status --follow` and the MCP `queue_status` tool read the
  queue on a read-only connection opened for that poll alone, instead of the one
  connection cached for the whole life of the process. A job another process
  finished, merged or repaired is rendered on the next poll, where a session
  could keep showing it as `running` for hours; and a follow with nothing to
  merge and nothing to repair no longer opens a write connection at all.

### Changed

- Inside a queued job, the `PreToolUse` hook now also sees `Bash`: a call with
  `run_in_background: true` is rewritten to the foreground with the same
  reason a subagent launch already got, and a command that scans from the
  filesystem root or the home (`find`, `grep -r`, `rg`, `ls -R` against `/`,
  `~` or `$HOME`) is denied, naming the worktree or the project checkout
  instead. The hook matcher is now `Agent|Task|Bash`, and a runtime kill of a
  Bash task quotes the command's first 120 characters and says the hook
  should have kept it in the foreground.

- Schema v11: `decisions.job_id` stamps the job that proposed a decision, read
  by the new `decision proposals` check of `nightshift doctor` and by the
  settlement `nightshift queue close` runs on every job it closes.

- A gate's notice is now the `## Requires user confirmation` block of the
  plan, verbatim, plus the answer line - no length cap, no summary. A notice
  missing that heading, or shorter than the plan's own confirmation section by
  more than 200 code points, is recorded `failed` with a fixed notice pointing
  at the plan instead of `gate`.

- `git worktree list --porcelain` is now read without `-z`, which git older
  than 2.36 refuses (`unknown switch 'z'`): the doctor's leftover-worktree
  check and the worktree lock lookup used to see every worktree as unreadable
  on a host like Ubuntu 22.04 (git 2.34), and now both parse the plain
  porcelain output they already supported.

- A job's worktree now lives as long as the job. `finalize` removes it once a
  `done` run is clean and its branch is pushed (or a pull request is
  recorded); `nightshift queue close`, `queue close --merged` and the MCP
  `queue_close` apply the same rule to every job they close. A dirty,
  unpushed or locked worktree is kept instead, and a `Worktree kept: <path> -
  <reason>` line is appended to the job's existing notice rather than
  replacing it.

- The nightshift pull request template is now only the fallback, and its shape
  changed: `## Report`, `## Cause`, `## Changes`, `## QA`, where `## QA` is a
  `| Method | Executed | Result |` table with one row per method that really ran
  (Automated, API, Browser, Android / iOS emulator or device, never `N/A`)
  followed by a `Not tested:` line, and every row needs a non-empty
  `<RUN_DIR>/evidence/<method>-*` file. Each violation prints its own
  `MISSING: <what>` or `REJECTED: <reason>` line, the evidence one reading
  `MISSING: evidence for QA row <method>`, and nothing is pushed. It replaces the
  `## Summary`/`## Changes`/`## QA` + `Verdict:`/`Proven:` shape: a body written
  by a plugin older than this runtime is now `MISSING`. The Track routing table
  gains a `QA methods of the PR` row mapping an API change to automated + api and
  a UI change to automated + emulator (Expo) or browser (web).

- Every read of the queue is a pure read. `queue status`, `queue status --follow`
  and the MCP `queue_status` render one view built from SELECTs and file reads
  alone: no network, no database write, no file write. The pull request of a job
  is shown as a derived `pr_state` (`merged` > `closed` > `conflicted` > `draft`
  > `unknown` > `open`) from a process-local cache that gh refreshes outside the
  frame, never stored; a merged pull request on a `done` job adds the suggestion
  `#<id> PR merged - close it with nightshift queue close <id>` instead of
  rewriting the row. Repair and prune are maintenance, owned by the runner cycle,
  the one-shot `queue status` and a 60 s timer of the MCP server; `--follow`
  never writes. The follow sleeps what is left of its interval and its footer
  states the cadence it achieved and what each part of the read cost; `--json`
  and `queue_status` carry `pr_state`, `suggestions` and `sections`. A follow
  behind a gh that takes 2 s to fail now redraws as often as one with the checks
  off (11 against 11 frames in 22 s, from 3 against 11).

- A runner now works one job at a time, in queue order; parallel jobs come only
  from starting more runners, and no start is refused because another runner is
  live.

- `queue.maxConcurrent` defaults to no ceiling. A positive integer still sets a
  hard ceiling across every runner of the home, and anything else means none.
  **Upgrade note:** a home whose `config.json` was written by an earlier version
  already carries `"maxConcurrent": 2` from the old default and keeps that
  ceiling; delete the key, or set it to `null`, to run without one.

- `queue run --max <n>` is now a budget for the run instead of a concurrency
  limit: the runner exits after n jobs that reached the agent, printing
  `queue: stopped - the --max budget of this run is spent`, for a drain, a
  `--watch` and a single foreground cycle alike. A job the preflight releases
  does not count. `--dry` reports it as `max`, next to `cap`, both `none` when
  unset.

- Advisory lines warn, without ever blocking a start, when the five-hour window
  of the provider is at 80% or more while runners are live
  (`5h window at NN% · K runners active — ...`) and when two or more runners
  work one repository (``N runners on `<project>` — ...``). They follow the
  runner lines of `queue status`, are echoed once by every start (on stderr
  by a foreground run under `--json`), and are answered as `advisories` by `queue status --json`,
  `queue_status` (also appended to its `hint`), `queue_run` and `queue_retry`.

- `state.json` is written by the runtime alone. Every key of the run - the
  phases, the termination, the outcome, the type, the tier and its raise, the
  branch, the worktree, the QA stage A marker and the resume count - goes
  through one writer, called by the `run_*` tools, by `nightshift run pr` and by
  the runner itself; the pipeline no longer writes the file, no longer stamps a
  time and no longer counts its own resumes. An `updatedAt` an older plugin
  hand-writes is overwritten by the runtime's clock instead of being trusted.

- The run comes named in the prompt. The runner opens the run directory before
  spawning anything and hands `Project:` and `RUN_DIR:` over, plus a
  `RESUME CANDIDATE` block carrying the branch, the worktree, the last completed
  phase and the phase to resume from, so the decision is taken once, by the
  runtime. A run renames itself with one `SLUG: <slug> TYPE: <type>` line, which
  moves the directory with its artifacts inside it; `QUEUE_SLUG:` is deprecated
  in favour of it and still read, for a plugin older than this runtime.

- `pipeline_log` records what the runtime measured. The total duration, the
  per-phase durations and the model of each phase are read from the stream of
  the job and overwrite what the call sent; `project`, `slug`, `tier`,
  `task_type` and `tier_raise_reason` are resolved from the job's own row and
  from `state.json` when the call leaves them out. The pipeline sends judgment
  only, and never times a phase itself.

- Every SQLite access now goes through an async store obtained from
  `openStore(env)` / `openStoreReadOnly(env)`: `src/store/` is the only path from
  the rest of the code to the database, and `src/memory/` became its private,
  synchronous implementation. Internal only - no command, output, hook or MCP
  tool changed.

- `decision_save` defaults a missing or invalid `status` to `proposed` instead
  of `accepted`: a decision recorded without a clear status now injects
  nothing into a future recall until someone accepts it.

### Removed

- The `merged` job status and the `done -> merged` sweep that `queue status`, the
  runner and `queue_status` ran on every read. The v9 migration turns every
  `merged` row into `closed` (keeping `pr_url`, `merged_at` and `merge_sha`) and
  drops `jobs.pr_checked_at`; it runs on every open, read-guarded, so a row an
  older build writes back is healed on the next one. `counts.merged` and
  `jobs[].pr_checked_at` are gone from `--json` and `queue_status`.
- `jobs.merged_at` and `jobs.merge_sha`. Nothing has written them since the
  sweep left, so they held values frozen from the old sweep on migrated rows
  and stayed empty on every job closed afterwards. The v10 migration drops both
  the same read-guarded, idempotent way, and `merged_at`/`merge_sha` are gone
  from `queue status --json` and `queue_status`.

### Fixed

- `roadmap_update` now answers with the linked decision number and the status of
  the job the item was queued as, the way `roadmap_get` already did. Its answer
  read the item without joining those two tables, so both fields always came back
  empty - the link itself was never lost.

## 0.2.0 - 2026-09-14

### Fixed

- `nightshift org rename` records its intent before touching either store, so a
  rename interrupted between the database and the config no longer hides the
  org's decisions and roadmap items with nothing pointing at them. `nightshift
  org repair` settles the interrupted rename in the direction the config already
  committed (forward or back, idempotent), and moves rows that point to an org
  the config does not know under the org named with `--to`. `nightshift doctor`
  gains an `org rows` line that fails on either state, and `org rename` and `org
  remove` refuse to run while a rename is still in flight.
- The output of `npm pack --json` is read in both shapes npm prints: the array
  of npm 10 and 11 and the object keyed by package name of npm 12. Every reader
  goes through one `parsePackOutput` - the runtime install of `setup`, `init`
  and `update`, `release:check` and the package tests - so a host on npm 12 no
  longer fails to install its own tarball with "printed no tarball name".
- `npm run release:check` refuses a changelog that still carries content under
  `## Unreleased` while the manifest declares the version of the top released
  entry, because a publish from that state ships changes the released entry does
  not describe - and npm rejects the duplicate version only after the pack.

### Added

- Org-scoped decisions and roadmap: a decision or a roadmap item now belongs to
  exactly one owner - a project or an org - and is numbered inside it (`#7` per
  project, `acme#3` per org, enforced by the database). A write names `project` or
  `org`, never both; a read by `project` answers the project's rows PLUS its
  org's, org rows first and each carrying its `scope` and its `owner`, while a
  read by `org` answers that org's rows alone and no other org's. Phase 0 of
  `/resolve` injects both levels in the same single `decision_recall`,
  `nightshift decision list --org <name>`, `nightshift decision show <number>
  --org <name>` and `nightshift roadmap --org <name>` read an org from the
  terminal, and `nightshift org rename` carries the rows of the org with it while
  `org remove` refuses an org that still owns any. An org roadmap item becomes a
  job with an explicit `--project <name>` (`project` in `queue_add`) of that org,
  or the project of the current directory: it stays `open` and unlinked, so the
  same item is queued for every project of the org and only the operator closes
  it. The schema migrates by itself to v6 - every existing row reads as
  `scope='project'` and keeps its number, with no manual step.
- Versioned runtime: an install writes a new
  `~/.nightshift/runtime/versions/<version>-<stamp>/` and publishes it by
  renaming a symlink onto `~/.nightshift/runtime/current`, in one step, so no
  instant leaves the host without a runtime and a failed install never touches
  the link. The shims, the MCP server, the hooks, the Claude Desktop entry and
  the plugin marketplace all resolve through `current`, a process that is
  already running keeps executing the directory it loaded from, and the last two
  version directories are kept - never the one `current` names, never the one a
  live runner recorded. `doctor` reports the installed version and the directory
  it resolves to, and an installation still at the old
  `runtime/node_modules/` layout keeps working and is never deleted by an
  install. The decision is recorded in
  `docs/decisions/0003-versioned-runtime-single-runner.md`.
- A terminal write is now durable, verified and witnessed: the transaction of a
  finish commits with `PRAGMA synchronous = FULL`, a fresh read-only connection
  reads the three terminal columns back, a mismatch is reported as `finish
  verification failed` in the log of the job and on stderr and retried once, and
  the write-ahead log is checkpointed afterwards. The same shape guards the
  `pipeline_log` insert. The runner then writes `terminal { status, prUrl,
  finishedAt, writtenBy, pid }` into the `state.json` of the run, and
  `nightshift queue status`, every runner cycle and the MCP `queue_status`
  restore any job whose row still says `running` or `pending` while that witness
  says how it ended, marking the result `repairedFrom: "state.json"`. A job
  under a live lease is never touched, and a retry clears the witness so the
  previous attempt can never close the next one.
- A runner records the version directory it loaded from, and watches it: when
  that tree disappears it warns once, finishes the job it is running and exits
  without claiming another. `queue status` and `doctor` name the runtime of the
  live runner.
- A terminal `merged` status for the queue: a job that delivered a pull request
  is checked with `gh pr view` and becomes `⇡ merged` once that pull request is
  merged, carrying the instant of the merge in `merged_at` and the commit in
  `merge_sha`, both in `queue status <id>` and in `--json`; a closed or open
  pull request only updates `pr_checked_at` and the job stays `done`. The check
  runs at the start of `queue status` (every `--follow` tick included), of every
  runner cycle and of the MCP `queue_status`, over at most ten jobs and at most
  once per job every five minutes, never inside an unattended job session and
  never in a hook. It fails open and in silence - with `gh` missing, logged out
  or offline nothing is written, nothing is printed and the command still exits
  `0` - and `NIGHTSHIFT_NO_PR_CHECK=1` switches it off. `queue cancel` and
  `queue retry` refuse a `merged` job, and `queue retry` still accepts only
  `failed`, `cancelled` and `gate`.

- The operator sets the risk tier of a job, and the pipeline runs the track of
  that tier: `nightshift queue add --tier trivial|simple|complex` and the `tier`
  parameter of `queue_add` store it in a new nullable column of `jobs` (one
  migration, schema v5), `nightshift queue status <id>` and the `--json` of the
  list and the detail show it, and the unattended prompt carries the line
  `Tier: <tier> (set by the operator - the pipeline may only raise it, with
  evidence, never lower it)` into the run. The `/nightshift:queue` skill proposes
  a tier, names it in the single confirmation it already asks and lets the user
  override it in that same answer. `/resolve` gained three tracks: `trivial`
  (coder plus a verifier on tsc, lint and the tests of the touched files, under 5
  minutes), `simple` (a triager only when the request is a bug, then a coder and
  a verifier on the FULL test suite, under 15 minutes, with no architect and no
  qa-guardian) and `complex` (the whole pipeline, unchanged). The mandatory
  escalation to `complex` whenever a fix changed a condition is gone: a tier is
  raised only on evidence found, never on the shape of the change, and the raise
  is written into the Brief as `Tier raised: <from> -> <to>: <evidence>`. An
  operator tier is never lowered. `pipeline_log` records `tier_operator` and
  `tier_raise_reason` next to the final `tier`, so a raised run is the runs whose
  two tiers differ, with the evidence beside them.

- Decisions and roadmap, per project and private to the home: a numbered
  decisions log (context, decision, consequences and a status among `proposed`,
  `accepted`, `superseded` and `rejected`) and a `now`/`next`/`later` roadmap,
  both reachable through seven new MCP tools and never written into the
  repository. `queue_add` with `roadmap_item_id`, and its CLI twin
  `nightshift queue add --roadmap <id>`, build the job prompt from a roadmap
  item, its linked decision and the accepted decisions around it instead of
  asking for it again, mark the item `queued` and close it as `done` when the
  job finishes. `/resolve` recalls the accepted decisions as the
  `## Standing decisions` of its Brief, passes them to the architect as binding
  constraints, and records the decision a plan takes as `proposed` for the
  operator to accept on the pull request. Three read-only commands print all of
  it in a terminal: `nightshift decision list`,
  `nightshift decision show <number>` and `nightshift roadmap`, each resolving
  the project from the current directory when `--project` is omitted, opening
  the database read-only - they never create it, and a home where nothing was
  saved reads as an empty one. Inside an unattended run, `decision_update` and
  `roadmap_update` only accept ids of the project of the job that is running,
  and the operator text a roadmap prompt carries is escaped, so it can never
  forge one of the prompt's headings nor a literal of the runtime contract.
- Release by tag: pushing a `v*` tag publishes the package to npm with
  provenance, through OIDC trusted publishing and without any npm token in the
  repository, and opens the GitHub Release of that tag with the CHANGELOG
  section of the version. A second workflow runs the suite on Node 22 and Node
  24 for every pull request and every push to `main`, and `docs/RELEASING.md`
  documents the flow plus the one-time trusted publisher setup on npmjs.com.
- Passive update notice: `nightshift queue status` and the session-start context
  block close with one line when a newer version is published. The registry is
  asked at most once every 24 hours and the answer is cached in
  `$NIGHTSHIFT_HOME/update-check.json`; the check is fail-open, so a registry
  that does not answer costs nothing and prints nothing. `--json` output and
  unattended jobs never carry the line, and `NIGHTSHIFT_NO_UPDATE_CHECK=1` turns
  the check off entirely.
- `nightshift update` refuses while a job holds a live lease or a watcher is
  registered, pointing at `nightshift queue run --stop`; a job left behind by a
  crash never blocks it, and `--force` overrides both refusals.

### Changed

- `nightshift doctor` and `nightshift memory stats` size their name column by the
  longest name of the report, so a long project name no longer runs into the text
  next to it.
- Any number of runners now work the queue together. A runner registers as
  `~/.nightshift/runners/<pid>.json`, one file per live process, carrying `pid`,
  `startedAt`, `mode`, `jobId`, `intervalS`, `detached`, `logPath`, `runtimeDir`
  and `uptimeS`; no start is ever refused because another runner is live.
  `queue status` prints one `runner:` line per live runner and prunes the
  registrations no process answers for, `doctor` reports one row per runner with
  its own runtime, `queue run --stop` ends every registered runner (one report
  line each, one shared ten-second timeout) and `queue run --stop <pid>` ends
  exactly one, and `setup`, `setup --from`, `update` and `init` refuse while ANY
  registration is alive, naming every live pid. A single-job start that could not
  claim its job now answers `job #N waiting: concurrency cap reached` and spawns
  nothing, instead of reporting a runner that would claim nothing; a drain start
  on a paused queue says so; a watcher always starts. A `runner.pid` left by a
  previous version is adopted read-only until it is stopped or pruned. A
  registry directory that cannot be LISTED - a permission, a mount failure - is
  never read as a home without runners: it is its own `unreadable` entry, so the
  install refuses (`--force` still goes through), the prune of the old runtime
  versions deletes nothing, `doctor` warns naming the directory, `queue status`
  opens with `runner: unknown`, and `queue status --json` and the MCP
  `queue_status` refuse instead of answering that nothing runs. The
  decision is recorded in
  `docs/decisions/0004-parallel-runners-registry.md`.
- Two jobs of the same project may now run at the same time: the claim no longer
  filters by project, so the only limits are the atomic claim of one job and
  `queue.maxConcurrent` - which also means the whole ceiling may be spent on one
  repository, and that merge conflicts between the pull requests of two jobs of
  one project are the operator's to resolve. The clean-canonical-checkout
  preflight stays: in a project that does not ignore the directory the pipeline
  creates its worktree in, the second same-project job is blocked with
  `dirty-checkout`, keeps its attempt and is retried by the drain until the first
  one finishes. The `project-busy` claim reason is gone.
- A drain that meets the concurrency ceiling now waits 15 s and passes again
  instead of exiting: the set of reasons it waits on named `concurrency-cap`, a
  string the claim never produces, and now names `cap-reached`.
- The refusal `nightshift update` already had is now shared by `nightshift
  setup`, `setup --from` and `nightshift init`: while a runner is registered
  alive or a job holds a live lease, all four exit 1 with `a runner is active
  (pid P / job #N) - the runtime cannot be replaced while it runs; stop it with
  nightshift queue run --stop or wait for the queue to drain` and install
  nothing. `--force` installs anyway and warns on stderr, naming the tree it is
  replacing.
- `npm run release:check` also refuses a working tree with uncommitted changes,
  before the version and the pack checks, because a publish ships what is on
  disk and not what is committed.

### Deprecated

- The singular `runner` key of `nightshift queue status --json` and of the MCP
  `queue_status` answer. It is now the first entry of `runners` (and the same
  all-null object as before when no runner is live), kept for one release and
  removed in the next minor - read `runners`. `runnerAnswer.runner`, which
  describes the runner a `queue_run` or `queue_retry` call itself started, is not
  part of this deprecation and stays.

## 0.1.0 - 2026-09-09

First public release.

### Added

- Unattended queue (`nightshift queue`): enqueue a request, run it through
  `/nightshift:resolve` and get a pull request back. The runner starts detached
  by default, `--foreground` keeps it in the terminal, `queue run --watch`
  registers a pidfile and `queue run --stop` ends it. `queue retry` sends a
  gated, failed or cancelled job back to the queue, and `queue log --follow`
  narrates a run while it happens.
- Hybrid memory on `node:sqlite`: BM25 keyword recall always, semantic recall
  once the opt-in embedding library is installed into its own prefix, plus the
  lessons, the memories, the repository index and the pipeline log.
- MCP server (`nightshift mcp`): the eleven stdio tools of the memory and of the
  queue, over the official SDK.
- Claude Code plugin: the `/nightshift:resolve` pipeline, `/nightshift:qa-guardian`
  and the six subagents, distributed through the marketplace of this package.
- Configuration CLI: `nightshift init` and `nightshift setup` install the runtime
  into `~/.nightshift` and register the MCP server, the three hooks and the
  plugin in the host, idempotently and reversibly; `nightshift update` reinstalls
  the runtime from the registry; `nightshift doctor` diagnoses the host and the
  home without ever writing to them, and asks the registry for the newest
  published version only behind `--check-updates`.
- Orgs, projects and connections: named scopes for the memory and for the queue,
  with the secrets kept in a file only the owner can read.
- Published to npm as `@maykonv/nightshift`; the command it installs is `nightshift`.

[0.2.0]: https://github.com/maykonVinicius/nightshift/releases/tag/v0.2.0
[0.1.0]: https://github.com/maykonVinicius/nightshift/releases/tag/v0.1.0
