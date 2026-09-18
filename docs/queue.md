# Queue

The queue is what makes the runtime unattended: `nightshift queue add` records a
request against a registered project, `nightshift queue run` claims it and spawns
`claude -p /nightshift:resolve <request>` with the plugin of this package and
this same MCP server attached, and the pipeline itself opens the pull request at
the end. The runner reads the stream of the run and stores what
[Runtime contract](runtime-contract.md) defines: the slug, the session id, the pull request URL,
the `## Notice` and the token usage.

```sh
nightshift queue add api "fix the flaky worker" --priority 2   # enqueue a job
nightshift queue add "fix the flaky worker"                    # same, for the project of the current directory
nightshift queue add fix the flaky worker --run                # enqueue and start the runner on it, detached
nightshift queue add "fix the flaky worker" --yes              # register the repository of the current directory without asking
nightshift queue add "fix the flaky worker" --tier simple      # declare the risk tier; the pipeline may only raise it
nightshift queue status [--limit 10] [--json]                  # the state of the runner, the table of the queue and the counts
nightshift queue status --follow [2] [--until-idle]            # the same table, redrawn in place until Ctrl-C (or until the queue is idle)
nightshift queue status --blocked                              # only the pending jobs a preflight block is holding back
nightshift queue status 7 [--json]                             # one job, never with its prompt
nightshift queue run [--job 7] [--max 2] [--dry]               # start the runner detached; --max 2 exits after two jobs; --dry only reports
nightshift queue run --watch [30]                              # start a watcher, one pass every N seconds
nightshift queue run --stop [4242]                             # end every registered runner, or only the one with that pid
nightshift queue run --foreground [--job 7]                    # run it in this process instead, for a script or CI
nightshift queue log 7 [--follow] [--raw] [--all]              # the narrated stream of the job
nightshift queue cancel 7 --reason "not needed"                # cancel a pending, gated or orphaned job
nightshift queue retry 7 --note "rename the column" [--fresh]  # answer the gate and send the job back to the queue
nightshift queue repair 7 [--json]                             # re-classify a gated or failed job from its own log
nightshift queue pause | nightshift queue resume                    # stop claiming new jobs, or claim again
```

**The project is optional, the prompt is variadic.** Omitted, the project is the
one whose registered path contains the current directory (`nightshift init` is what
registers it), and the command says which one it picked. Given, the first word
is the project only when it is a registered NAME; anything else is already part
of the prompt, so the words of the request need no quotes.

**No project registered for the current directory.** Inside a git repository, on
a terminal, the command asks `Register it as <name> in org <org> and queue the
job?`, with `<name>` derived from the basename of the repository root (`-2`,
`-3` ... when that name is taken). A yes registers the root and queues the job in
the same run; a no changes nothing. `--yes` answers the question for a script.
Without a terminal and without `--yes`, or outside any repository, the command
fails exactly as it did before and registers nothing.

**Options are read only at the two edges of the command line**, before the first
word of the request and after the last one. Everything between them is the
prompt, kept exactly as it was typed: `nightshift queue add explain the --run flag to
the team` queues those seven words and starts nothing. A prompt that begins or
ends with a flag is the ambiguous case, and goes after `--`:
`nightshift queue add -- explain --run to me`. An option that does not exist is still
a usage error at either edge, never a silent word of the prompt.

**`--run` starts the runner on the job right away**, detached, instead of leaving
it for the next `nightshift queue run`. It prints the job id first, then the line
`job #<id> started (pid <pid>) - follow with: nightshift queue log <id> --follow`,
and exits `0` as soon as the child is up: the exit code answers for the start, not
for the outcome of the job, which is read with `queue status` or `queue log`. Add
`--foreground` to get the old behaviour back - the job runs in this very process,
the stream goes to the log of the job, and the exit code answers only about this
run: `0` when the job ended as `done`, `1` for any other outcome (`gate`,
`failed`, `cancelled`, an interrupted run) and `1` when the job never started,
with the reason on the line `job #<id> did not start (<reason>)` - the job stays
in the queue. `--foreground` on a command that was not given `--run` is a usage
error, never a silent no-op. An explicit job id ignores the pause sentinel, so
`--run` runs even on a paused queue.

