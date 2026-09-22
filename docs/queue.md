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
nightshift queue run --watch --from 22:00 --until 04:00        # watch only inside that window, then exit
nightshift queue run --stop [4242]                             # end every registered runner, or only the one with that pid
nightshift queue run --foreground [--job 7]                    # run it in this process instead, for a script or CI
nightshift queue log 7 [--follow] [--raw] [--all]              # the narrated stream of the job
nightshift queue session 7 [--print]                           # resume the claude session of the job's last attempt
nightshift queue cancel 7 --reason "not needed"                # cancel a pending, gated or orphaned job
nightshift queue retry 7 --note "rename the column" [--fresh]  # answer the gate and send the job back to the queue
nightshift queue repair 7 [--json]                             # re-classify a gated or failed job from its own log
nightshift queue ship 7 [--force] [--foreground] [--json]      # merge a done job's pull request and close the job, detached
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

**`--watch --from HH:MM --until HH:MM` works the queue inside one time window and
exits at its end.** Both are local wall-clock times, resolved once when the watch
starts. `--from` defaults to now; otherwise it is the next occurrence of that time,
unless now already falls inside the window that time's most recent past occurrence
would open, in which case `from` is now. `--until` is always the first occurrence of
that time after the resolved `from`, so a window that crosses midnight
(`--from 22:00 --until 04:00`) needs no special syntax. Before `from` the runner is
alive, registered and claims nothing; between `from` and `until` it is exactly
today's watch behaviour; at `until` it stops claiming, **the job it is running
finishes** - the window never kills or interrupts a job and never shortens a job's
own timeout - and then the process exits `0` with its registration gone. A rate-limit
pause inside the window is waited out as today, cut short at `until`. `--max` keeps
its meaning: whichever ends first. If jobs are still pending when the window closes,
the last line says so: `window closed at 04:00 - 3 jobs still pending`. Only
`--watch` takes a window: `--from`/`--until` without `--watch`, `--from` without
`--until`, the two naming the same time, a malformed time, or either flag next to
`--job` are all refused by usage, naming the reason. A drain, `--job` and the MCP
`queue_run` are unchanged.

Started detached (the default: `nightshift queue run --watch --from 22:00 --until
04:00`) it returns at once, forwarding the flags to the child; `--foreground` holds
the terminal for the whole window instead. `queue status` shows it on the runner
line - `watch every 60 s · window 22:00-04:00 · opens in 3h12` before it opens,
`· closes in 5h40` inside it - and `queue status --json` and the MCP `queue_status`
carry `window: { from, until }` (ISO instants) on the runner. When the only live
runner is still waiting for its window, every surface says `1 runner waiting for
its window (opens 22:00)` instead of promising a pending job gets picked up.

**The window is one-shot.** When it closes the process ends and nothing brings it
back. Running it every night is an OS-level job (`launchd` on macOS, `systemd` on
Linux) the operator sets up themselves - nightshift ships no installer for that
today, and no runner ever starts another runner.

**`queue.keepAwake` keeps the machine from sleeping while a runner or a job needs
it**: `"auto"` (default), `"always"`, or `"off"`. On macOS every runner, in every
mode, holds a `caffeinate` process bound to its own pid for its whole life - `-s`
under `auto` (holds only on AC power, so a runner waiting hours for its window or
for a rate-limit reset never drains a battery), `-i` under `always`. While a job's
child runs, an extra `-i` hold is bound to that child's pid, so a job is not put to
sleep mid-run on battery either. `off` spawns none, and because each hold is bound
to a pid it dies with what it was protecting - nothing to clean up, and a crashed
runner leaks nothing. On every other platform it is a silent no-op, and a missing or
failing `caffeinate` never fails a runner or a job, just one warning line. **The
limits are real:** the display is allowed to sleep (`-d` is never used), a closed
lid with no external display still sleeps, and nothing here wakes a machine that is
already asleep - a windowed night run needs the lid open (or an external display)
to survive to `until`. `nightshift doctor` reports the mode, whether `caffeinate`
was found (macOS only) and this same limitation.

**One job per runner.** A runner claims a job, runs it to the end and only then claims the
next one, in queue order (priority, then age). Jobs run at the same time only because several
runners are live - start another with `nightshift queue run`; a single runner never runs two.