**`--tier` declares the risk of the job.** `queue add --tier trivial|simple|complex`
(and the `tier` parameter of `queue_add`) records the tier on
the job, and the unattended prompt carries it into the run as
`Tier: <tier> (set by the operator - the pipeline may only raise it, with evidence,
never lower it)`. Each tier is a track: `trivial` is a coder plus a verifier that runs
tsc, lint and the tests of the touched files, **under 5 minutes**, for a result the
prompt fully describes (docs, copy, config values, a rename, a test-only change);
`simple` is a triager only when the request is a bug, then a coder and a verifier that
runs the FULL test suite, **under 15 minutes**, for a local change whose behaviour the
prompt defines, in one subsystem; `complex` is the whole pipeline (triager, exploration,
architect, coder, QA and verifier), for a design decision, a concurrency/security/money
surface, more than one subsystem or a brief that needs stages. The pipeline **raises** a
tier only on evidence it finds — a stack trace, a security/concurrency/money surface, a
schema/contract/tool change the brief did not name, or an ambiguous brief — and writes
the raise into the Brief as `Tier raised: <from> -> <to>: <evidence>`. It never lowers
one, and it never raises on the shape of the change. A value that is not one of the
three is a usage error naming the three accepted values, and nothing is queued.
A job with no tier keeps the pipeline's
own classification. The tier shows up in `nightshift queue status <id>` and in the
`--json` of both the list and the detail; a job with no tier simply has no `tier` line.

### Running the queue

**The runner is detached by default.** `nightshift queue add --run`,
`nightshift queue retry --run` and `nightshift queue run` all spawn a child that runs
the queue on its own and return as soon as that child is up, with exit code `0`.
The child is this same CLI started as `nightshift queue run --foreground ...`, so
`--foreground` is both the flag you type for a blocking run and the flag that tells
the child it is the worker. A start that cannot spawn exits `1` with the reason and
never falls back to running the job in the foreground behind your back.

**`nightshift queue run` with no other option drains the queue**: the child runs
cycle after cycle until nothing is pending, waiting 15 s between passes while the
pending jobs are held back by a preflight block or the ceiling the operator set in
`queue.maxConcurrent`, and exits by itself when the queue is empty. `--max <n>` is a budget
for the run: the runner processes at most n jobs that reach the agent and exits, printing
`queue: stopped - the --max budget of this run is spent`. A job the preflight releases (a
dirty checkout, a missing `claude` binary) spends none of it, so the drain keeps waiting on
that job with its budget intact. The budget applies to `--watch` and to a single foreground
cycle too; without it the drain runs until nothing is pending. The command that starts it registers it in
`$NIGHTSHIFT_HOME/runners/<pid>.json` with `mode: "drain"` for as long as it lives, so
`queue status` shows `runner: running (pid <pid>, drain, runtime <version>, since <iso>)`
the instant the start returns, and `--stop` ends it. Its output
goes to `$NIGHTSHIFT_HOME/logs/runner-<stamp>.log`; the start prints
`runner started (pid <pid>) - draining the queue until nothing is pending; follow with:
nightshift queue status --follow`. When the start is aimed at a single job the child
runs that job alone and the line points at its narrated stream instead:
`job #<id> started (pid <pid>) - follow with: nightshift queue log <id> --follow`; that
one registers too, as `once, job #<id>`. A job running with no registered runner at all
(a runner that died without clearing its registration) is still visible: the opening
line says `0 runners online - 1 running job under a one-shot runner - nothing will pick
up the pending jobs after it (start a drain with: nightshift queue run)` instead of
``0 runners online - pending jobs will wait until `nightshift queue run` starts one``.

**`--foreground` is the mode for a script or for CI**: it runs the cycle in the very
process you started, prints one line per processed job and answers with an exit code
that depends on the outcome (`0` only for `done` on `--run`). `--dry` never detaches
either: it is a read-only report of what a cycle would do, including `cap` (`none` without a
ceiling) and `max` (`none` without a budget).

**`--watch [seconds]` is the daemon**, one pass every `N` seconds (30 by default).
It is registered in `$NIGHTSHIFT_HOME/runners/<pid>.json` with `pid`, `startedAt`, `mode`,
`jobId`, `intervalS`, `detached`, `logPath` and `runtimeDir`, and prints
`runner started (pid <pid>, every <n> s) - stop with: nightshift queue run --stop`.
`--job` and `--watch` are refused together: running one job and watching the whole
queue are opposite intents.

**One job per runner.** A runner claims a job, runs it to the end and only then claims the
next one, in queue order (priority, then age). Jobs run at the same time only because several
runners are live - start another with `nightshift queue run`; a single runner never runs two.

**Any number of runners, whatever started them.** A watcher, a drain and a single-job
runner are all registered the same way, one file per pid, and every start path - `queue run`,
`--watch`, `--job`, `queue add --run`, `queue retry --run`, their `--foreground` forms and the
`queue_run` and `queue_retry` MCP tools - registers its runner under the home lock, in the
same critical section as the prune of the dead registrations.
**No start is ever refused because another runner is live**: the claim is one atomic `UPDATE`
inside SQLite, so a second runner costs nothing and takes nothing away. `queue.maxConcurrent` is an opt-in ceiling over
the whole home, with no default: there is no ceiling until the operator sets a positive
integer, and anything else means none. With one set, it counts the jobs under a live lease,
which is exactly the runners holding a job. What a start does refuse is spawning a child that
would claim nothing: with a ceiling set, a single-job start against a full ceiling prints
`job #<id> waiting: concurrency cap reached`, then `<active> of <cap> jobs already running`
and, when a live drain or watcher is registered,
`a live runner (pid <pid>, <mode>) will pick it up`; it spawns nothing, leaves the row
`pending` and exits `0`. A job that is not pending answers `job #<id> is <status>, not pending -
it will not be picked up`, an unknown id exits `1`, and a drain start on a paused queue says so
instead of starting a child that would exit on its first cycle. A watcher always starts:
waiting for the condition to clear is what a watcher is for. A registration whose process is
gone is pruned on the way and the start goes on.

**Advisory lines.** Two warnings tell the operator when another runner is likely to cost more
than it delivers; they never block a start. The first appears when the five-hour window of the
provider is at 80% or more while at least one runner is live:

```
5h window at NN% · K runners active — another runner will likely hit the limit before finishing
```

with `1 runner active` in the singular. The utilization is the latest reading a live runner saw
in the rate limit events of the provider's stream, kept in its own registration and valid until
that window resets; the highest fresh reading among the live runners wins, and with no reading
the line never appears. The second appears once per repository that two or more jobs under a
live lease are working at the same time, in project name order:

```
N runners on `<project>` — parallel jobs on one repository fight over the checkout; a job the preflight releases retries with backoff and burns tokens for no output
```

When both apply, the window line comes first. `queue status` prints them right
after the runner lines (every `--follow` tick included) and carries them as `advisories` in
`--json`. Every start echoes them once, after its own report: `queue run`, `--watch`, `--job`,
`queue add --run` and `queue retry --run`, a start that reports it is waiting included. A
foreground run echoes them once as soon as its runner is registered, before the first job, and
writes them to stderr under `--json` so stdout stays valid JSON; the detached child never echoes
them again into the runner log. Over MCP, `queue_status` ends its `hint` with them and lists them
under `advisories`, and `queue_run` and a `queue_retry` with `run: true` answer `advisories` too. A read that fails
answers no advice.