**Any number of runners, whatever started them.** A watcher, a drain and a single-job
runner are all registered the same way, one file per pid, and every start path - `queue run`,
`--watch`, `--job`, `queue add --run`, `queue retry --run`, their `--foreground` forms and the
`queue_run` and `queue_retry` MCP tools - registers its runner under the home lock, in the
same critical section as the prune of the dead registrations. `queue ship` and the
`queue_ship` MCP tool register theirs the same way, as a runner of mode `ship` that claims
no job (see *Shipping a job*).
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

**A cut text says so, and says where the rest is.** A listing (the table, `--follow`,
`--json`, the MCP `queue_status` without `job_id`, and the job each of `queue_cancel`,
`queue_close` and `queue_retry` answers with) cuts `notice_md` and `result` at 500
characters. A row whose text was cut carries `notice_truncated: true` or
`result_truncated: true`; the key is absent when the text fits, so a listing where
everything fits is the same as before. The listing then adds one line to `suggestions` -
`#12 text cut at 500 characters - read it whole with nightshift queue status 12` for
exactly one job, `3 jobs have text cut at 500 characters (#12, #9, #7) - read each whole
with nightshift queue status <id>` for several - which the table prints under the counts
and the MCP `hint` ends with. `nightshift queue status <id>` (and `queue_status` with
`job_id`) is never cut.