**`nightshift queue run --stop [pid]` ends the registered runners**: without a pid it ends
every one of them, signalling all of them first and then polling once, so N runners cost one
ten-second timeout and not N; with a pid it ends exactly that one and leaves the others
registered. It prints one line per runner - `runner stopped (pid <pid>)`,
`runner was not running (stale registration removed)` or `runner is not running` - and exits
`0` in those cases; it exits `1` when a process is still there after those ten seconds, saying
that the runner finishes the job it is running and exits by itself. A registration owned by
another user is reported as `runner (pid <pid>) belongs to another user; nightshift will not
signal it` and never takes the stop of the healthy runners down with it, while `--stop <pid>`
aimed AT that registration refuses, because there the refusal is the answer. An unknown pid
fails with `no runner is registered with pid <pid>`. `--stop` takes no other option. Known
limitation: if a runner died and the system handed its pid number to another process inside
the same boot session, `--stop` trusts the registration and signals that pid; confirming the
real identity of a process would need `ps`//proc/ and is out of the scope of this command.

**A watcher stopped in the middle of a job never corrupts it.** The signal makes the
runner stop claiming and end the child of the job it was running; that job is released
back to `pending`, with its lease dropped and its attempt given back, so the next
runner picks it up as if it had never started. The watcher then removes its own
registration - and only its own, matched by pid, so it never clears the registration of
another runner.

**`queue status` is a table, and `--follow` keeps it live.** One row per job with
the columns of the cockpit: `ID STATUS DURATION TOKENS PROJECT SLUG/LAST PR`.
`STATUS` carries an icon (`● running`, `✓ done`, `■ closed`, `⚑ gate`, `✗ failed`,
`⊘ cancelled`, `○ pending`) and a color on a terminal. `DURATION` is how long a
running job has been up (from its own `started_at`) or how long a finished one
took; `TOKENS` is what it spent so far (`374k`, `1.2M`). `SLUG/LAST` is the last
thing the orchestrator said in its log while the job runs (`» ...`), the first
line of the notice of a `gate` or `failed` job, `⛔ <code>: <message>` for a
`pending` job a preflight block is holding back, and the slug otherwise; `PR` is
the URL of the pull request, bare, so the terminal makes it clickable on its own. Only running jobs are read from disk, and only the tail of their log, so
listing a job whose stream is already hundreds of kilobytes costs nothing; a job
with no log yet and a log that cannot be read both show `-`, the table is always
printed in full and the exit code stays `0`. The columns adapt to the width of
the terminal and `SLUG/LAST` is cut with an ellipsis, never wrapped; on a pipe there
is no color and no cursor movement. `nightshift queue status --follow [seconds]`
(default 2) redraws the table in place until Ctrl-C - the terminal equivalent of
a queue panel - and `--until-idle` makes it exit by itself once nothing is
running or pending. `--follow` refuses `--json` and a single job id. Each frame starts on
the interval: the follow times its own read and sleeps only what is left of it
(`max(0, interval - read)`), so a slow read never stretches the cadence on top of itself.
On a terminal the footer says what was achieved and what the read cost -
`achieved every 2.0s (asked 2s) · read 3ms: jobs 1ms, counts 0ms, runners 1ms, advisories 1ms · Ctrl-C to stop`
(`-` on the first frame, and `runners error (<reason>)` for a part that failed); a pipe
never gets the footer, so it still prints only what changed. A part of the read that
fails never ends the follow: `jobs: cannot be read (<reason>)` or `counts: cannot be read (<reason>)`
takes its place on the frame and the next poll tries again, while a one-shot `queue status`
exits 1 with `the queue cannot be read: <reason>`. `--json`
answers with the same fields as before plus `suggestions` and `sections` - one
`{ name, ok, ms, error }` per part of the read (`jobs`, `counts`, `runners`,
`advisories`), which the MCP `queue_status` carries too. The listing opens with the live-runner count -
`N runner(s) online` - followed by ONE line per live runner -
`runner: running (pid <pid>, watch every <n> s[, foreground][, runtime <version>], since <iso>)`
- or, when none is registered, ``0 runners online - pending jobs will wait until
`nightshift queue run` starts one`` in place of the per-runner lines. The advisory lines, when
they apply, follow the runner lines. `--json` carries
`runnersOnline` (the count) next to the whole list under `runners`, `advisories`, plus the singular
`runner`: it is `runners[0]` (or the same all-null object as before when the list is
empty), kept for one release and removed in the next minor - read `runners`.

**Maintenance is not a read.** Pruning the registrations no process answers for (a
registration owned by another user is left alone) and repairing a job from its witness
belong to the runner, which does both at the start of every cycle, to the MCP server,
which does both once when it starts and then every 60 s, and to the one-shot `queue
status` (plain, `--json` or `<id>`), which does both once before it prints. The repair
restores any job whose row says `running` or `pending` while the `terminal` witness of its
run directory already says how it ended; a repair that could not be written is a warning
(on stderr for the CLI, as `warning` in `queue_status`, which reports the last pass of the
server's maintenance), never a failed listing. `--follow` never writes: no repair, no
prune, no pull request bookkeeping, before the loop or during it - only a home with no
database at all gets one created. A job orphaned by a dead runner therefore keeps its
status on a follow's screen until the runner, the MCP server or a one-shot `queue status`
repairs it. A job under a live lease is never touched, and neither is one an operator has just
retried: the retry records that it reopened the row in the very write that sends it back
to the queue, so the witness of the attempt before it can never close it again.

**The log is narrated by default.** `nightshift queue log <id>` prints one line per
relevant event of the stream, timed relative to the `=== attempt N ===` marker
that opens each attempt: `»` what the orchestrator said, `·` each tool with its
file or command, `▶`/`◀` each subagent lane with its phase and what it reported
back, the actions of that lane indented under it, and `⚑` the slug, `⚠` the gate,
`✓` the pull request, `ℹ` the notice and `✗` a tool that failed. Nothing else of
an event is printed: no prompt, no task summary, no output of a tool that
worked; an MCP tool shows only a field that names its target (a project, a path,
a pattern, a query), never the rest of its input. A line the narration cannot read is counted and reported at the end
instead of vanishing. `--raw` prints the stream exactly as it was written,
`--all` adds the text of the subagents, and the two together are a usage error.

**`--follow` ends by itself.** It keeps reading the file by offset (no `watch`,
no missed append), and stops as soon as the job leaves `running`, closing with
`═ job #<id> <status>`; a job whose row is gone or a status that cannot be read
stops it too, with the reason on stderr and the exit code still `0`. While the
job runs and the stream has nothing to narrate, it ticks `· still running` every
30 seconds, so silence never means the follow died. A log file that cannot be
read is treated as a glitch first: the failure is reported on stderr, the follow
keeps polling and only gives up after five failures in a row, and the closing
reason always says that the log became unreadable instead of claiming a complete
narration - the exit code stays `0` and a stack trace is never printed. `NIGHTSHIFT_FOLLOW_DEBUG=1`
traces every poll on stderr (`follow: t=<iso> size=<n> offset=<n> lines=<n>`),
which is what to turn on if the output ever stalls again.

**The seven states.** A job is `pending` while it waits, `running` while a runner
owns it under a lease, and then one of five final states: `done` (the run
delivered a pull request URL), `closed` (the operator closed a delivered job
with `nightshift queue close`), `gate` (the pipeline stopped asking for a human decision - a recorded
`outcome.status: "gate"` in `state.json`, or the `## Requires user
confirmation` marker in the stream), `failed` (a non-zero exit, a timeout, an
orphan that had already spent its attempts, or a clean exit that ended with
nothing to deliver and never asked for a decision) and `cancelled` (cancelled
by the operator, or stopped while running). A job in `gate` ALWAYS carries the
reason it stopped in `notice_md`: without a `## Notice` the reason is the
summary the pipeline recorded in `state.json`, and the whole final text of the
orchestrator when there is none, and a run that ended saying nothing at all is
`failed` with a fixed warning instead of a gate nobody can read.

A `pending` job the preflight refused to start also carries a reason, in its own
`blocked_code` column - it answers a different question than `status`: not where
the job is, but why it is not moving right now. See **What the runner requires
of the checkout** below for what sets and clears it.

**The pull request state is derived, never stored.** Every job with a GitHub pull
request carries `pr_state`, read from `gh pr view <url> --json
state,mergedAt,mergeCommit,mergeable,isDraft` and flattened by precedence: `merged`
> `closed` > `conflicted` > `draft` > `unknown` > `open`. `mergeable: UNKNOWN` (GitHub
has not computed it yet) reads `unknown`, never "no conflict". The answers live in a
cache of the process that asked - never in the database: a merged or closed pull
request is never asked about again, an open, conflicted or draft one after 60 s, an
`unknown` one after 8 s, and a read gh could not answer is held back for 30 s and keeps
the last state it had. A pull request nobody asked about yet reads `unknown`. The `PR`
cell shows it next to the URL (`https://github.com/acme/api/pull/42 (merged)`), and
`--json` carries `jobs[].pr_state` plus `suggestions`. A `done` job whose pull request
is merged is never changed by a read: the listing adds the line
`#12 PR merged - close it with nightshift queue close 12`, and closing it is the
operator's act. gh is never asked about more than four pull requests at once. A one-shot
`queue status` asks it before it prints and waits one overall 5 s deadline at most -
what has not answered by then prints `unknown`, and the gh still running is stopped; `--follow` never waits for gh - it asks after drawing a
frame and picks the answer up on a later one - and the MCP `queue_status` answers from
its cache and asks gh after answering. `NIGHTSHIFT_NO_PR_CHECK=1` switches every gh call
of this off.

`queue cancel` moves a job out of a final state into `cancelled` (from `pending`,
`gate` or an orphan), and `queue retry` moves it back to `pending` (from `gate`,
`failed` or `cancelled`). A `closed` job is terminal for both: `queue cancel`
refuses it as already finished, and `queue retry` still takes `failed`,
`cancelled` and `gate` and nothing else. A gated job only moves with `--note`, and that note is
the only thing that ever reaches the prompt of the run, in a block labelled
`OPERATOR ANSWER TO THE GATE:` - a retry without `--note` clears whatever was in
`operator_note`, so the label never lies about where the text came from. Each
retry widens the allowance of attempts by one, capped at 10, and never rewrites
the attempts already spent.

Without `--fresh` the retry keeps slug, branch, session and run directory, and
the pipeline resumes from the last completed phase. The ceiling of those resumes
lives in the `state.json` of the run (`resumeCount` against `maxResumes`, default
`1`), not in the database: a SECOND retry without `--fresh` starts the run from
scratch because the runtime decided so, which is the intended behaviour and not a
bug of the retry. `--fresh` asks for that from the start: it clears slug, branch
and session and drops the run directory - and only a plain directory of this home,
never a symlink, never a path outside `<home>/runs/`; anything else is kept, with
the reason printed, and the retry goes on.

`queue repair <id>` re-classifies a job that ended `gate` or `failed` from its
own persisted log plus the `outcome` recorded in the `state.json` of its run, and
is the way a run that really opened a pull request but was recorded without its
link is corrected without editing sqlite by hand. It runs only when the operator
asks for it, by id: it never runs on its own, and the automatic repair from the
`terminal` witness is untouched by it. The row keeps the ending the process had
(a killed, timed-out or non-zero-exit run is never turned into `done`), the
witness in `state.json` is rewritten so file and row agree - a correction that is
only the notice re-read from the log writes the row alone and leaves that witness
untouched - and a second call answers that there is nothing to correct and writes
nothing. It refuses, naming the reason, an unknown job, a job running under a
live lease, a job in any other status, a job whose log is gone and a job whose
`result` recorded no exit code.

**Two jobs of the same project may run at the same time - on two runners.** The claim filters
by nothing but `pending`: the only limits are the atomic claim of one job and, when set,
`queue.maxConcurrent`.
Each job runs in its own git worktree, and merge conflicts between the pull requests of two
jobs of one repository are the operator's to resolve. **The caveat is the preflight, and it
stays:** a job only starts from a clean canonical checkout. In a project that does NOT ignore
the directory the pipeline creates its worktree in (this repository ignores
`.claude/worktrees/`), the worktree of the first job makes the checkout dirty, so the second
same-project job is blocked with `dirty-checkout`, released with its attempt given back and
retried by the drain every 15 s until the first job finishes - degraded and visible in
`queue status`, never lost and never corrupt. Two same-project jobs whose slugs collide on
one branch name fail the same safe way, one job at a time. The ``2 runners on `<project>` ``
advisory line is what warns about it while it happens.

**Ownership and orphans.** A claim is one atomic `UPDATE` inside SQLite, so two
runners never share a job and `queue.maxConcurrent` (no default: no ceiling) is, when set,
a ceiling over the whole home, not over one process - and, since the claim does not filter by
project, it may be spent on jobs of a single repository. The claim arms a lease of
`timeout_s + 600` seconds; while the job runs, the runner re-arms it every
`queue.leaseHeartbeatS` seconds (default `5`, accepted range `1..20`), which is
the same write that answers whether it still owns the job. A `running` row
becomes an orphan only 60 seconds after its lease expired, and even then it is
left alone while the process named in `worker` is alive on this host - unless
`started_at + timeout_s + 600` has already passed, in which case it is recycled
anyway, because reclaiming never depends on a healthy process. The next claim
returns an orphan to `pending` (keeping its attempts) or fails it once it spent
the `max_attempts` of its own row. A runner that loses ownership kills its child
in the same heartbeat and writes nothing but one line in the job log: the row
belongs to somebody else. `queue cancel` refuses a job that is running under a
live lease: stop that runner first.

**Timeouts.** Each job has its own total timeout (`--timeout`, default 4 hours)
and every attempt also dies after 20 minutes without a single line on the
stream. Neither is a transient failure: a timed out attempt is `failed` and is
never retried. Only a provider failure (429, overload, connection reset) is
retried, up to `--max-attempts`, backing off 5s, 15s and 45s.

**The attempt has no other ceiling, and a deterministic rule never lives only in
the prompt.** The runner starts the agent with
`CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0`, so the CLI waits for every subagent and
background task the run still has open instead of killing one after ten minutes
and exiting `0`; the two timeouts above already bound the attempt and they are
the only ones. A run the CLI kills anyway comes back as `failed`, saying the
runtime killed that background task after its wait ceiling, never as a gate, and
it is not retried. And a `PreToolUse` hook rewrites every `Agent`/`Task` launch
of an unattended run to `run_in_background: false` - it normalises the call, it
never blocks it. That is the shape of the rule: what has to happen on every run
lives in the runtime or in a hook with a test behind it, never only in the prompt
of the pipeline, because a sentence in a prompt covers only the wording it
happens to forbid and is lost the moment the platform underneath changes.

**Resuming by slug.** The run directory of a job is opened by the runner, not
derived by the pipeline: the claim gives the job a slug when its row has none
(built from the first words of the prompt), and the prompt carries `Project:` and
`RUN_DIR:` from the start. The pipeline renames the run once, by printing
`SLUG: <slug> TYPE: <type>` on a line of its own, and the runtime moves the
directory with the artifacts already inside it. Everything the run records lands in
the `state.json` of that directory, written by the runtime alone (see
[Runtime contract](runtime-contract.md)).

On a new run of the same job the runner takes the resume decision itself, before
spawning anything, and hands the result over in the prompt as one block:

```
RESUME CANDIDATE (slug `fix-the-worker`)
RUN_DIR: /Users/me/.nightshift/runs/api/fix-the-worker
Branch: fix/the-worker
Worktree: /Users/me/code/api/.claude/worktrees/fix-the-worker
Last completed phase: triage
Resume from phase: explore
From stage: none
Trust this block: skip every phase already listed in the state and read its artifact.
Run `git status --short` in the worktree first.
```

`Branch`, `Worktree` and `From stage` read `none` when the run recorded none;
`From stage: qa-stage-b` is the one sub-phase with a marker of its own, so a run
that died in the QA does not pay the analyst twice. A run the decision refuses -
no state, a deliberate termination, a resume budget already spent - gets no block
at all and starts clean, and the runtime counts the resume in `state.json` itself:
the pipeline never touches that file. With `queue.resumeSession: true` in
`config.json` the runner also passes `--resume <session id>` once the job has a
session of its own. The default is `false`.

**What the runner requires of the checkout.** Before spawning anything it
checks, in this order: the project is registered by NAME, its checkout exists
and has a `.git`, the `claude` CLI resolves (`NIGHTSHIFT_CLAUDE_BIN`, then
`PATH`), the checkout is clean (`git status --porcelain` empty) and it sits on
the default branch. A block is not a failure: the job goes back to `pending`
without spending an attempt and the reason is stored in `result` (the operator
note is never touched), so a later run picks it up once the checkout is in
shape. The block code also lands in its own `blocked_code` column - orthogonal
to `status`, the same way `notice_md` sits beside a `gate` - which is what makes
a blocked job visible: `queue status` breaks it out of the pending count
(`pending=3 (1 blocked)`), shows `⛔ <code>: <message>` in `SLUG/LAST` and the
detail view, and `--blocked` lists only the pending jobs a preflight block is
holding back. **`gate` and `blocked` are not the same wait.** A gate needs the
operator to answer it with `queue_retry`; a block needs the operator to fix the
cause (clean the checkout, register the project, put `claude` back on the
`PATH`) and the job goes back to `running` by itself on the drain's next pass -
no retry, no operator call. The claim clears `blocked_code` the instant it
picks the job back up.

**What it does NOT do in v1.** It never merges anything, never closes the cycle
after the pull request, keeps no token budget, ships no launchd (or any other)
scheduler, sends no notification and has no cockpit. It also never changes the
state of a git repository: the only git commands it runs are reads of the
checkout, and every branch and worktree is created by the pipeline itself.

## Writing a job

One job is one self-contained deliverable that can be reviewed and merged on its
own. Large work is ONE job with numbered stages written in the prompt — never
several jobs that depend on each other. A job that needs another job's pull
request merged first is cut wrong: fold it into that job. Independent jobs may
run in parallel and merge in any order.

```sh
nightshift queue add "Self-contained install. Stages: 1) runtime under ~/.nightshift; 2) shim + PATH prompt; 3) embedding opt-in; 4) rename bin to ns. Each stage verified before the next; one PR."
```

Run it from inside the repository the job is about: when that repository is not
a registered project yet, `queue add` offers to register it (`--yes` accepts the
offer without asking) and queues the job in the same step.

**There is no `--after`.** A job that waits for another job's pull request is an
incomplete deliverable: what it lands on main is half a change that nobody can
review on its own. It also breaks the unattended queue, which claims jobs by
priority across projects and has no way to hold one back until a pull request it
never sees is merged.

**Branch chains are v1.1**, and only for work that genuinely does not fit in one
run. Until then, the answer to "this depends on that" is one job with stages.

**The tier is yours to set.** `--tier trivial|simple|complex` on `queue add` (or the
`tier` parameter of `queue_add`) tells the pipeline how much risk the job carries, and
the run executes the track of that tier. The criteria of each one, their time targets
and what raises a tier are in [Queue](queue.md).

`nightshift queue add --help` prints this rule and the example.