**`queue status <id>` can show two notices.** The single-job view (CLI human, CLI `--json`
and the MCP `queue_status` with `job_id`) reads the log the row's `result.logPath` names
and re-extracts the run's own `## Notice` straight from it. When that really differs from
the row's `notice_md` (a repair that never ran, a witness written before a fix, a job like
#49 below), the answer carries both: `notice` (the row's) and `run_notice` (the run's own,
whole, never truncated). The comparison first sets aside the lines the runtime itself
appends to the row's notice (the kept-worktree line, the abandoned-command warning, the
disabled-background escape) and trailing whitespace, so a row that only got one of those
lines appended never earns a `run_notice` of its own. They agree far more often than not,
in which case `run_notice` is simply absent - a missing or unreadable log leaves it absent
too, never an error: this is a pure read, no write, no network.

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
the first line of what each subagent says is printed in its lane (its own words are the
readable intent of the tool calls under it), `--all` is kept for compatibility and changes
nothing, and `--raw --all` together are a usage error.

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
delivered a pull request URL), `closed` (the operator closed a job out of any
terminal status - `done`, `failed`, `gate` or `cancelled` - with `nightshift
queue close <id>...` or `--merged`), `gate` (the pipeline stopped asking for a human decision - a recorded
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
`--json` carries `jobs[].pr_state` plus `suggestions`. A terminal job (`done`, `failed`,
`gate` or `cancelled`) whose pull request is merged is never changed by a read: the
listing adds one aggregated line - `#12 PR merged - close it with nightshift queue
close 12` for exactly one, `3 jobs have a merged PR (#12, #9, #7) - close them with
nightshift queue close --merged` for several - and closing it is the operator's act,
either by id or in one call with `nightshift queue close --merged`, which queries gh
only for what its own cache cannot already confirm, bounded to 10 pull requests and
one 20 s deadline per call. Closing a job, by id, with `--merged` or through the MCP
`queue_close`, also releases its worktree once the row is closed (see *Worktrees* below): the
text output adds `worktree removed: <path>` or `worktree kept: <path> - <reason>` right after
`closed job #N`, `--json` carries `worktrees` (`[{ id, path, status, reason? }]`, one entry per
closed job that had a worktree, `status` `removed` or `kept`), and `queue_close` answers
`worktree` (`{ path, status, reason? }`, or `null`). A kept worktree never fails the close. gh is never asked about more than four pull requests at once. A one-shot
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

**Worktrees.** A job's worktree lives as long as the job does. When a run ends `done`, the
runner removes the worktree its run recorded (`state.json` `worktree`) with a plain
`git worktree remove` from the project checkout - but only when it is clean (`git status
--porcelain` is empty) and its branch is published (it has an upstream and `@{u}..HEAD` is
empty) or a pull request is recorded. A lock left by a session whose pid is gone is lifted
first; a lock held by a live pid, or one with no pid, keeps the worktree. A run that ends
`gate` or `failed` keeps its worktree for the resume and for the session that attaches to it;
`nightshift queue close` removes it later under the same rule. A worktree nightshift would refuse
to remove - dirty, never pushed, ahead of its upstream, locked or unreadable - is named whatever
the ending: the line `Worktree kept: <path> - <reason>.` is appended after a blank line to the
notice that exists (the run's own, its fallback, or the notice the row already held when the
run produced none), never replacing it, and a resumed run replaces its own earlier line instead
of stacking it. A clean, published worktree kept only because the run stopped at `gate` or
`failed` is not named. Nothing is ever forced, no branch is deleted and nothing on the remote is
touched; ignored files inside a removed worktree (a local `.env`, build output) go with it.
`nightshift doctor` lists what is left under `.claude/worktrees/` with the command that cleans it
(see [Doctor](cli.md#doctor)).

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
the only ones. And a `PreToolUse` hook rewrites every `Agent`/`Task` launch of an
unattended run to `run_in_background: false` - it normalises the call, it never
blocks it. That is the shape of the rule: what has to happen on every run lives
in the runtime or in a hook with a test behind it, never only in the prompt of
the pipeline, because a sentence in a prompt covers only the wording it happens
to forbid and is lost the moment the platform underneath changes.

**The orchestrator of a job only coordinates, and the same hook enforces it.** Its
matcher is `Agent|Task|Bash|Read|Grep|Glob`; `nightshift doctor` warns (`registered
with an older tool matcher`) until `nightshift setup` rewrites an older one. For a call
of the orchestrator's own main thread - a payload with no `agent_id`; a subagent's call
carries one - inside a job (`NIGHTSHIFT_JOB_ID` set):

- `Read`, `Grep` and `Glob` are allowed only under the runs of the job home
  (`<home>/runs`) and a copy of the plugin (`NIGHTSHIFT_PLUGIN_DIR`, which the runtime
  pins on the child, the plugin of the running package and of the installed runtime, and
  the host's `plugins` directory), plus the file where the host spills a tool result too
  large for the context and tells the model to read it - of the calling session only:
  `<dirname(transcript_path)>/<session_id>/tool-results/`, both taken from the hook
  payload (with either missing, no spill directory is readable), never another session's
  and never the rest of the host's configuration. The counters apply the same rule, finding
  the transcript of each of the stream's own session ids under
  `<CLAUDE_CONFIG_DIR or ~/.claude>/projects/`. Paths are compared after
  `realpath`, so a symlink never smuggles the worktree in; a `Glob` pattern that climbs
  with `..` is refused.
- `Bash` is allowed only for the closed list: `git rev-parse`, `git worktree`,
  `git status --short|-s|--porcelain`, `git add`, `git commit` (never `--amend`),
  `git push` (never `--force`/`-f`/`--force-with-lease`/`--force-if-includes`/`--delete`/
  `-d`/`--mirror`/`--all`/`--prune`/`--receive-pack`/`--exec`, their `=value` form, a
  short-flag cluster carrying one, the abbreviation git accepts, nor a `+`/`:` refspec),
  `git fetch` (never `--upload-pack`), `git branch --show-current`,
  `git diff --stat|--shortstat|--name-only|--name-status` (never with `-p`/`-u`/`--patch`),
  `gh pr view|list|status|checks|create` and `nightshift run check|log|index-save|commit|pr`.
  Each is the bare program name followed by its subcommand: a path to the binary or a
  global flag before the subcommand (`git -C <dir>`, `-c`, `--git-dir`, `--work-tree`) is
  refused. A command carrying a newline or any of ``; & | ` < > $`` is refused: the skill
  never chains, substitutes or redirects.
- Anything else is denied (`permissionDecision: "deny"`) with a reason that starts
  `the orchestrator does not read the repository - hand the path to the coder / ask the
  verifier` and says where the call would have to go instead.

A subagent's call and any session outside a job take exactly the path described above,
untouched. The hook fails open: an error inside the check lets the call through rather
than block a job. The list lives in one frozen table (`src/queue/orchestrator-scope.mjs`).

**The runtime configures the host it spawns: a command finishes or dies in the
foreground.** Every `claude` child of a job also gets
`CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`, `BASH_DEFAULT_TIMEOUT_MS` and
`BASH_MAX_TIMEOUT_MS`, the last two from `queue.bashTimeoutS` (default
`{ "default": 900, "max": 3600 }` seconds, converted to ms). With background tasks off,
the CLI can no longer move a slow foreground command to the background and kill it later
as an orphan: the command that outlives its timeout dies where it runs and the agent sees
`Command timed out`, so a long command has to ask for a `timeout` parameter up to
`max`. That is why the default is 15 minutes and not the CLI's own 2: a test suite must
fit. With the variable set, the `Agent` tool no longer even offers `run_in_background`,
and subagents keep running in the foreground. The runtime's values always win over the
same variables inherited from the runner's own environment. The variable is effective
but not in the CLI's env-vars reference, so the runtime checks it: when a job's stream
still shows a task moved to the background, the runner log and the job's notice get one
line - `⚠️ the host moved a command to the background although background tasks are
disabled - the CLI may have dropped CLAUDE_CODE_DISABLE_BACKGROUND_TASKS`.

**Every job counts its host commands.** From the same stream pass that sums its tokens,
each job records `bash_timeouts` (tool results saying a command timed out),
`tasks_backgrounded` and `tasks_killed` (distinct tasks the CLI backgrounded or killed),
summed over its attempts. `queue status <id>` (human, `--json` and the MCP
`queue_status`) shows each only when it is not zero, and `nightshift doctor` sums them
over the last 20 finished jobs, warning when anything was backgrounded or killed.

**Every job counts what its orchestrator did itself.** From the same stream, reading
only the orchestrator's own events (a subagent's carry `parent_tool_use_id`), each job
records, summed over its attempts:

- `orch_turns` - distinct assistant messages (by `message.id`);
- `orch_reads` - `Read`/`Grep`/`Glob` calls whose target is outside the roots the hook
  above allows (the run, the plugin, the host's tool-result spill); 0 is healthy;
- `orch_bash` - every `Bash` call;
- `orch_bash_explore` - the `Bash` calls outside the closed list; 0 is healthy;
- `orch_ctx_last` - input + cache read + cache creation tokens of the last orchestrator
  turn that reported usage (the context it ended with; the last attempt's wins).

A call is counted on the `tool_use` itself, so one the hook denied still counts: the
regression shows even while it is blocked. Tool calls are deduped by id and a line
quoted inside a code fence is never read as an event. `queue status <id>` (human,
`--json` and the MCP `queue_status`) shows all five, zero included - only a job finished
before the counters existed leaves them out. `nightshift doctor` prints one
`orchestrator` row summed over the last 20 finished jobs (with the average last context
and how many of them were measured), warning when `orch_reads` or `orch_bash_explore` is
above zero. Baseline measured on 2026-09-21, before the contract: 49 turns, 4 reads,
35 Bash of which 17 exploration, last-turn context 195k per job.

**A job's environment is isolated by default.** A job sees only this package's own MCP
server, plugin and hooks, plus the project's own `.claude/settings.json` and
`CLAUDE.md` files - never the operator's own MCP servers, plugins, skills, agents or
user hooks, and never the operator's own `CLAUDE.md` (measured on a real operator
install: 39 MCP servers, 95 skills and 20 agents before, 1, 21 and 11 after; the
orchestrator's first turn went from ~114k to ~68k tokens, paid again on every turn). The child gets `--strict-mcp-config
--setting-sources project,local`, which on its own would still re-import
`<claude config dir>/CLAUDE.md` through the ancestor walk, plus a `--settings` payload
carrying this package's own four hooks and a `claudeMdExcludes` entry that removes it.
`queue.inheritUserEnvironment: true` is the escape hatch back to the old, unfenced
behaviour, for an operator who wants a job to see everything a foreground session
sees; there is no per-server allowlist - it is all or nothing. `nightshift doctor`
reports which mode is in effect: `job environment` is `ok` when isolated, and warns,
naming the config key, when a job inherits the operator's own environment.

**`baseline_ctx` measures what a run started with.** The first assistant turn of the
orchestrator (never a subagent's) carries the input, cache-read and cache-creation
tokens already loaded before the run does anything of its own - the system prompt, the
tools, the skill, the injected context and the project's `CLAUDE.md`. Each job keeps
the reading of its first attempt that started fresh; an attempt spawned with
`--resume` records none, because its first turn carries the resumed history, and `queue status <id>` (human, `--json` and the
MCP `queue_status`) shows it the same way it shows `bash_timeouts` - present only once
a run recorded one.

**A new process is born from the current runtime.** A detached runner is launched from
the installed current runtime (`runtime/current`) whenever one exists - never from the
tree of the process that asked for it - and its registration names that tree, which is
what the install guard and doctor read. A long-lived MCP server started before an install
would otherwise spawn every new runner on the superseded version; it now only warns, in
the hints of `queue_status`, `queue_run` and `queue_add`: `this MCP server runs a
superseded runtime (<its version dir>) - restart the MCP client to load <current>`. Only
a dev checkout or a test, with no runtime installed, spawns from its own tree. An install
still never swaps the tree under a live process.

**A kill fails the run only when it ended it.** The CLI's own wait ceiling still exists
(the hook above only keeps a *subagent* launch foreground; a Bash call the CLI itself
backgrounds, or the Bash tool's OWN timeout moving a foreground command there, could
still be killed later; with background tasks disabled on the host, above, this is the
fallback for a CLI that ignores the variable). A kill is TERMINAL - `failed`, never a gate, never retried -
when either the raw ceiling line is in the log (it literally says "terminating"), or no
`result` event carrying a `## Notice` ever followed the kill AND `state.json` recorded no
outcome of its own. Job #28 is the terminal case: the ceiling line, then an unrelated
final line - `failed`. A kill that did NOT end the run - the agent noticed, moved on and
settled its own outcome hundreds of lines later, PR opened, `## Notice` written - is job
#49's case: it classifies exactly as if the kill had never happened (`done`/`gate`/`failed`
from the run's own record), with one line appended to whatever notice results, never
replacing it: `⚠️ a command was abandoned mid-run: <command, truncated to 120 code
points>`. Either way the notice of a TERMINAL kill says only what the stream proves:
`after its wait ceiling` only with the raw line, `; the run did not finish` only with no
settling `## Notice`, and a hint naming what happened to the killed Bash call - launched
with `run_in_background: true` (the hook should have caught it) or moved to the
background by the Bash tool's own timeout (a hung test, most often - size test commands
with `timeout <seconds>`) - never both.

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

**What it does NOT do in v1.** The runner never merges anything and never closes the
cycle after the pull request on its own - that is `nightshift queue ship`, an operator
command (see *Shipping a job* below). It keeps no token budget, ships no launchd (or any other)
scheduler, sends no notification and has no cockpit. It also never changes the
state of a git repository: the only git commands it runs are reads of the
checkout, and every branch and worktree is created by the pipeline itself.

### Shipping a job

**A ship takes a `done` job's pull request from open to merged and closes the job.**
`nightshift queue ship <id>` (and the MCP `queue_ship`) runs a code pipeline of four
steps in the command's own process - never an agent, never a second job, never queue work:

1. **preflight** - `git fetch origin` in the project's checkout (a failed fetch is not a
   stop: `WARNING: git fetch origin failed (...)` is prefixed to every later step note),
   then the pull request is read with gh. A closed one stops the ship; one that is already
   merged is recorded as merged and nothing else is checked. Otherwise the checks must be
   green - a red or a pending check stops the ship naming it, and it never waits for one.
   Uncommitted files in the checkout only stop it when the pull that follows the merge
   would touch them (`checkout-dirty` names up to ten): nightshift never stashes, so they are
   yours to commit or stash.
2. **conflict** - skipped when GitHub reports the pull request mergeable. When it conflicts,
   the head branch is rebased onto the base in a throwaway worktree (its own temporary
   directory, with the checkout's `node_modules` linked in), the project's `npm test` must
   pass there, and only then the rebased head is pushed with
   `--force-with-lease` against the head the ship read. A rebase that stops on real
   conflicts is aborted and the ship stops with `real-conflict` and the conflicted files -
   a ship never resolves a real conflict. The throwaway worktree is removed whatever
   happens.
3. **merge** - `gh pr merge --squash --match-head-commit <the verified head>`, never
   `--delete-branch`, `--admin` or `--auto`. gh's exit code is never the evidence: the pull
   request is re-read until GitHub reports it merged with its merge commit, and that
   commit is what is recorded. Afterwards the checkout is fast-forwarded with `git pull
   --ff-only` only when it sits on the base branch; the result is noted, never a failure.
4. **settle** - closes the job and appends `Shipped: PR #<n> merged as <sha7> on
   <YYYY-MM-DD>` to its notice (after a blank line, never replacing it), in one write; the
   job's worktree is then released by the same rule as `queue close` (see *Worktrees*).

The job's status is untouched until settle: a ship that stops leaves it `done`.

**The checklist lives on the job.** Each step writes its result to the job row as soon as it
settles: `ship_status` (`shipping`, `shipped` or `failed`) and `ship`, a checklist with the
attempt count, one entry per step (`done`, `skipped` or `failed`, a note and the time) and
the data the steps read (pull request number, head, merge commit). `queue status` shows it:
the STATUS cell gains ` · shipping`, ` · shipped`, ` · ship failed` or ` · ship stalled`,
`SLUG/LAST` names the current step or the stop, and `queue status <id>` prints the whole
checklist under the status line; `--json` and the MCP `queue_status` carry `ship_status`,
`ship_worker`, `ship_lease_until` and `ship`. A ship that stops prints, in the listing, the
detail and the queue's hint lines,
`⛔ ship stopped at <step>: <reason> - run again with: nightshift queue ship <id>`, and a ship
in flight adds `ship in flight: #<id> at <step> (pid <pid>) - follow with: nightshift queue
status <id>`. `nightshift doctor` has a `ships` row that warns on a failed ship or one whose
lease expired.

**Running it again resumes it at the step that failed.** A step already `done` is not run
again, and whether the merge happened is decided by the merge commit recorded from GitHub -
never by a step status - so a ship that stopped after the merge never merges twice. A merge
that finds the pull request conflicted again, or its head moved, reopens the earlier steps
it depends on.

**The lease is only a mutex.** Starting a ship takes a lease on the job, in one atomic
update, so two ships of the same job never run together: a second start is refused
naming the ship that holds it and until when. The lease lasts the ship's timeout plus 60 s
and is renewed on every checklist write; a lease that expired (the process died or passed
its timeout) shows as `ship stalled` and is taken over by the next `queue ship`. The ship
claims nothing: it holds no job lease and never changes what a runner may pick up.

**Detached by default.** `nightshift queue ship <id>` starts a child and returns at once
with `ship of job #<id> started (pid <pid>) - follow with: tail -f <log> (log: <log>), or
nightshift queue status <id>`; the log is `<home>/logs/ship-<id>-<stamp>.log`, and `--json`
prints `{ started, jobId, pid, logPath }`. The child registers as a runner of mode `ship`, so
`queue status`, doctor and the install guard see it live, but a pending job is never
promised to it. `--foreground` runs the steps in this process, prints one line per step and
a final `job #<id> shipped: PR #<n> merged as <sha7>; job closed` (plus what happened to
the worktree) or the `⛔ ship stopped ...` line, and exits `0` only when the job shipped;
with `--json` it prints one `{ job, outcome }` object and nothing else on stdout.
`queue.shipTimeoutS` (default `600`, accepted range `60..3600` seconds) is the hard
timeout of the whole ship; a ship that passes it, or that `queue run --stop` ends, stops
with `timeout` or `interrupted` and resumes on the next run.

**What it ships.** Only a `done` job with a GitHub pull request URL of a registered project
whose checkout exists. `--force` (`force: true` over MCP) ships a `failed` or `gate` job
that carries a pull request, and says so first. `closed`, `running`, `pending`,
`cancelled`, a job without a pull request and a job another ship holds under a live lease
are refused by name, and nothing is written. An unattended run never ships: inside a job
the command and the tool are refused.

**What it never does.** It never stashes, never deletes a branch (`--delete-branch`),
never resolves a real conflict, never retries the run that produced the pull request and
never ships on its own - the operator decides when to ship. Ships of one project share its
checkout (the fetch, the throwaway worktrees, the pull), so they are best run one after
the other; a collision fails the ship safely (`fetch-failed`, `worktree-failed`) and it
resumes on the next run.

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

