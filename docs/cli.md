# CLI, configuration and doctor

`bin/nightqueue.mjs` is the CLI: it manages orgs, projects and the connections (and
their secrets), and it drives the memory runtime.

- `nightqueue --help` lists every command: `setup`, `doctor`, `init`, `org`,
  `project`, `update`, `connection`, `mcp`, `hook`, `embed`,
  `memory`, `queue`, `open`, `verify`, `sandbox`, `libs`, `run` and `version`.
- `nightqueue --version` (same as `nightqueue version`) prints the installed version
  and exits `0`.
- Exit codes: `0` ok, `1` user error (a single line on stderr), `2` unexpected
  error (a stack on stderr). `nightqueue doctor` and `nightqueue verify` also
  exit `1` when a check fails.
- Every `list` accepts `--json`; on `--json`, stdout is either valid JSON or
  empty, because warnings and errors always go to stderr.

The queue lives in `nightqueue queue` (see [Queue](queue.md)); the scheduler that would
start it by itself lands in a future version, published as the npm package
`nightqueue`, of which this plugin is the pipeline half.

## The run of a job (`nightqueue run`)

`nightqueue run` is the family the pipeline calls from *inside* a job: each
subcommand acts on the run of the job it is called from, which it resolves from
`NIGHTQUEUE_JOB_ID` and that job's own row. It is not `nightqueue queue run`,
which starts the runner over the whole queue. Naming another run from inside a
job is refused; outside one, `--project <name> --slug <slug>` is required.

```sh
nightqueue run dir            # the absolute directory of this run: runs/<project_id>/<slug>
nightqueue run check 03       # is the plan there, with the sections the pipeline reads?
nightqueue run check 05 --stage triage   # how much QA does this change get? QA-MODE: skip|lite|full
nightqueue run log            # one line per phase of this run, plus the total
nightqueue run log --json     # the same table as the only thing on stdout
nightqueue run pr --template                   # print and record the PR template in effect
nightqueue run pr --body-file body.md          # check the body, push and open the pull request
nightqueue run start                           # the run's agent models and phases, as JSON
nightqueue run start --routing                 # the default agent model table, as markdown
nightqueue run publish --message-file msg.txt --body-file body.md      # check the body, commit once, push and open the PR
nightqueue run publish --message-file msg.txt --body-file body.md --draft   # the same, as a draft PR that lists what still fails
nightqueue run report                          # the tables of the final report, from the run's own records
```

`run start [--type <bug/error|feature/refactor>] [--commit-type <c>]
[--expect-slug <slug>]` is Phase 0's mechanics in one call. `--type` and
`--commit-type` are optional (the shipped plugin passes neither: `run check 01` records
both from the triager's Brief) and validated only when given. It refuses a type or a
commit type outside the pipeline's own (naming the accepted values), and refuses
`--tier` with ``\`--tier\` was removed: every run executes the one pipeline; run
`nightqueue run start` without it`` (there is no risk tier: every run executes every
phase). It records the `type` when given in `state.json` (the same write as `run_set`)
and the pull request template in effect (the same as `run pr --template`), and prints
one JSON line: `project`, `slug`, `runDir`, the `worktree` and `branch` the runtime
recorded, `type` (the recorded one, else the requested
one, else null), `commitType` (the requested one, else the recorded one, else null),
`models` (`{<agent>: <model>}`, the defaults of `src/queue/routing.mjs` with the
project's overrides of `project models` applied; a store that cannot be read answers
the defaults and says so on stderr), `orchestratorModel` (the alias the project routes its orchestrator to, `default` when none), `needsSlug` (whether the run still holds the slug the runtime
derived), `demoRepo` (or `none configured`), `baseRef` (`HEAD` plus a stderr line when no base
branch resolves), `pluginRoot`, `stages` (the numbered stages of `00-brief.md`), `drafts` (the `commit-message.txt` and `pr-body.md` kept
for a run that recorded Phase 6 or 7; any other run's are deleted), the `phases` (every phase of the one
pipeline; there is no `tasks` field), `prTemplate`, `commitConvention` and `commitTemplate`
(`{source, path, label}`: the commit message template in effect, first match wins - `config`,
git's own `commit.template` read in the run's checkout when it names an existing file; `repo`,
the repository's convention file (`.gitmessage` gives `path`); else `nightqueue`, the fallback
of `plugin/skills/resolve/references/commit-template.md`, `path` null). With `--expect-slug`,
inside a job, it waits up to 10 seconds for the runner to bind the slug the
orchestrator of an older plugin just declared (`SLUG: <slug> TYPE: <type>`) and answers `slugDeclared`
and `slugBound`; it never renames anything itself. Inside a job it reads the worktree
the runner placed and calling it again answers the same JSON. Outside a job it places the
run's worktree like a job's (`<home>/worktrees/<project id>/<slug>` on `worktree-<slug>`,
from `origin/<default branch>` after a fetch, else `HEAD`) and records it before answering;
a slug whose worktree slot or run directory is taken moves to the next free one (`<slug>-2`
to `<slug>-9`), so a second call on the same name opens a new run and the answered `slug`
and `runDir` are the run's; a run that already recorded a phase resumes under its own slug; a
checkout with no commit gets no worktree, with a stderr line, and the run works in it; a
registered checkout that no longer exists is refused. `run start --routing` takes no other option: it prints the default agent
model table of `src/queue/routing.mjs` as markdown (`| Agent | Model |`, one row per
agent), and resolves no run and writes nothing, inside a job or outside.

`run publish --message-file <p> --body-file <p> [--files-from <p>] [--extra
<pathspec>]... [--title <t>] [--draft] [--remove-worktree]` commits the list and opens the pull request in
one call, in the safe order: the commit message is checked against the commit template
in effect (the `commitTemplate` of `run start`), then the body against the pull request
template in effect, then the list is checked for refused paths and scratch files, and only
then is anything committed - any problem prints its `MISSING:`/`REJECTED:`/`REFUSED:`
lines and `nothing was committed or pushed`, and exits `1`. Each message violation is one
`REJECTED: commit message — <reason>` line, printed first. Under every template: an empty
subject or one starting with `#`, a body whose line 2 is not blank, a line starting with
`Co-Authored-By:` (any case; prose that mentions it passes) and a `Refs:` line are rejected;
under the `nightqueue` fallback only, a subject that is not Conventional Commits
(`<type>(<scope>): <subject>`) is rejected too. Under a `config` or `repo` template the
repository's own hooks judge the rest on `git commit`. Once the pull request is open, the
command records the `commit` phase (`verdict: "PR opened"`, `by: "runtime"`) in
`state.json`; `run pr` does the same. A retry after the commit
already happened (every listed path clean and the branch ahead of its base) prints
`COMMITTED: <sha> (already committed)` instead of committing again. The title is
`--title`, else the body's `# <title>` line, else the subject of the commit message.
It prints the same `CONVENTION:`, `COMMITTED:`, `BRANCH:`, `PR:` and `WORKTREE:`
lines as the two commands. The run's own wip commits fold into the single delivery commit
with the listed paths, printing `FOLDED: <n> wip commits (<m> files)` and any path left out with
its reason; the wip ref keeps naming the old commit. A `wip(` commit that is not the run's own,
and any commit above an own one, is refused with a `REJECTED:` line (see the runtime contract).
The push records the files of HEAD as `outcome.files`.

A run whose `state.json` holds `qaMode.mode` `skip` owes the plain line
`QA: skipped — <state.qaMode.reason>`, outside fenced code and HTML comments. The text comes from
the state, so a body without it or with another reason prints `REJECTED: the QA of this run was
skipped, so the body carries this exact line under its test section's heading: <line>` and nothing
is committed or pushed. The template's rules do not read that line, so a word of its reason never
blocks the body. `lite`, `full` or no `qaMode` owe nothing. `run pr` does not enforce this line.

`--draft` is how a run that reached its fix limit still delivers. The body lists each failure
on a plain `Remaining failure: <what>` line outside fenced code and HTML comments, and those lines
are the only source of the count: a `--draft` with none prints `REJECTED: a draft pull request
lists each failure on a Remaining failure: <what> line of its QA/verification section`, and nothing
is committed or pushed. The pull request opens with `gh pr create --draft`; when the branch already
has one, its body is replaced and `gh pr ready <url> --undo` converts it. A draft prints `DRAFT:
draft pull request — N failures remain` (`1 failure remains`) after `PR:`, records the `commit`
phase with the verdict `Draft PR opened`, and writes `outcome.draft: true`,
`outcome.draftFailures: N` and the top-level `draftPrUrl`. When gh refuses the draft, on either
path, the run still delivers: a refused create is retried once without the flag, gh's reason goes
to stderr, `outcome.draftFailures: N` is written with no `outcome.draft`, and `run report` reads
`Happy: no — pull request — N failures remain (gh refused the draft)`. When the retry fails too,
the command names gh's reason, exits non-zero and the branch stays pushed. Without the flag, the
one change is on a run's own draft: an existing pull request named by `draftPrUrl` is turned ready
with `gh pr ready <url>` and prints `READY: <url>`; when gh refuses, stderr says `<url> stays a
draft: <reason>`, and `outcome.staysDraft: true` adds that line to the report's open items. Any
other pull request is left alone, and a draft a person set stays one. A run's own draft whose body
still lists such a line is not turned ready and not refused: it stays a draft, the `DRAFT:` line adds
`(stays a draft: the body still lists a Remaining failure: line)`, and `outcome.draft: true` and
`outcome.draftFailures: N` are written. `run pr` has no such flag, but it shares both rules for a
run's own draft. A text counts as a failure when it holds a word and is not wholly one of `none`,
`nothing`, the placeholder words (`n/a`, `TBD`, `TODO`) or a `<what>` hint, so `[a.test: 3 failing]`
or `TODO: flaky e2e` count and `<what>`, `none`, `n/a`, `-` or symbols alone do not.

`run report [--json] [--facts]` renders the table of Phase 9 from `state.json`, the job log
and `03-plan.md`: ONE table, `Step | Agent | Result | Note | Time`, one row per execution
recorded in `state.json` in the order recorded (a re-run of a phase is its own row, its Step
suffixed `🔁N`), plus one row per planned step with no record at its nominal position
(`⚠️ not recorded`; `⏭️ purely static change` for the runtime phase after a PASSED
verification; `8 Commit/PR` reads the recorded delivery; a last `9 Report` row that is
always `⏳ this report` and never counts against Happy). `Result` is the status icon plus
the verdict word; `Note` the reason and note recorded, `-` when empty; `Time` the measured
duration, `-` when none. A QA the triage skipped reads `| 5 QA | 🛡️ QA-Guardian | ⏭️ | no new
risk: <why> | <time> |` and does not turn the run non-happy; a `qa` `SKIPPED` with no recorded
`qaMode` of `skip`, and a `SKIPPED` verdict of any other phase, stay `⚠️`. The `8 Commit/PR` note of a draft reads `draft pull request <url> — N
failures remain`. Then the `**Total:**`, then a `Happy: yes|no — <first failing
gate>` line decided by the fail-safe rule (failures a pull request leaves open, a termination, a
failed verdict, a re-run, a planned phase never recorded, a plan whose
`## Requires user confirmation` holds a filled question the run recorded no pause on, no delivery
recorded), and last a `## Open items` section: the line naming the failures a pull request leaves
open, `pull request <url> stays a draft` when gh would not turn it ready,
one `- <item>` line per `dedicated ticket:
yes` suggestion of the last QA round (`dedicated ticket: <suggestion>`) and per `OPEN:`
line `run check 03`/`05`/`07` would print (`03 open: …`, `05 open: …`, `07 open: …`), or `- none`. The layout
it fills is `plugin/skills/resolve/references/report.md`, rendered by the skill's template
engine; the orchestrator never reads that file, it pastes the output. The
command also records the run's telemetry (the row `pipeline_log` used to write), in both
modes: the phases come from `state.json`, the outcome and the gate stop are derived from
it (`pr_opened`, `local_commit` or `no_commit`; `user` for a gate, none for a
`NO-CHANGE-NEEDED` run, else the terminated or failed phase), and inside a job a run
already recorded in this attempt is not recorded twice; outside a job, or in a job with no
recorded attempt start, a run whose last record carries the same outcome and phase count is
not recorded twice. The telemetry row decides nothing about how the job ends. `--json` prints `rows` (objects with `phase`, `step`, `agent`,
`launch`, `icon`, `word`, `note`, `durationS`), `happy`, `reason`, `durationS`, `openItems`
and `recorded` (`recorded`, `already recorded`, `queued` when the database is unavailable,
or `not recorded: <reason>`). A failed
record is the fixed open item `the run was not recorded in the telemetry` (the reason stays
only in `recorded`), never a non-zero exit.

After the report comes `## Facts for the report`, what the orchestrator would otherwise have to read
from the run's artifacts, and it is never pasted into the final text. `--json` carries it as `facts`.
Each list line is clipped to 220 characters and each list holds its own limit, ending in `+N more`,
so one artifact cannot push another's facts out (at most about 227 lines): first the runtime's
`orchestrator: <alias|default> (<init model>)` line (the route the job's last attempt row recorded, else
`default`, and the model the last attempt's `system/init` reported in the job log); the Brief's expected
outcome and commit type; 6 lines of the validated brief; the triager's diagnosis (the root cause
first, a long line spanning up to 3 lines); the plan's `not-covered` rows; the QA mode; the last QA
round's verdict, breaks, risks, PoCs, prevention and `dedicated ticket: yes` items; the last
verification round's verdict, checks, failures and diff-hygiene finding; the last runtime round's
verdict, `NOT MET` rows and device script; the plan's decisions; the evidence files; the files changed
outside `## Modified files`, since Phase 8 decides on each: test files first, at most 30 lines, each
path whole up to 512 characters, a longer one keeping its file name, and past 30 one more line saying
how many are held back, which `git status --short` shows; the implementation's files (by name up to 15, past that `Modified files: <area> (<n>
files)` lines whose counts add up to the whole list); the plan's `**Files to create/modify:**` lines
and the implementation's `## Left`. A missing artifact is one `<file>: missing` line, and a git that
cannot answer one `Changed outside the list: unknown, git answered nothing` line: neither fails the
report nor changes what it records. `--facts` prints that section alone (`--json`: `{facts}`) and
records nothing, for Phase 8, which runs before the report.

`run check <NN> [--stage analyst|triage]` confirms the artifact of a phase: it reads
`<RUN_DIR>/<NN-phase>.md` and prints `OK`, or `MISSING: <file> (not written)` when the artifact
(for a round artifact, the round read) is empty or absent, or `MISSING: verdict (one of: <words>)`
when the step has verdict words (`01`, `05`, `05 --stage analyst|triage`, `06`, `07`) and the
artifact states none of them. No section, field or format is required: method and report format
are the agents'. `05`, `06` and `07` are append-only, one `## Round <n>` per launch, and are read
on their LAST `## Round` (`05 --stage triage` on the last `source: qa-triage` round), so an earlier
round's verdict never passes a later launch; a `## Round` heading inside fenced code is never a
round, and a file with no round heading is read whole. A round artifact that ends inside an open
code fence is repaired first — the check appends the fence's own marker as the last line and
prints `REPAIRED: the code fence of round <k> opened at line <X> of <file> never closed; the
runtime appended `<marker>` at line <Z>` right after its first line. `04` is the only artifact with
a fallback: with no file list, the command derives one from the changes of the run's worktree
(`git diff --name-only HEAD` plus `git ls-files --others --exclude-standard`) and from what the
run's own wip commits would carry into the delivery, writes it to `04-files.generated.md`, never
over `04-implementation.md`, and prints `GENERATED` - and a worktree with no change at all and no
wip to fold prints `MISSING: ## Modified files (no changed files)` without writing anything. The
three answers exit `0`: they are findings the last line routes, `NEXT: <action>` (`launch`, `gate`,
`terminate`, `publish`, `report` or `check`; `docs/runtime-contract.md`), not failures of the
command; only an unknown `<NN>`, a stage other than `05 --stage analyst|triage`, a retired id of
the old numbering (`renumbered: use <NN>`) or a run that cannot be resolved exits `1`. In a full QA,
`run check 05` first writes the consolidated round (`source: runtime consolidation`) of the
analyst's and the provers' rounds and answers over it (see [Runtime contract](runtime-contract.md),
"The QA consolidation is the check's own").

After the first line the check prints, one fact per line under a stable prefix and in this order:
`VERDICT: <word>`, read tolerantly from a verdict heading, a `Verdict:`/`Verification:` labelled
line or the first line under a verdict heading; `CONFIRM: requires-user-confirmation — <question>`
or `CONFIRM: answered (<at>)`, once an answer was recorded after the pause on that question (`03`,
only with a filled question); `QA-MODE: skip|lite|full — <why>` (`05 --stage triage`, with
`stated by the QA triage` when the round gives no reason); `QA-STAGE: provers|skip`
(`05 --stage analyst`); `NEEDS-DEVICE`; `index: …` (`02`); the `recorded: …` lines; and `SCRIPT:`
followed by the device script, always last. A `MISSING:` first line prints nothing else but a
`REPAIRED:` line. The check acts on what it found: on a complete phase it records `phase_done`
itself (`recorded: phase_done <phase> <verdict>`, with the reason of a re-run), `02` saves the
File map into the project index (`index: saved N files, M libs` or `index: not saved (<reason>)`,
which never changes `OK`), `01` records the Type (`recorded: type <type>`), writes the Brief into
`<RUN_DIR>/00-brief.md` (`recorded: brief 00-brief.md`, or the whole triage when it has no
`## Brief`), records the commit type when the Brief states a valid one (`recorded: commit type
<c>`), the termination of a terminal verdict (`recorded: run_terminate triage <VERDICT>`), and,
last, the slug (`recorded: slug <slug>`, or `(renamed from <old>; run dir <path>)` when a job run
still on its provisional slug takes the Brief's `**Slug:**`); a missing or odd Brief field never
fails the check. `05 --stage analyst` records no phase. `05 --stage triage` records the decision
(`recorded: qa_mode <mode>`, `(already)` when the same mode stands, however it is worded) and, only
on a `skip`, the `qa` phase with the verdict `SKIPPED`, once while it is the phase's last entry; a
`lite` or `full` decision removes that `SKIPPED`, and its QA records its phase through `05`. The
only human stop of a run is `CONFIRM: requires-user-confirmation`. The completion rule and the
record semantics are in [Runtime contract](runtime-contract.md) ("The artifact check confirms the
artifact and its verdict").

`run append 05 --group <id>|--group-label <label> --from <file> [--project <name> --slug <slug>]` appends one prover
round to `<RUN_DIR>/05-qa.md`: it numbers the round from the file under the run lock, writes it
atomically and prints `APPENDED: ## Round <n> to <path>`, so provers that append at the same
time never lose a round nor share a number. The runtime stamps the round's first line
`source: prover · group: <id>` itself (a `source: prover…` line of the draft is dropped), so the
group a later round supersedes is never read from what the lane wrote; `<id>` is given
(`^[a-z0-9][a-z0-9-]{0,63}$`) or derived from `<label>`, the same label always giving the same id.
It refuses a check other than
`05`, a missing or invalid `--group`, a blank `--group-label` or both flags together, a missing `--from`, an empty draft, a draft with a
column-0 `## Round` line (fenced or not), a draft that leaves a code fence or an HTML comment
open (naming its line), and a consolidated round. When an earlier round left a code fence open,
it closes that fence first and prints the `REPAIRED:` line before `APPENDED:`. It writes the
prover's `H<n>: REFUTED` lines of `## Validated risks` in the canonical `H<n>: HELD (REFUTED)`
form and keeps `H<n>: PROVEN` as written: the aggregate reads it as `BROKE`, or as `HELD` on a
`type=regression` hypothesis (a passing regression net).
Only a prover lane runs it; the orchestrator's closed Bash list does not allow it.

`run log` prints one tab-separated line per phase recorded in `state.json` -
`<phase>  <model>  <status>  <duration>` - and closes with `total  <duration>`.
The model and the durations are the ones the runtime measured on the stream of
the job (see [Runtime contract](runtime-contract.md)), so the agent pastes the
Time column of its report instead of timing the phases itself; a phase the
runtime measured no lane for prints `-`.

`run commit` was removed, and answers one line naming `run publish`. `run publish` stages exactly the paths `04-implementation.md` listed under `##
Modified files` (`04-files.generated.md` when the artifact lists no file; `--files-from <path>` reads the list somewhere else) plus every
file a `--extra <pathspec>` really matches, and commits them with `git commit -F
<the --message-file>` - the message stays the agent's, and an empty or missing
one is refused before anything is staged. A message that carries a `Refs:` line is rejected. It prints `COMMITTED: <sha> (<n>
files)`. Anything under
`.claude/` or `tmp/`, a dependency lockfile that is not paired with a changed
manifest and a green frozen install (see the runtime contract) and any path
outside the run's worktree is refused: the command prints `REFUSED: <path> (<reason>)`, stages
nothing and exits `1`. `--extra` adds files to the list, it never overrides that
refusal. Before committing it prints `CONVENTION: <...>` - the file that
declares the repository's commit convention (a commitlint config, `.husky/`,
`.gitmessage`, `CONTRIBUTING*` or a `commitlint` block in `package.json`) and
what the last 30 subjects really read like - so the message is written to the
shape the repository uses. It folds the run's own wip commits and refuses a foreign one, and `run pr` refuses a branch still carrying a wip commit, naming
`run publish`.

`run pr` first resolves the run's checkout and finds the pull request template
in effect there, first match wins: `.github/PULL_REQUEST_TEMPLATE.md`,
`.github/pull_request_template.md`, `docs/PR_TEMPLATE.md`, then a pull request
section of `CONTRIBUTING.md` or of `CLAUDE.md` (the first fenced markdown block of
that section carrying headings). It prints `TEMPLATE: repo (<path>)` or
`TEMPLATE: nightqueue (fallback)` and `HEADINGS: <headings>`, and records them as
`prTemplate` in `state.json`; `--template` stops there, reads no body and pushes
nothing. Then it checks the body BEFORE anything leaves the machine, with the
rules of `references/pr-template.md`. Against a repository template: every heading
of it present and in its order, and no nightqueue heading (`## Report`,
`## Cause`, `## Changes`, `## QA`) the template does not have. Against the
nightqueue fallback: `## Report`, `## Cause`, `## Changes` and `## QA` in that
order with no fifth `## `, a `## QA` made of `###` subsections (`Automated`,
`API`, `Browser`, `Device`) with at least one `- <what ran> — <result>` bullet each,
the result ending in `PASSED`, `FAILED` or `SKIPPED (<reason>)` (none marked
`N/A`, no table), a `Not tested:` line after the last one, and a non-empty file
under `<RUN_DIR>/evidence/<method>-*` (`automated`, `api`, `browser`, `emulator`)
for every subsection. Both: no bare `#<number>` outside a `Fixes`/`Closes` line, no
`{{placeholder}}` or `<...>` example left over from the template, and none of the
traceability the runtime appends itself - an `Opened by nightqueue` line, a whole
`Refs` line, a job ref or the run slug. It then publishes a copy of the body with
the footer `Opened by nightqueue · J-<n>` inside a job, plus ` · <kind> <ref>` for every
origin of the job in stored order (e.g. `Opened by nightqueue · J-12 · linear MK-42 · sentry
4507`), and `Opened by
nightqueue` outside a job (see
[Runtime contract](runtime-contract.md)). A body that
fails prints one `REJECTED: <reason>` or `MISSING: <what>` line per violation
and exits `1` with nothing pushed. Otherwise it renames the branch
when it still carries the `worktree-` prefix (`worktree-feat+login-google` →
`feat/login-google`; a queued job's `worktree-<slug>`, which carries no `+`, becomes
`<commit type>/<run slug>` with the type read from the Conventional Commits subject of
`HEAD` - `worktree-login-google` with `refactor(auth): ...` → `refactor/login-google` -
falling back to `feat` or `fix` from the `type` in `state.json`; a name that already exists locally moves to its next free `<name>-<n>`), pushes it with `git push -u origin <branch>`, opens the
pull request with `gh pr create` and records in `state.json` the outcome `done`,
the pull request URL gh answered and, as the run's `branch`, the name it pushed
(a record it cannot write is reported on stderr, never fatal: the pull request is
open). The `PR: <url>` line it prints is information only - the pull request of the
run is the host's publication when it is on the run's branch, otherwise the one this
command recorded (see [Runtime contract](runtime-contract.md)). It closes with `WORKTREE: <path>` and
removes the worktree only when asked with `--remove-worktree`, because the
session that called it still lives in that directory. That default is unchanged:
in a queue job the runner itself removes a clean, pushed worktree once the run ends
`done`, `nightqueue queue close` removes it once the job's pull request is merged, and
`nightqueue queue cancel` removes it for a `done`, `failed` or gated job the operator gives up on
(see [Queue](queue.md)).

## Configuration

`NIGHTQUEUE_HOME` (default `~/.nightqueue`) is a single directory that holds
both the configuration at its root and the run artifacts under `runs/` (see
[Runtime contract](runtime-contract.md)) - one home, two kinds of content, not two environment
variables:

```
$NIGHTQUEUE_HOME/          # 0700
  config.json              # queue settings, connection bindings by org id, default org
  secrets.json             # 0600, connection secrets
  nightqueue.db            # the memory database, orgs and projects included (see [Memory](memory.md))
  runtime/versions/        # one directory per installed version, the last two kept
  runtime/current          # symlink into versions/, what the host is registered against
  bin/                     # the shims: nightqueue and nq
  embedding/               # npm prefix of the embedding library, opt-in
  models/                  # embedding weights, downloaded on demand
  state/                   # per-session hook state
  runs/<project_id>/<slug>/  # run artifacts, written by the runtime
  logs/                    # one log per queue job plus one per runner
  queue.paused             # sentinel file, present only while the queue is paused
  runners/<pid>.json       # one registration per live runner, any number of them
```

Orgs and projects are rows of the memory database, each identified by an id
(a ULID) and carrying a name that can change: every job, lesson, memory and
run directory points at the id, so a rename touches one row. `config.json` keeps
only what is not identity - the queue and embedding settings, the connection
bound to each org (`orgConnections`, keyed by org id) and `defaultOrg` (an org
id) - and any top-level key it does not know is kept as it is. A home written by
an older build migrates once, in `nightqueue update` (or `setup`), never on an open: the
orgs and projects of `config.json` move into the database, `runs/<project>/` is
moved to `runs/<project_id>/`, and a copy of the database as it was is left
beside it as `nightqueue.db.pre-v18`. While a runner holds a live lease on a job
the migration refuses and asks to stop the runners first
(`nightqueue queue run --stop`); nothing is written until it succeeds. A v18 database
then goes to v19 the same way, in the same migration, with its own copy
`nightqueue.db.pre-v19`: every project and org gets a key (below), and every issue
gets its number within its owner, in the order the issues were created.
A v19 database then goes to v20 in the same migration, with its copy
`nightqueue.db.pre-v20`: every reference to another row gets a foreign key, and a
row pointing at a row that does not exist refuses the migration, naming the row,
with nothing written - checked before the first pending step, so an older home
stays at its version too; `nightqueue doctor` reports such rows.
A v20 or v21 database then goes to v22 in the same migration, with its copy
`nightqueue.db.pre-v22`: the tracker tables are renamed to `issues`, `issue_projects`
and `issue_comments`, every row, counter and ref kept, and the v21 columns untouched.
`nightqueue run dir --project <name> --slug <slug>` prints the directory of a
run, so nothing has to build the path from a project name.

`NIGHTQUEUE_HOME` must sit on local disk. The memory database is SQLite in WAL
mode, and WAL correctness depends on the operating system really enforcing POSIX
advisory locks - in particular the connection-lifetime "dead man's switch" lock
that tells a connection being closed whether it is the last one still attached to
the database. Network and FUSE mounts (`nfs`, `nfs3`, `nfs4`, `smbfs`, `cifs`,
`afpfs`, `webdav`, `9p`, and anything carrying `fuse`) are known to drop those
locks or to emulate them incorrectly. When that happens the shared-memory index of
the WAL (`nightqueue.db-shm`) is unlinked and recreated while another process is
still attached to the old one: that process keeps reading and writing an index the
rest of the system has already abandoned, which loses finish commits and reverts
leases. `nightqueue doctor` reports both halves of this - see [Doctor](cli.md#doctor).

Secrets are kept in a `0600` file rather than in the operating system
credential store, because the runtime is meant to run unattended, with nobody
there to unlock anything.

A command that writes holds the directory `$NIGHTQUEUE_HOME.lock` while it
runs, so two `nightqueue` processes never overwrite each other's changes; read-only
commands such as `list` never take it. The memory and queue commands (`mcp`,
`hook`, `embed`, `memory`, `queue`) never take it either: they rely
on SQLite for concurrency, so a running server - or a runner that works all
night - never blocks a `nightqueue init`. The one exception is the registration
`nightqueue queue add` (and `queue_add`) offers inside an unregistered
repository: that single registration takes the lock by itself, so it never
races a `nightqueue project add` (and the database refuses a second project on
the same path or name either way).

```sh
nightqueue setup                                   # install the runtime and register everything in the host
nightqueue setup --remove --purge                  # undo the registrations, or delete the home as well
nightqueue update                                  # reinstall the runtime, migrate the database with it, and re-point the host at it
nightqueue update 0.2.0                            # ...at one exact version from the registry
nightqueue update --from .                         # ...from a checkout: npm ci when node_modules is missing or package-lock.json changed since the last studio build, then the studio build
nightqueue update --from . --no-install            # ...never run npm ci; the dependencies line says what it would have done
nightqueue update --schema-only                    # internal: the database migration alone, run by update/setup from the installed runtime
nightqueue doctor --json                           # check the host and the home, exit 1 on any failure
nightqueue doctor --check-updates                  # ...and ask the registry for the newest version
nightqueue doctor --fix                            # ...and git worktree repair the job worktrees whose checkout or home moved, save then remove the orphan ones, and repair the database files
nightqueue init                                    # set the host up and register the current repository
nightqueue init ~/code/api --org acme --name api   # ...or an explicit path, org and name
nightqueue init --no-embedding --no-path --no-gh   # ...answering every question up front
nightqueue init --key API                          # ...registering it under the key API

nightqueue org add acme                            # create an org (its key is suggested, or asked on a TTY)
nightqueue org add acme --key ACM                  # ...under an explicit key
nightqueue org key acme AC                         # change its key; the old one keeps resolving
nightqueue org list --json                         # orgs (with their id, key and old keys), connection slots, project counts
nightqueue org rename acme acme-inc                # one row: its projects and bindings follow
nightqueue org remove acme-inc                     # refused while it still owns projects or rows
nightqueue org default acme                        # where init, project add and project_register put a project when no org is named

nightqueue project add ~/code/api --key API        # register a repository under an explicit key
nightqueue project key api AP                      # change its key; API-<n> refs keep resolving
nightqueue project list                            # name, key, path (or "no path"), org, whether the path still exists
nightqueue project rename api api-v2               # one row: its jobs, lessons, memory and runs follow
nightqueue project move api acme                   # move a project to another org
nightqueue project move api --path ~/code/api      # give it a new checkout (or one it never had)
nightqueue project remove api                      # refused while it owns rows, listing them and hinting --purge
nightqueue project remove api --purge [--yes]      # delete it and every row it owns (jobs, lessons, memory, runs dir); asks first, refused while a job runs or closes
nightqueue project integrations api show [--json] # one <kind>.<key>=<value> line per setting, or "no integrations"
nightqueue project integrations api set <kind>.<key>=<value> ...   # validated against the provider that declares the key
nightqueue project integrations api unset <kind>.<key> ...         # the last key removed leaves the project without integrations
nightqueue project models api [--json]             # one <agent>=<model> (default|project) line per agent, orchestrator last
nightqueue project models api --set coder=sonnet   # the project's coder runs on sonnet; --set repeats
nightqueue project models api --unset coder        # back to the default model; --unset repeats
nightqueue project demo-repo api [--json]          # the demo repository, or "none configured"
nightqueue project demo-repo api --set ../demo     # where verifications may open real pull requests
nightqueue project merger-risk api [--list] [--json]          # source: default|project, then one glob per line
nightqueue project merger-risk api --add 'db/migrations/**'   # conflicts there never reach the merger; --add repeats
nightqueue project merger-risk api --remove package.json      # starts from the list in effect; --remove repeats

echo "$SENTRY_AUTH_TOKEN" | nightqueue connection add sn --type sentry --set org=acme [--set url=https://sentry.example.com]
nightqueue connection test sn                      # prints org=<slug>, never the token
nightqueue connection bind sn --org acme           # bind (or rebind) an org slot
echo "$DISCORD_WEBHOOK_URL" | nightqueue connection add team-chat --type discord   # reads the webhook's channel and guild, added to the org's list
nightqueue connection test team-chat               # prints channel=<id> guild=<id>, never the URL
echo "$LINEAR_API_KEY" | nightqueue connection add linear --type linear   # serves the whole home, binds no org
nightqueue connection test linear                  # prints viewer=<name>, never the key
nightqueue connection list --json
nightqueue connection remove sn                    # unbinds from every org, then deletes the secret
```

GitHub is not a stored connection: every job uses the machine's authenticated `gh`, so
`connection add <name> --type github` is refused with `github is not a stored connection:
nightqueue uses the machine's authenticated gh; run \`gh auth login\``, and a GitHub record an
older build stored is dropped on the next load. Expo is not a stored connection either: the
OTA publish uses the machine's `eas` login, so `connection add <name> --type expo` is refused
with `expo is not a stored connection: nightqueue uses the machine's eas login; run \`eas
login\``, and no Expo token is ever kept in `secrets.json`.

The secret is read from stdin when stdin is not a terminal, and asked for in a
hidden prompt otherwise. It is never accepted as a command-line argument, and
never printed back - not by `list`, not by `--json`, not by an error message.
A type that needs more than its secret takes it as `--set <field>=<value>`, validated
against the fields the type declares before the secret is read: a `sentry` connection
needs `org` (its organization slug) and takes an optional `url` (an https origin, default
`https://sentry.io`, for a self-hosted Sentry); a missing required field, an unknown one or
a malformed value is refused and nothing is stored. These fields are not secret.

A session reaches a stored connection's API only through the MCP tool `connection_call`, by
the connection's name: the runtime injects the secret and never shows it, the host is fixed by
the connection's type, a GET reads, and a POST, PATCH or PUT is sent only after the person's
explicit ok and is refused inside a queue job. There is no CLI command for it, and `secrets.json`
stays unreadable to the session (see [the runtime contract](runtime-contract.md)).
A discord connection takes no path except `messages/<id>`, a GET or PATCH of a message the
webhook posted; PATCH or PUT on the bare webhook URL is refused.
A `discord` connection is a channel webhook: its secret is the webhook URL
(`https://discord.com/api/webhooks/<id>/<token>`), checked for that shape and read once at
`add` to store the webhook's `channelId` and `guildId`; a URL of another shape or one the
service does not answer is refused without being echoed, and nothing is stored. An org holds
any number of discord webhooks: `add` appends the new one to the org's list and `bind` adds
it to another org's list (`org list` shows `discord=team-chat,ops`); `remove` takes it out of
every list. The URL is never listed, logged or written in a notice. config.json keeps these
lists under `orgConnectionLists`, apart from the single-slot `orgConnections`, so an older
nightqueue that rewrites the file keeps them as they are instead of dropping them; a webhook an
older build removes stays listed as missing until this build's `connection remove`.
A `linear` connection is home-scoped: its secret is a Linear personal API key, the home holds
at most one (a second `add` is refused naming the first), and it binds to no org - `--org` on
`add` and `connection bind` are refused, config.json is never touched, and a home with no org
can add it. `connection list` prints `orgs=home` for it, and `--json` gives
`{name, type, present, orgs: [], scope: "home"}` (org-scoped rows carry no `scope`). It needs
no `project integrations` setting (`set linear.*` is refused with `linear has no settings`).

**Project integrations.** `project integrations <project>` holds what a project does with the
services its jobs come from, one setting per `<kind>.<key>` (a key may itself be dotted, stored
nested under the provider). The keys come from the providers of the build - `show --json` lists
them under `providers` - and an unknown key is refused with the valid ones. Values are text: an
enum takes one of its values, a boolean `true` or `false`, a list is comma-separated, and a
connection value must name a stored connection of that provider bound to the project's org.
`show` also prints `<kind>: org connection <name|none>` for each enabled provider with a single
org slot. Several `set`/`unset` arguments are applied together: one invalid one changes nothing.
Unsetting the last key leaves the project without integrations, behaving exactly as before.
`set` and `unset` are refused from inside a job; the MCP tool `project_integrations` does the same.
Expo has two keys: `expo.ota` (boolean, default `false`) turns on the OTA publish of each
merged job (see the post-close steps under [Queue](#queue)), and `expo.branch` (default
`production`) is the EAS Update branch it publishes to - a branch name that starts with a letter
or digit (`set expo.branch=-x` and an empty value are refused). When the checkout has an
`eas.json` at its root, `show` adds `expo: detected` after the settings (also after `no
integrations`); detection only reports, it never sets `expo.ota`.

**Project models.** `project models <project> [--set <agent>=<model>]... [--unset
<agent>]... [--json]` shows or changes the model each agent of the pipeline runs on for
that project. The defaults live in `src/queue/routing.mjs` (`run start --routing` prints
them): triager `sonnet`, explore `haiku`, architect `opus`, coder `opus`, qa-triage
`sonnet`, qa-analyst `sonnet`, qa-prover `haiku`, verifier `haiku`, reflector `haiku`, merger
`sonnet` (the close's conflict resolver, which reads its override once per close), and
orchestrator `default` (the job session, which with no override runs on the user's own model
and otherwise gets `--model <alias>` on every spawn). With no option it prints one `<agent>=<model>
(default|project)` line per agent, `orchestrator=default (default)` or
`orchestrator=<alias> (project)` last; `--json` gives `{project, agents: {<agent>: {model,
source}}}`, `orchestrator` its last key. `--set` takes an agent of that list and a model among `opus`, `sonnet` and
`haiku` - anything else is refused naming the accepted values, and one invalid argument
changes nothing; `--unset` brings the agent back to its default. The override is stored in
the project's settings under `agents.<agent>.model`, apart from what `project integrations`
shows and keeps (a `set`/`unset` of integrations never drops it). `run start` answers the
resolved model of each agent under `models` and the orchestrator's under `orchestratorModel`.
Each attempt of a job records the orchestrator's route and the model its `system/init` reported,
and `queue status <job>` prints them on the attempt's line as
`orchestrator: <alias|default> (<init model>)` (nothing for an attempt not yet measured). `--set` and
`--unset` are refused from inside a job.

**Project demo repository.** `project demo-repo <project> [--set <path>] [--json]` shows
or sets the only repository where a verification may create, merge or close a real pull
request. With no option it prints the path or `none configured`; `--json` gives
`{project, demoRepo}` (`null` when none). `--set` resolves the path against the current
directory and refuses one that is not an existing directory, not a git repository, or the
project's own repository (its checkout, a worktree of it, a directory inside it or around
it); it is refused from inside a
job, and the operator agent may not run it. The value is stored in the project's settings
under `verification.demoRepo`, kept by `project models` and `project integrations` writes
and never shown by `project integrations`. The verifier, runtime and QA requests render
it as `{{DEMO_REPO}}` (`none configured` without one: no real pull request, the scenario
is reported as an open item).

**Project merger risk list.** `project merger-risk <project> [--add <glob>]... [--remove
<glob>]... [--list] [--json]` shows or changes the globs whose conflicts the close's merger
never resolves: a conflicted path that matches one stops as a `real-conflict` with
`risk-list file: <path>`. A project with no list of its own runs on the default
`package.json`, `*-lock.json`, `*.lock`, `pnpm-lock.yaml`, `bun.lockb`, `Cargo.lock`,
`go.sum`, `poetry.lock`, `Gemfile.lock`. With no `--add`/`--remove` it prints `source:
default|project` and one glob per line; `--json` gives `{project, source, risk}`. A glob
without `/` matches a file or directory name at any depth, one with `/` the repo-relative
path from its root; a glob that matches a directory protects every file under it, so
`src/memory/migration`, `src/memory/migration/` and `./src/memory/migration` all protect
the files of that directory (a leading `./` and a trailing `/` are dropped when stored);
`*` and `?` stay inside a segment, `**` crosses them. A change starts from the list in
effect (the default the first time), applies the adds and then the removes, and writes once:
an empty, absolute, `..` or over-200-character glob, or a remove of a glob not on the list,
is refused by name and changes nothing. It is stored in the project's settings under
`merger.risk`, kept by `project models` and `project integrations` writes and never shown by
`project integrations`; it is refused from inside a job, and the operator agent may not run
it. The nightqueue checkout's own schema and migrations are protected by registering them
once: `nightqueue project merger-risk nightqueue --add src/memory/schema.mjs --add
'src/memory/migration/**'`.

A path that starts with `-` has to come after `--` (`nightqueue init -- -weird-dir`),
otherwise it is parsed as an unknown option and rejected.

**Keys and refs.** Every project and every org carries a key: 2 to 5 uppercase letters or
digits, starting with a letter, unique across projects and orgs together. `init`, `project add`,
`org add` and the registration `queue add` offers suggest one from the name (`nightqueue` →
`NQ`, `feat-api-web` → `FAW`, a letter added on a collision: `NQA`); on a terminal the
question is ``Key for project `<name>` [NQ]:`` - Enter keeps it - and `--key <KEY>` answers it
up front; without a terminal the suggestion is taken. `project key <name> <KEY>` and `org key
<name> <KEY>` change a key in one row and keep the old one as an alias of the same owner, so a
ref written with it still resolves and no other owner can take it. Everything the runtime
prints names things by ref, and every command and tool that takes one accepts it: a job is
`J-<id>` (the plain id is still accepted).

## Queue

The full reference of `nightqueue queue` is [Queue](queue.md); these subcommands are
recent enough that this is their first mention here.

```sh
nightqueue queue status J-42                          # one job, by its ref (or its plain id)
nightqueue queue status https://github.com/acme/api/pull/7   # ...or by the pull request it opened
nightqueue queue status                               # the table; TOKENS is the total including cache (see below)
nightqueue queue session 42                          # resume the session of a job's last attempt
nightqueue queue session 42 --print                   # print the resume command instead of running it
nightqueue queue session 42 --json                    # session, attempt and cwd, as the only thing on stdout
nightqueue queue session 42 --prompt "look at the gate"   # resume it with a request as the next message

nightqueue queue close 42                             # merge a done job's pull request and close the job, detached
nightqueue queue close 43                             # close a done job resolved without change (no pull request): nothing merged, origins told
nightqueue queue close 42 --foreground                # run the four steps in this process, one line per step
nightqueue queue close 42 --foreground --json         # JSON on stdout, the job and the close outcome
nightqueue queue close --merged                       # close every done job gh confirms merged
nightqueue queue close 42 --force                     # skip the pull request checks and the rebase suite, nothing else
nightqueue queue close 42 --allow-draft               # mark an open draft ready (gh pr ready, once) instead of stopping with `draft`
nightqueue queue close 42 --allow-revert              # skip the revert guard (`reverts-base`) for a pull request whose purpose is a revert
nightqueue queue close 42 --steps origin,log          # re-run only the post-close steps of a closed job, in this process
nightqueue queue close 42 --steps log --again         # clear the named steps' done marks first, so they post again (only with --steps)
nightqueue queue close 42 --steps ota --again         # publish the Expo OTA update of a closed job once more
nightqueue queue cancel 42 --reason "abandoned"       # cancel a done, failed or gated job and release its worktree

nightqueue queue run --watch --from 22:00 --until 04:00   # watch only inside that window, local wall clock, then exit
nightqueue queue run --watch --until 04:00                # `--from` defaults to now

nightqueue queue repair [--json]                      # replay the pending writes every run left while the database was unavailable
nightqueue queue repair 42 [--json]                   # re-classify a gated or failed job from its run's records and process facts
nightqueue queue repair --from-disk [42] [--json]     # recreate the jobs the table lost, from their runs on disk
```

The TOKENS column of `queue status` is the total including cache: input + output +
cache read + cache creation. While a job runs, the cell is the estimate read from the
streamed assistant usage and carries a `~` prefix (`~66.9M`); it loses the prefix once the
result reports. The cache counters stream faithfully (within 1% of the result), but the
output tokens of subagents never reach the orchestrator stream, so a partial input + output
total would be useless mid-run, while the total with cache is a good proxy that converges.
`queue status <id>` keeps the four counters separate; no cost is ever estimated.

The last column of the `queue status` table is `TITLE/LAST` (it was `SLUG/LAST`). A running
job shows what it is doing, as before. Every other job shows its title, then ` — ` and the
reason it stands there (notice first line, close note, parked label) when the width allows.
The title is derived on read and never stored: the first non-empty line of the prompt's brief without its heading marker
(a bare `## Brief` or `# Task` heading yields to the next line), clipped at 120 characters
with `…` counted in them. The slug no longer sits in the table; `queue status <id>` prints it.

`queue repair` has three forms. Bare, it replays every `pending-writes.jsonl` a run left while
the database was unavailable (see [Runtime contract](runtime-contract.md)) and prints one
`<project_id>/<slug>: applied <n>, filled <n>, superseded <n>, refused <n>` line per run
directory, or `nothing pending`. With an id it re-classifies a gated or failed job from the exit
its row recorded, the `outcome` and `termination` of its run and the structured events of its log,
as described in [Queue](queue.md). With `--from-disk` it recreates every job `doctor --db`
lists under `lost jobs` - or only the one named - from its run on disk: status from the
`terminal` witness, then the recorded `outcome`, then the last attempt of its log (a run that
left none is `failed` with `recovered from disk: the run left no outcome`), the notice from the
stream's `## Notice`, the pull request, slug and branch; the row carries
`result.recovered = { from: "disk", at, runDir }` and the job log gains
`recovered from disk: status=<s> prUrl=<u|->`. It prints one `J-<n> <project>/<slug>: <result>`
line per job, where the result is `recovered as <status>`, `exists` (the row is there - a second
run, or the loser of two concurrent ones), `skipped: still running` or `project-missing`, then
the tail of the job logs no run explains, which cannot be rebuilt. A recovered row is a record, not a task: its prompt was not kept on
disk, so `queue retry` (and `queue_retry`) refuses it with ``J-<n> was rebuilt from disk by
`nightqueue queue repair --from-disk` and its prompt was not kept, so it cannot run again; queue
the task anew with `nightqueue queue add` ``.

`queue retry` (and `queue_retry`) refuses a finished job before writing anything: a `closed`
job answers ``J-<n> is closed: a finished job does not resume; queue a new one``, and a `done`
job whose pull request gh reads as merged answers ``J-<n> is done and its pull request is
merged: a finished job does not resume; queue a new one``. When gh cannot answer, or
`NIGHTQUEUE_NO_PR_CHECK=1` is set, the merge is not proven and a `done` job gets the store's
usual ``cannot be retried from status `done` `` refusal.

A job has no attempt budget. `queue add` no longer takes the option that set one (an unknown
option is refused and nothing is queued), the `attempts` line of `queue status <id>` is the plain
count, and `queue retry` widens nothing: it is how a `failed` job goes back, an orphan included,
since the sweep ends every orphan `failed`. A retry without `--fresh` also consumes what the last
attempt concluded, a `done` and a termination included, and keeps the pull request URL; a record
it cannot consume refuses the retry with `retry again in a moment` and nothing written. A run
directory another job stamped refuses it too, naming that job and `queue retry J-<n> --fresh`,
which starts it over and deletes that directory (see [Queue](queue.md)).

A `--note` on a job whose run directory exists is recorded in `state.json.answers`, in the same
write that consumes the conclusion, and leaves `operator_note` empty; with no run directory yet it
stays on the row. A retry with neither `--note` nor `--fresh` of a run whose last two attempts
recorded no new phase and no new answer is refused with ``J-<n> made no progress in its last two
attempts (same <n> phases, no new answer): answer with a note, or retry --fresh``, nothing written;
a preflight gate (`blocked_code` set) is never refused this way.

`queue retry --fresh` (and `queue_retry` with `fresh`) starts the job over on a new branch and
keeps the old work. It clears slug, branch and session, releases the worktree without forcing
it, then drops the run directory. A clean worktree is removed whether or not its branch was
pushed; the branch stays with its commits, wip commit included. The command prints
`worktree removed: <path>` and `New job from it: start_branch: <branch>`, naming the branch the
worktree really holds, and `--json` and `queue_retry` carry `worktree` and `keptBranch`. A worktree
with uncommitted changes refuses the retry with ``the worktree has uncommitted changes at <path>;
commit or stash them, or retry without --fresh``, and one kept for another reason (a live lock) with
``the worktree at <path> could not be released (<reason>); retry without --fresh``. A detached HEAD
with commits no branch, tag or remote reaches refuses naming both ways past it: a retry without
`--fresh`, which puts the run's own branch on that HEAD, or the printed
`git -C '<path>' switch -c <name>` and then `--fresh`, which keeps that branch. Every refusal writes
nothing. A worktree the job entered from its queued starting point stays, and the answer reports it
as kept. A worktree kept by a release that lost a race (locked or dirtied just after the check) keeps
its run directory too, reported as kept and listed by `nightqueue doctor`.

`run start` records the plugin's version in `state.json` as `pipeline: { name, version }`, only on
a run with no phase yet. A run with completed phases that recorded another version than the
installed one is never resumed: the runner gates it with `blocked_code` `pipeline-version-changed`
before any spawn, and a plain `queue retry` and `run start` refuse it, all with the same line:
``this run started under resolve@<old>; retry with --fresh to start it over under @<new>``. So each
new plugin version gates the runs already in progress. When the plugin's manifest cannot be read,
the same run gates as `pipeline-version-unknown` instead, since nothing is known to have changed:
``this run started under resolve@<old> and the installed pipeline version cannot be read from
<manifest>; repair the plugin, then retry``, and a plain `queue retry` resumes it once repaired. A
state with no recorded version never gates, on any version.

A session that could not reach the nightqueue MCP server - its `init` lists `nightqueue` as
`failed`, or its first nightqueue tool call fails (`is_error`) with nothing but
`Connection closed` (optionally prefixed by `MCP error <n>: `) - is not a failed attempt; a
result that merely quotes the phrase, such as a recalled lesson or this very gate notice, never
counts: the job stops at a `gate` with `blocked_code` `store-unavailable`, the attempt is given
back and the worktree kept, exactly like any other preflight block. The notice names
`nightqueue doctor --fix` and ends in `nightqueue queue retry J-<n> (no note needed)`.

`queue status <PR URL>` (and `queue_status` with `pr_url`) finds the job that opened that
pull request, whatever the case of the owner, a trailing slash or a `/files` suffix. A URL no
job opened answers ``no job opened `<url>` ``, one that is not a GitHub pull request is
refused, and one opened by more than one job is refused with their refs
(``… was opened by more than one job: J-3, J-9; pass one of them``) - never the latest.

`queue session <id>` opens the `claude` session of a job's LAST attempt - `last_session_id`
when the job carries one, else its first `session_id` - by resuming it with `nightqueue open
--resume <session>` (the operator launch, see [Open](#open)) in the cwd the run itself used: the run's worktree when it is still on disk, or the
project's checkout with a warning line (`(worktree released, using the checkout)`) once the
worktree was already released. A `pending` or a `running` job is refused by name - a live
runner owns a running job's session, a pending one has none yet - and so is a job that never
reached the agent at all. The resumed session runs under the operator guard (see
[Open](#open)): it reads and queues, and delegates only to `triage`, `qa` and `reviewer`. `--print` stops there and prints the equivalent `cd '<cwd>' && nightqueue
open --resume <session>` line instead of running it, and `--json` prints `{ jobId, attempt, session,
cwd, worktreeReleased, command }` as the only thing on stdout; without either flag the exit
code is the resumed session's own. `--prompt <text>` is passed to `nightqueue open --resume
<session> --prompt <text>`; `--print`/`--json` include it, shell-quoted, and, as with
[Open](#open), `ps` shows it while the session runs. The MCP tool `queue_session` resolves the same session but
only ever reads it - it answers `job_id`, `attempt`, `session`, `cwd` and `worktree_released`,
and never resumes or executes anything itself.

`queue close <id>` is the operator's act that takes one `done` job with a pull request, or one
resolved without change, to `closed` through the closing pipeline described below - the only way any job becomes `closed` -
and releases the job's worktree once it is closed, printing `worktree removed: <path>` or
`worktree kept: <path> - <reason>`. `queue close --merged` runs the same pipeline, in this
process, on every `done` job whose pull request `gh` itself confirms merged, prints `closed
J-<id>` or `J-<id> not closed: <reason>` for each, and reports `<n> jobs left unchecked; run
nightqueue queue close --merged again` when some could not be checked within the call's own
deadline. A `failed`, `gate` or `cancelled` job is never closed, whatever its pull request
says: retry it, or cancel it.

`queue cancel <id>` accepts a `pending`, gated, orphaned, `done` or `failed` job. For a `done`,
`failed` or gated one it also releases the job's worktree, never forced, printing `worktree
removed: <path>` or `worktree kept: <path> - <reason>` after `cancelled J-<id>`; `--json` prints
`{ job, worktree }`. A gated job's clean worktree is removed whether or not its branch was pushed,
and the branch stays, so a later retry places the worktree again on it; a dirty one is kept and
the job is cancelled anyway. A job running under a live lease, or being closed under one, is refused by name
with nothing written. So is a `done` job whose close was interrupted (its lease died mid-close,
possibly after the merge): resume it with `nightqueue queue close <id>`, which records a merged
pull request as closed and cancels the job when the pull request was closed without merge.
From an agent session the MCP `queue_cancel` with `stop: true` cancels a running job in one call
(see [Queue](queue.md)), and `queue_stop` mirrors `queue run --stop [pid]`.

`queue close <id>` takes a `done` job's pull request from open to merged and closes the job,
through four steps recorded on the job - preflight (fetch, pull request state, green checks,
uncommitted files the pull would touch), conflict (a rebase in a throwaway worktree, the
project's `npm test` unless the head had CI checks and the rebase was clean, a `--force-with-lease` push; skipped when GitHub reports it mergeable),
merge (`gh pr merge --squash`, confirmed by re-reading the merge commit) and settle (close the
job, recording the merge in its checklist). It starts detached
and prints the pid and its log, `<home>/logs/close-<id>-<stamp>.log`; `--foreground` runs it here
and exits `0` only when the job closed; `--json` prints `{ started, jobId, pid, logPath }`
detached, or one `{ job, outcome }` object in the foreground. A close that stops shows `close failed` in the STATUS cell (the step and reason are in LAST) and prints `⛔ close stopped at <step>:
<reason> - run again with: nightqueue queue close J-<id>`, leaves the job `done`, and running it
again resumes at that step - never merging twice. A pull request closed without merge cancels
the job instead (`J-<id> cancelled: PR #<n> was closed without being merged; nothing to
close`), and one merged by hand is recorded as `merged outside a close`. `--force` skips the
pull request checks and the rebase suite and nothing else: status and attribution
(`pr-not-the-job-branch`) still stop the close, and a conflict always stops a forced close:
the merger never runs under `--force`. Without it, a small textual conflict may be resolved by
the bounded merger agent before the suite runs, never in a file on the project's
`project merger-risk` list. An open draft pull request stops at preflight
with `draft` unless `--allow-draft`, which runs `gh pr ready` once; the merge stops with
`reverts-base`, listing each path and the base commit it would undo, when the squash would put
back an older version of a file the base changed since, unless `--allow-revert`. `--force`
lifts neither, and both flags are refused with `--steps` or `--merged`. A second close of a closed
job answers ``job `<id>` is already closed``. A `done` job with no pull request, resolved
without change, closes with no gh or git call (preflight, conflict and merge `skipped`) and
prints `J-<id> closed: resolved without change (no pull request)`; `--force` is refused on it.
`queue.closeTimeoutS` (default `1800`, range
`60..3600`) bounds the whole close, the merger included. For a project with integrations, the
post-close steps ota, origin and log run in that order after settle on the closed job and never
stop it: a failure is an `After close: <step> warning - <note>` line in the notice (the origin
step writes one per origin of the job, each origin acted on in registry order and on its own).
The ota step publishes an Expo OTA update of the merge commit (`eas update --branch
<expo.branch> --non-interactive --json`, in a throwaway worktree) only when the project set
`expo.ota=true`; otherwise it is a quiet `skipped - expo.ota is off`, as it is for a close
without a code change. A missing or logged-out `eas` is a noticed skip, a failed publish a
warning with the last lines of eas's output; the job stays closed either way. The origin and
log steps then carry its outcome: an `OTA` field in the Discord reply and log, and an `OTA
published to <branch> (<url>)` or `OTA failed: <reason>` line at the end of the Linear and
Sentry comments (nothing when the step was skipped). `queue close <id>
--steps origin,log` re-runs only those steps (each skips what it already did, origin by origin)
and exits `1` on a
warning; `--again` (only with `--steps`, never with `--merged` or `--force`) clears those steps'
done marks first so they post again, and the summary says `(again)` after each; `--steps ota
--again` publishes the OTA update once more. The MCP tool `queue_close` (`job_id`, `force?`) starts the
same detached close. See [Queue](queue.md#closing-a-job) for the steps, the lease and what a
close never does.

`queue run --watch --from HH:MM --until HH:MM` bounds a watcher to one local
wall-clock window and exits at its end; see [Queue](queue.md#running-the-queue) for
the full resolution rule (midnight-crossing windows, the one-shot nature, what the
runner does at `from` and at `until`). Both flags only have meaning with `--watch`,
`--from` requires `--until`, and neither is accepted next to `--job`. `queue.keepAwake`
(`"auto"` default, `"always"`, `"off"`) in `config.json` keeps the machine from
sleeping while a runner or a job needs it; see the same section for what it does and
does not cover. `queue.bashTimeoutS` (`{ "default": 900, "max": 3600 }`, in seconds) sets
the Bash timeouts of the `claude` a job runs: `default` is what a command gets with no
`timeout` parameter, `max` the most it may ask for. Both must be positive integers with
`max >= default`; any other value falls back to the defaults as a whole. See
[Queue](queue.md) for why a command that outlives it is killed, never backgrounded.
`queue.inheritUserEnvironment` (`false` default) isolates a job from the operator's
own MCP servers, plugins, skills, agents and user hooks; only a literal `true` opts a
job back into inheriting them. See [Queue](queue.md) for what an isolated job's
environment is and is not, and for the `job environment` row of `nightqueue doctor`.

## Lessons and memories

```sh
nightqueue lesson delete L344 --project api   # delete one lesson (L344 or 344) and its search entry
nightqueue memory delete M446                 # delete one memory (M446 or 446) and its search entry
```

Each command deletes one row by id and answers its id and title (a memory's key). An unknown id is
an error. With `--project <name>`, an id that belongs to another project is refused; both commands
delete nothing in those cases and are refused inside a queue job. A deleted row never comes back in
`lesson_recall`, `memory_recall` or `context_for_agent`. The MCP tools `lesson_delete` and
`memory_delete` do the same and require `project`.

## Doctor

```sh
nightqueue doctor                  # one line per check: ok, warn or fail
nightqueue doctor --json           # the same report, as the only thing on stdout
nightqueue doctor --check-updates  # ...plus the newest version published in the registry
nightqueue doctor --fix            # ...and git worktree repair the job worktrees whose checkout or home moved, save then remove the orphan ones, remove the shm orphans and repair the database files
nightqueue doctor --db             # ...plus the database files, a quick_check and the jobs on disk the table lost
```

`nightqueue update --from <dir> [--no-install]` installs a checkout. Before building the studio
it runs `npm ci --no-audit --no-fund` in `<dir>` when `node_modules` is missing, when the sha256
of `package-lock.json` differs from the `lock_sha256` of `studio/dist/.stamp.json`, or once
when the build fails on a missing module or command (then it builds once more), and prints
`dependencies: installed (<why>)` or `dependencies: up to date`. `--no-install` skips the
install and prints `dependencies: skipped (--no-install; would run npm ci: <why>)`. A studio
build that cannot pass never blocks the runtime: the step prints `studio: degraded - <first
error line>; the studio serves the previous build (or no build) until npm run studio:build
passes`, and the shims, MCP, hooks and plugin are installed as usual. `nightqueue doctor` has
a `studio build` line: `ok` with the stamp's sha, a `warn` when the runtime has no stamp or it
was written for another version than the runtime.

`nightqueue doctor` reads the host and the home and writes nothing, except `git worktree
repair`, the removal of the `db shm` orphans and the database actions with `--fix` (below): it never creates
the database, never touches `settings.json` and never asks `claude` about
anything but its version. It checks the Node version, the `claude`, `gh` and `eas`
CLIs, `config.json`, the mode of `secrets.json`, each of the three shims (a
missing shortcut only warns), a shim left over from a previous command name (`shift`,
`nightshift`, `nsft`, `nshift`: a `legacy shim <name>` warning, removed by `nightqueue setup` or
`nightqueue update` only when this package wrote it, else the path to delete by hand), the
`~/.nightshift/` directory of the command before the rename (a `legacy home` warning with
the `rm -rf` command; nothing deletes it), the
MCP registration, the registration in the Claude Desktop app (`claude desktop
mcp`, which is a `warn` when the app is installed and does not know the server
and an `ok` when the app is not installed at all), each of the four hooks, the
plugin, the embedding weights,
the optional embedding
library, the schema version of the database, the pause sentinel of the queue,
whether the machine is kept awake for a runner or a job (`queue.keepAwake`, and on
macOS whether `caffeinate` was found), the
pidfile of the runner (a registration whose process is gone only warns, and so does one
whose pid belongs to another user; the diagnosis never removes either), the jobs whose
runner died, the host commands of the last 20 finished jobs (`host commands: 0
backgrounded, 0 killed, 3 timed out in the last 20 jobs`, a `warn` when any was
backgrounded or killed), what the orchestrator of those same jobs did itself
(`orchestrator: 30 turns, 0 reads outside the run, 10 Bash (0 exploration), last
context 250000 (avg 125000) in the last 20 jobs (2 measured)`, a `warn` when it read
outside its run or ran a Bash command outside its closed list - see
[the queue](queue.md)) and every registered
project. It exits `1` when any check fails, `0` otherwise - a `warn` never fails
the run.

The `eas` line runs `eas whoami` without the `NIGHTQUEUE_*` variables: `ok logged in as
<name>`, `warn not logged in` with the hint `run \`eas login\``, or `warn eas whoami did not
answer` (a timeout or a kill, never read as logged out). A missing `eas` is `ok not
installed (needed only to publish Expo OTA updates)` when no registered project has
`expo.ota=true`, and `warn not installed - needed to publish Expo OTA for <project>, ...` when
some do, with the hint to install eas-cli and run `eas login`; only a missing `eas` makes
doctor read the projects, from a read-only store.

The `studio terminal` line says whether the studio can embed a terminal. `ok` reads
`node-pty <version>: the studio can embed a terminal`. Otherwise it is a `warn`, `node-pty
unavailable (<reason>)` - the package is missing, failed to build or was built for another
Node - with the hint that the studio falls back to copy-the-command and that `nightqueue
update` on a host with a C++ toolchain installs it. On darwin a `spawn-helper` that is not
executable gives `spawn-helper not executable (<path>)` with the hint `chmod +x <path>`;
doctor only reports it, the studio fixes it itself when it loads `node-pty`.

Each stored connection gets one `connection <name>` line: doctor runs the same test as
`nightqueue connection test <name>`, all connections in parallel, each within 5 seconds.
`ok` reads `<type>: ok`. A test that fails or times out is a `warn`, `<type>: failed - <detail>`
(an HTTP status, `timeout (5s)` or `network failure`, never the secret), with the hint
`nightqueue connection test <name>`. A connection whose type this build does not know is a
`warn`, `unknown type <type>`. These lines are never a `fail`, because a service outage says
nothing about this host. A home with no stored connection prints no such line and makes no
request.

Three of the checks are about the storage under the home (see [Configuration](cli.md#configuration)):

- `db shm` warns when the shared-memory index of the WAL was replaced under a
  connection still attached to it: hidden orphans left beside the database
  (`.fuse_hidden*`, `.nfs*`, which survive a restart and are the only trace a
  past split leaves), or a live runner whose registered `nightqueue.db-shm` is
  gone or is no longer the file on disk. A runner registered by an older version
  carries no witness, and the check then says so instead of passing. With `--fix` the
  orphans are removed, but only when no live runner is registered (a `runners/*.json` whose
  pid is alive) and the registry can be listed; otherwise the row stays a `warn` and says
  `not removed: a live runner is registered (pid <n>)`. Without `--fix` nothing is deleted.
- `quarantine _broken-<stamp>` names each `_broken-*` directory of the home last modified
  more than 30 days ago as removable, with its size (`2.0 KB`) and its path, and the
  `rm -rf` command. It never deletes it.
- `home mount` names the filesystem the home sits on - read from
  `/proc/mounts` (or `/proc/self/mountinfo`) on Linux and from `mount` on macOS -
  and warns for `nfs`, `nfs3`, `nfs4`, `smbfs`, `cifs`, `afpfs`, `webdav`, `9p`
  and any type containing `fuse`. It only sees the mount in effect at the moment
  it runs, so it says nothing about a mount that has since been unmounted: `db
  shm` is the check that survives a restart. Where neither source answers, the
  line states an unknown rather than a pass.

The `database` check compares the schema version on disk with the one this build expects: a
database behind is a `warn` (`schema v20, this nightqueue expects v22`, hint `run nightqueue update`),
and a database written by a NEWER version is a `fail` (upgrade nightqueue to the version that
wrote it). A database SQLite itself cannot read - `SQLITE_NOTADB`, `SQLITE_CORRUPT`,
`SQLITE_IOERR` or `SQLITE_READONLY` (see [Memory](memory.md)) - is a `warn`, never a `fail`:
the row reads `<code>: <detail>` with the hint `nightqueue doctor --fix`, the one hint every
place that meets a sick database prints.

`--db` only adds rows to the report, after `db shm`; it never changes what `--fix` does:

- `db files` - the sizes of `nightqueue.db`, `-wal` and `-shm`, and the inode of the `-shm`
  (`main <size>, wal <size>, shm <size> (inode dev:ino)`);
- `db integrity` - `quick_check ok`, or a `warn` carrying what `PRAGMA quick_check` answered,
  with the hint `nightqueue doctor --fix`;
- `lost jobs` - every job whose run is on disk (its `state.json` job block or witness, its log,
  its worktree) and whose row the table no longer has, one
  `J-<n> <project>/<slug> last=<status> pr=<url|->` each, plus `and <n> job logs with no run and
  no row (J-…)` for a log nothing else explains: a `warn` with the hint
  `nightqueue queue repair --from-disk`, or `ok` `no job on disk is missing from the table`.
  Logs with no run and no row alone (the logs a `project remove --purge` keeps, for instance)
  never make the row warn, since no repair can rebuild them: it stays `ok` and names them,
  `no job on disk is missing from the table; and <n> job logs with no run and no row (J-…), kept
  for reading only`.
  When the table cannot be read the row says `unknown: the table cannot be read` and still lists
  the ids on disk.

`--fix` extends to the database, with one row per action it took, whether or not `--db` is given:

- `db checkpoint` - when the `-wal` is not empty and the database answers, it folds the log
  into the main file (`wal_checkpoint(TRUNCATE)`, on a connection that never migrates):
  `folded <n> frames (busy=0)`, or a `warn` `busy: a live connection kept <n> frames` with the
  hint `stop the runner, then nightqueue doctor --fix`. An empty `-wal` prints no row.
- `db repair` - only when the database answers `SQLITE_NOTADB` or `SQLITE_CORRUPT` (or a
  `quick_check` that is not `ok`). A copy of the main file ALONE is checked in a temporary
  directory, so the live file never gets a second sqlite:
  - the main file is intact and no other process holds the database: `-wal` and `-shm` are moved
    into `_broken-<stamp>/` in the home, the database is reopened and `integrity_check` runs -
    `moved nightqueue.db-wal, nightqueue.db-shm into <dir>; integrity ok`;
  - the main file is intact but a live runner is registered: a `warn`
    `not moved: a live runner is registered (pid <n>)`, and nothing moves;
  - the main file is intact but another process has the database files open - an MCP server or
    a hook registers nowhere, so the files themselves are asked, through `lsof -t`: a `warn`
    `not moved: pid <n>[, …] still has the database open`, or, when `lsof` cannot run or answers
    anything unexpected, `not moved: cannot tell whether a process holds the database (<why>)`.
    Nothing moves, and the hint is
    `stop every nightqueue process (runners and MCP clients), then nightqueue doctor --fix`. The
    doctor first closes its own connection; one it had to retire as broken makes it say
    `this doctor process holds a broken connection; run \`nightqueue doctor --fix\` again`;
  - the main file itself is broken: a `fail` - the one database row that fails, because
    `--fix` was asked and could not act. Nothing moves; the detail lists every backup in the
    home with its size and time (every `nightqueue.db.pre-v<N>` copy, stamped ones included, and the files of
    each `_broken-*` directory), or `no backup found in <home>`, and the hint is
    `stop every nightqueue process (runners and MCP clients), then: cp '<newest backup>' '<db path>'`.

Job worktrees live under the home, at `<NIGHTQUEUE_HOME>/worktrees/<project_id>/<slug>`, and
an older nightqueue left them under `.claude/worktrees/` of each checkout; the diagnosis reads
both places and, without `--fix`, writes nothing in either; `--fix` runs `git worktree repair`
and removes the home orphans described below, never anything under `.claude/worktrees/` (the qa
worktrees below have their own `--fix`). One row
`worktree <project>/<dir>` is printed per directory that needs a word:

- under the home, a directory whose two-way link with its checkout broke (its `.git` file names
  an administrative directory that is gone or outside the `worktrees` directory of the
  checkout's git common directory - `git rev-parse --git-common-dir`, so a checkout whose own
  `.git` is a file is read right - or that directory no longer points back at it - what a
  moved checkout or a moved home leaves behind): a `warn`
  `git no longer links it to <checkout> (the checkout or the home moved)` with the hint
  `run: nightqueue doctor --fix`. With `--fix` the diagnosis runs ONE
  `git worktree repair <dir...>` per project from its checkout, then checks each link again:
  the row reads `repaired: git links it to <checkout> again` only when the link now holds, and
  otherwise stays a `warn` - git's reason, or `still not linked after git worktree repair` -
  with the `git -C '<checkout>' worktree repair '<dir>'` command, unless no open job holds the
  directory: then it is an orphan, archived, removed and pruned (below);
- under the home, a directory holding a `.git` link when git cannot read its checkout at all:
  a `warn` `cannot check its link: git could not read <checkout>`, with no repair and no
  removal offered;
- under `.claude/worktrees/`, a directory an open job (any status but `closed`) still records
  as its worktree: an `ok` `legacy-in-use by J-<n> (old location .claude/worktrees): released
  when the job closes`;
- a worktree `queue retry --fresh` kept with its run directory: a `warn` `kept by \`queue retry
  --fresh\` of J-<n> with its run directory <dir>: no job works in it now`, with the read-only
  `git -C '<worktree>' status --short`, no removal offered, and `--fix` leaves it; locked by hand or
  by a pid that is gone, the detail adds `it is locked (<reason>)` and the hint is
  `git -C '<checkout>' worktree unlock '<dir>'` alone, after which the row is the unlocked one;
- a run directory `queue retry --fresh` kept, one `run <project>/<slug>` row naming it and the job: a
  `warn` while its worktree is on disk, with `ls '<dir>'`, and an `ok` once the worktree is gone or
  when it recorded none; nothing is offered for removal and `--fix` leaves it;
- in either place, a directory no open job records as its worktree: a `warn` (prefixed
  `legacy location, ` under `.claude/worktrees/`) with the command that cleans it - the
  diagnosis never runs it, and deletes nothing:
  - registered in git, not locked: `git -C '<checkout>' worktree remove '<dir>'`;
  - registered and locked by a pid that is gone, or with no pid: `git -C '<checkout>' worktree
    unlock '<dir>' && git -C '<checkout>' worktree remove '<dir>'`;
  - not registered in git and holding no `.git` link (orphaned): `rm -rf '<dir>'`; a directory
    that still holds a `.git` link is never offered `rm -rf`, but a `worktree repair` first.

With `--fix`, a directory under `<NIGHTQUEUE_HOME>/worktrees/` no open job holds (every job but a
`closed` or `cancelled` one holds the worktree its run recorded and the
`<NIGHTQUEUE_HOME>/worktrees/<project_id>/<slug>` its slug names, so a job whose run state was lost
still keeps its worktree) is an orphan: what it holds
uncommitted is saved under `<NIGHTQUEUE_HOME>/salvage/<project_id>/<dir>-<stamp>/`, then it is
removed. Spared, with the row of the listing above: a directory an open job holds, one
`queue retry --fresh` kept, and one locked by a live pid or by hand. When the queue cannot be read,
`--fix` removes no worktree at all and adds one `warn` row `worktrees` `the queue could not be read;
--fix removed no worktree`. Every git command run in an orphan pins `core.fsmonitor=false`,
`core.hooksPath=/dev/null` and empties every configured `filter.<name>.clean|smudge|process`
(`required=false`), and its diff runs with `--no-textconv --no-ext-diff --ignore-submodules=all`,
so a driver a job planted never runs:

- registered in git: `changes.patch` (`git diff --binary HEAD`, apply it with `git apply` on its
  branch) and `untracked.tar.gz` (the untracked files, the ignored files outside a wholly ignored
  directory, so a local `.env` is saved and `node_modules/` is not, and every checked out
  submodule whose own neutralized `git status` shows a change, archived whole), each written only
  when not empty, plus `head.txt` (branch and
  sha); then a lock left by a gone pid is lifted and `git worktree remove --force` runs. The branch
  and its commits stay. The row is an `ok` `removed: orphan, no open job holds it; saved
  <files> to <salvage dir>; branch <branch> kept`, or `removed: orphan, no open job holds it,
  nothing uncommitted` with no salvage directory. A detached HEAD with commits no branch, tag or
  remote reaches is kept: a `warn` `kept: ..., which a removal would drop` with the read-only
  `git -C '<dir>' log --oneline HEAD --not --branches --tags --remotes`;
- not registered in git, or its `.git` link still broken after the repair: `content.tar.gz` (every
  entry but `.git`) when there is any, then the directory is removed and `git worktree prune` runs
  from the checkout: an `ok` `removed and pruned: <not registered in git|its .git link is broken>,
  no open job holds it; saved content.tar.gz to <salvage dir>` (or `, nothing in it besides its
  .git link`). An empty directory is removed as before: `removed: left over, orphaned and empty`;
- a salvage that fails removes nothing: a `warn` `kept: <reason>; partial salvage at <salvage
  dir>` with `inspect '<dir>'`.

A directory under `<NIGHTQUEUE_HOME>/worktrees/` named after an id no registered project with a
checkout has (a project removed with `--purge` leaves it) is one `warn` row
`worktrees <id>` `project not registered`, with `inspect '<dir>'`.

QA worktrees the removed `nightqueue sandbox worktree` made live at
`<NIGHTQUEUE_HOME>/qa/<project_id>/<id>`. Nothing creates them any more; each directory there
is a read-only leftover row `qa (legacy) <project>/<id>` with the same cleanup commands as above
(`git -C '<checkout>' worktree remove '<dir>'`, or `unlock … && remove …` when it is locked by
a pid that is gone), one a live session holds locked is skipped, and an id no registered project
has is one `warn` row `qa (legacy) <id>` `project not registered`. `--fix` never touches them.

QA worktrees an operator made before the generalist operator live at
`<NIGHTQUEUE_HOME>/operator-qa/<project_id>/<slug>`. Nothing creates them any more; each
directory there is a read-only leftover row `operator-qa (legacy) <project>/<dir>` with the
same cleanup commands as above (never `rm -rf` for a directory that still holds a `.git` link),
and an id no registered project has is one `warn` row `operator-qa (legacy) <id>`
`project not registered`. `--fix` never touches them.

A directory a live session holds locked, and the worktree of an open job under the home (its
cleanup is `nightqueue queue close`, or `nightqueue queue cancel` for a `done`, `failed` or gated job),
are not reported. When the queue cannot be read, one `worktrees` row says the owner is unknown
and nothing is listed; when git cannot list the worktrees of a checkout, one
`worktrees <project>` row says so. The owners are read through a read-only store.

The diagnosis is offline: without `--check-updates` it opens no network
connection at all. With the flag it adds one last check, `registry`, which asks
the registry for the newest published version and compares it with the installed
runtime. That check is never a `fail`: a registry that does not answer is a
`warn` carrying the message of npm, because a registry being down says nothing
about this host and must not turn a local diagnosis into a failing exit code.

## Verify

```sh
nightqueue verify                                  # every detected check, one line each, exit 1 on any failure
nightqueue verify --scope touched --files a.ts,b.ts  # narrow the checks that accept a file list to those paths
nightqueue verify --scope +poc                     # the same block plus the PoC check
```

`nightqueue verify` runs the checks the repository under the current directory
declares, always in the same order - `typecheck`, `lint`, `build`, `test`, `poc`,
`diff-hygiene` - and prints one line per check:

```
PASSED|FAILED|SKIPPED <check> <duration_s>s
```

Under a `FAILED` line come at most twenty indented lines of that check's own
output. It exits `1` when any line is `FAILED` and `0` otherwise: a `SKIPPED`
never fails the run, the same rule `nightqueue doctor` follows for a `warn`.

The checks are detected, never guessed. The package manager comes from the
lockfile alone (`bun.lockb`/`bun.lock` → bun, `pnpm-lock.yaml` → pnpm,
`yarn.lock` → yarn, `package-lock.json` → npm, none → npm) and every script is
invoked as `<pm> run <script>`, never through `npx`/`bunx`, so a check always
runs at the version the repository installed. When there is no `package.json`,
the ladder falls through to `Makefile`, `pyproject.toml`, `go.mod` and
`Cargo.toml`. A check the project does not declare is `SKIPPED`: a repository
with no test script reports every check `SKIPPED` and exits `0` - and says so on
stderr, because "nothing was verified" is not the same event as "everything
passed".

A workspace root is read as the workspace it is. A script the root manifest does
not declare is looked for in the members its `workspaces` array (or yarn's
`workspaces.packages`, or pnpm's `pnpm-workspace.yaml`) names, `*` expanding one
level and `**` every level down to the bounded depth of the walk, with `!`
patterns excluded. Each member that declares the script contributes one run of
`<pm> run <script>` **in its own directory**; the check passes when every run
passes and stops at the first failure, whose snippet opens with `in <member>`. A
script the root declares wins over the members, because the root script is the
project's own entry point. When the root declares workspaces and no member
carries a `package.json`, the run says so on stderr instead of reporting an empty
workspace as a project with no checks.

`--scope` takes exactly three values. `full` (the default) runs every detected
check over the whole project; `touched` passes the file list to the only checks
that can honestly take one (a package-manager `lint` script, after a `--`
separator) and runs the rest whole, because a typecheck or a build cannot be
narrowed without lying; `+poc` is `full` plus the `poc` check, which prefers a
`test:poc`/`test:fuzz` script and otherwise runs the project's test script over
the `*.poc.test.*`, `*.fuzz.test.*` and `*.regression.test.*` files it finds.
Any other value is refused instead of silently treated as the default. `--files`
is repeatable and its values are comma-separated; without it, `touched` reads the
files from `git status --short` plus `git diff --name-only`. Only `touched`
consumes `--files`: under `full` or `+poc` the flag is ignored and the run says
so on stderr, naming the scope, so a narrowing that never happened is never
discarded in silence.

`nightqueue verify` **never installs anything** and never opens the network on
its own account: no `install`, no `ci`, no `--frozen-lockfile`. A missing
dependency is not guessed from the filesystem either - in a git worktree Node
resolves the parent checkout's `node_modules`, so an absent directory proves
nothing. The signal comes from the process's own resolution failure: the spawn
itself finding no binary (`ENOENT`), or a line the runtime wrote for itself -
`Error: Cannot find module …`, `ERR_MODULE_NOT_FOUND`, a shell line ending in
`: command not found`, Windows' `is not recognized as an internal or external
command`, `executable file not found in $PATH`. Such a check is `FAILED` with
`dependencies not installed — nightqueue verify never installs` as its first
snippet line. The match is anchored to those lines: a check that legitimately
fails and happens to quote one of the phrases inside its own message keeps its
real reason. A declared check that could not
run is never dressed up as a `SKIPPED`. The repository under test is not written
to at all: no install, no `git add`, no formatter, no lockfile write. (The
project's own checks are still the project's own - a `go build` or a test that
calls a service may reach the network; that is the repository's business, not
this command's.)

Every check is spawned against a throwaway `NIGHTQUEUE_HOME` and
`CLAUDE_CONFIG_DIR`, created under the system temp directory and removed when the
command exits, so a check that itself runs `nightqueue` never touches the
operator's home. That covers the checks `verify` spawns and nothing else: a
`nightqueue` command typed by hand still needs its own throwaway home, which
`nightqueue sandbox` provides.

The last check, `diff-hygiene`, needs no script. It reads `git status --short
--untracked-files=all` and `git diff --stat` in the current directory: the first
snippet line is the summary of `git diff --stat` (`no tracked file changed` when
there is none), the scale of the change, and the check is `FAILED` when a path
under `.claude/`, a lockfile or `tmp/` appears in the working tree, with the
intruding paths listed under the summary. Outside a git repository the check is
`SKIPPED`.

## Studio

```sh
nightqueue studio                        # serve the studio on 127.0.0.1:4747 and open it in the browser
nightqueue studio --port 0 --no-open     # any free port, print the URL only
nightqueue studio --api-only --port 4747 --token <t> --dev-origin http://127.0.0.1:5173   # what `npm run studio:dev` starts
```

`nightqueue studio [--port <n>] [--token <t>] [--api-only] [--dev-origin <url>] [--no-open]`
serves nightqueue studio, the local web cockpit, on `127.0.0.1` only. One process answers:

- the built page, `studio/dist` of the installed package (a missing dist is warned about on
  stderr and the page answers a minimal "Studio not built" with `503`; the API and `/mcp` keep
  working);
- `/mcp`, the same stateless Streamable HTTP endpoint as `nightqueue mcp --http`;
- `/api`: `GET /api/info`, `GET /api/projects`, `POST /api/runners/start` (a watch runner,
  with an optional `from`/`until` window), `POST /api/queue/pause|resume`,
  `GET /api/jobs/<ref>/log` (the last mebibyte of the job's log, as text) and
  `GET|POST /api/terminals`, `DELETE /api/terminals/<id>` (below);
- `/events`: a server-sent event stream with the `queue_status` snapshot and, every second,
  the patch of what changed; `/events?job=J-<n>` streams the narrated current attempt of one
  job, its phase timeline and its touched files;
- `/term/<id>`: the WebSocket of one embedded terminal (below).

The process also runs the maintenance timer of the home, as `mcp --http` does; the
`/events` poll itself only reads.

**Token.** `--token`, else `NIGHTQUEUE_STUDIO_TOKEN`, else a random one per start. The
command prints `studio listening on http://127.0.0.1:<port>/?t=<token>` and opens that URL
unless `--no-open` (or `--api-only`) is given. The first load trades `?t=` for an HttpOnly,
`SameSite=Strict` cookie named `nq_studio_<port>` and redirects to the same page without the
token. From then on every request - page, asset, `/api`, `/events`, `/mcp` - is refused
with 401 unless it carries that cookie or `Authorization: Bearer <token>`. A restart needs
the new URL.

**Security.** The `Host` must be loopback and any `Origin` must be loopback (a repeated
one is refused), as for `mcp --http`. A request that changes state (`POST /mcp`, `POST` or
`DELETE /api/*`) authorised by the cookie must also carry the studio's own origin exactly, port
included, so a page served on another local port cannot drive the queue. A `/term/<id>`
upgrade needs that exact origin from every caller, the bearer one included, and any other
upgrade is refused with a short HTTP answer (see [the runtime
contract](runtime-contract.md)). No response
carries CORS headers, and every one carries a strict `Content-Security-Policy`,
`X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer`.

**Terminals.** The studio can embed a `claude` terminal, shown in a dock at the bottom of
every page (tabs, a height kept in the browser, hide, full page at `/terminal/<id>`) and
drawn by xterm.js. It needs the optional dependency `node-pty`; on darwin the studio makes its
`spawn-helper` executable (`0755`) inside nightqueue's own runtime the first time it loads it.
Without `node-pty`, or when it fails to load, the install still succeeds, `GET /api/terminals`
answers `available: false` with the reason, a create answers `503`, and every entry point
shows `terminal unavailable: <reason>` with the command to copy instead
(`nightqueue queue session J-<n>`, `nightqueue open <project>` or `nightqueue open`).

`POST /api/terminals` takes only `{kind, job | project?, instruction?}`; any other key, `cwd`
included, is a `400`: the directory, the session and the binary always come from the job row,
its run state and the project registry. Two kinds exist:

- `session`: runs `nightqueue queue session J-<n>`, which resumes the job's Claude session in
  its worktree, or the project checkout when the worktree was released. Only a job in `gate`,
  `failed`, `done` or `cancelled` is accepted; any other status is a `409` naming it. One live
  session per job: a second create returns the same terminal (`reused: true`), or a `409` when
  it carries an instruction.
- `operator`: runs `nightqueue open`, the operator session in the nightqueue home, with
  `<project>` preselected when the body names one (`nightqueue open <project>`). A named project
  must be registered (`404` otherwise, `400` when blank); one whose checkout is gone still
  opens.

Both run the current runtime's CLI (`node <runtime>/bin/nightqueue.mjs`), which starts
`claude` exactly as when typed, with `TERM=xterm-256color`, 120x32, as foreground children of
`nightqueue studio` - never detached. The child's environment is the studio's minus every
`NIGHTQUEUE_STUDIO_*` variable, so the studio's token never reaches `claude` or the tools it
runs. Both go through the operator launcher, so opening a terminal runs `git worktree prune`
in every registered checkout, with no `--expire` (every stale worktree entry, one whose
directory is gone, is dropped at once, not after git's own expiry). At most 6 terminals
are open at once; the 7th is a `409` (`6 terminals are open, the cap; close one first`). A
create from inside a job against the runner's own home is a `403`. An optional `instruction`
(at most 1000 characters, refused above, never cut; control characters and newlines become
spaces; one that starts with `-` is refused) is passed as `--prompt`; claude submits it once
its own prompt is up, and the studio never types into the terminal on your behalf. The listing
marks it `given`. The listing (`GET /api/terminals`) is in memory; an exited terminal stays in
it as `exited` for 60 s.

Hiding the dock or switching tabs ends nothing. `DELETE /api/terminals/<id>` (the tab's `×`,
after a confirm) sends `SIGHUP` to the process group of the `nightqueue` child, which holds
`claude` and its MCP servers and tools, and `SIGKILL` 2 s later if anything of it is still
alive. When the `nightqueue` child ends while something of its group still runs, the studio
ends the group the same way. Ctrl+C on `nightqueue studio` does
the same to every terminal before the server closes, and an exit handler sends `SIGKILL` to
whatever is left. A studio that died without that cleanup is covered by the registration
files described in [the runtime contract](runtime-contract.md): the next start on that port
reaps them. `nightqueue doctor` reports whether `node-pty` loads (`studio terminal`).

The entry points are `Resume in terminal` on a job page (disabled, with the reason as its
tooltip, outside the four statuses; `Copy session cmd` stays beside it), and
`Operator` in the header, never disabled: home mode with the project picked in the queue
toolbar preselected, or no project on all projects.

**Development.** `--api-only` serves no page; `--dev-origin <url>` (only with `--api-only`,
a loopback `http://host:port`) is the second origin the write rule and the `/term` upgrade
accept. `npm run studio:dev` starts both sides: this API on port 4747 and the Vite dev server
on `http://127.0.0.1:5173`, whose proxy adds the bearer token, `/term` included. It sets
`NIGHTQUEUE_STUDIO_SPAWN_SELF=1` on the API side, so its terminals run the working tree's
CLI (the tree the studio runs from) instead of the installed runtime's.

## Sandbox

```sh
nightqueue sandbox node --version   # runs `node --version` against a throwaway home
```

`nightqueue sandbox <command> [args...]` runs exactly one command with a
throwaway `NIGHTQUEUE_HOME` and `CLAUDE_CONFIG_DIR`, both created before the
command starts and removed once it exits, whatever the exit code — the same
isolation `verify` gives its own checks, offered for a `nightqueue` command
typed by hand. The rest of the environment and the current directory are
inherited unchanged, and the command's own arguments are never parsed by
`nightqueue`: everything after `sandbox` is forwarded verbatim, so a flag like
`--version` reaches the wrapped command instead of the CLI. Stdin, stdout and
stderr are inherited, and the exit code is the child's own — 128 plus the
signal number when the child was killed by one, or `127` with a message on
stderr when the command itself could not be spawned (for example, an unknown
binary).

`nightqueue sandbox worktree` was removed: it exits 1 with a pointer, since a job's worktree
(`queue add`) or a run's own worktree covers QA, and `nightqueue doctor` lists what it left
under `<NIGHTQUEUE_HOME>/qa/` as read-only `qa (legacy)` rows.

Inside an operator session, `nightqueue sandbox worktree` is in the never band, and
`nightqueue sandbox <cmd>` is a `run` that needs the person's consent (see [Open](#open)).

## Open

```sh
nightqueue open                          # the operator, in the nightqueue home; the project of this checkout, if any, preselected
nightqueue open my-app                   # the same with a registered project preselected by name (or id), from any directory
nightqueue open --resume <session>       # resume an operator (or job) session
nightqueue open my-app --prompt "Analyse the login failure"   # start the session with a request
```

`nightqueue open [project] [--resume <session>] [--prompt <text>]` starts an interactive `claude` with the
`nightqueue:nightqueue-operator` agent as the main thread (`--append-system-prompt` with the
agent's body when `claude --help` does not list `--agent`; `nightqueue doctor` reports which),
the operator settings, `--setting-sources user,project,local` (the operator loads the person's own
MCP servers, plugins and settings; a queued job's child keeps `--strict-mcp-config
--setting-sources project`), the plugin and the nightqueue MCP server (its `--mcp-config` entry
wins over a same-name user-scope one), and `NIGHTQUEUE_MODE=operator`, which puts the guard hook in operator
mode (below). It never holds the config lock.

**Home mode.** The operator is generalist: the session always runs in the nightqueue
home (`NIGHTQUEUE_HOME`, `~/.nightqueue` by default), never in a checkout, and a missing home is
refused with one line naming `nightqueue setup`. A project is only *preselected*: the one named
(`open <project>`, by name, else by id; an unknown one is refused, a registered project whose
checkout is gone still opens), else the one registered for the current directory, else none.
The preselection reaches the session as `NIGHTQUEUE_PROJECT=<project id>` and nothing else; the
SessionStart hook then opens its context block with `Current project (preselected by nightqueue
open): <name>`, even when the project has no memory yet, and the memory hooks and `/nightqueue:reflect`
read that project. The block also carries a `Registered projects` section (`name · key · <n>
pending`, pending jobs only, the preselected project first, at most 30 lines), so with no project
the operator lists the registered ones from it and asks which, in an opening message with no tool call.
`NIGHTQUEUE_OPERATOR_PID` carries the pid of the `nightqueue open` process. `NIGHTQUEUE_OPERATOR_SESSION` carries a fresh ULID each launch
mints (a resume is a new launch, so a new id), pinned both in claude's env (the hooks read it)
and in the MCP server's env inside `--mcp-config`: it keys the session's consents (below). A
`NIGHTQUEUE_PROJECT`, `NIGHTQUEUE_MODE`, `NIGHTQUEUE_OPERATOR_PID` or
`NIGHTQUEUE_OPERATOR_SESSION` inherited from the caller is never passed on, and a job a runner
started from inside an operator session never inherits any of them. Every job-scoped variable
(`NIGHTQUEUE_JOB_ID`, `NIGHTQUEUE_JOB_HOME`, `NIGHTQUEUE_JOB_CLAUDE_DIR`, `NIGHTQUEUE_JOB_CLAIM`,
`NIGHTQUEUE_CLOSE_WORKER`) is removed from the session's environment too, so a session opened from
inside a job never acts as that job.

The session runs with `--permission-mode default`, whatever a checkout's local settings say, so
Claude Code's own permission prompt is always there; a queued job keeps `bypassPermissions`.

With `--resume <session>` the cwd is the directory the session was born in (the first `cwd` its
transcript under `CLAUDE_CONFIG_DIR/projects` records, when that directory still exists), else
the current directory when it lies inside the preselected project's checkout, else the home:
claude only resumes a session from the directory it was born in.

Before claude starts, `git worktree prune` runs in every registered checkout that exists, with
no `--expire`: every stale worktree entry (one whose directory is gone) is dropped at once, not
after git's own expiry; a failure is one warning line. `queue session` and a studio terminal
run it too, through the same launcher.

**Spawn profile.** The operator's argv comes from the same builder as a queued job's and the
merger's: `profileArgs({ kind: "operator" })` in `src/host/session-profile.mjs`, the
`operator` kind carrying `--permission-mode default`, `--setting-sources user,project,local`
and no `--strict-mcp-config` (see `Spawn profile` in [the runtime contract](runtime-contract.md)).

**The guard.** The operator investigates, plans, queues, and makes a small change on the
person's checkout once the person consented to it. The PreToolUse hook of an operator session
(matcher `Agent|Task|Bash|Read|Grep|Glob|Edit|Write|MultiEdit|NotebookEdit`) judges every call
of the main thread and of every subagent it launched under three bands, and answers every
refusal with one line starting `operator guard:`:

- **free**: `Read` is the operator's only file tool (Claude Code 2.1.3xx ships neither `Grep`
  nor `Glob`; the guard still judges them when a host ships them). They read anything on disk except `secrets.json` and any
  `.env*` file (`.env`, `.env.local`, …); a `Grep` whose `path` is the home or a parent of it is
  refused because the sweep would read `secrets.json`, a path that cannot be resolved is
  refused, and an absolute Glob `pattern` or Grep `glob` is judged by its static prefix. The
  main thread's free Bash is one bare command (no unquoted `;`, `&&`, `|`, redirection or
  substitution, no unclosed quote, no backslash) that is either `nightqueue|nq <command> …` with `<command>` one of `queue`,
  `project`, `org`, `connection`, `doctor`, `memory`, `lesson`, `libs`, `version` - never
  `queue session`, `project add|move` or `doctor --fix`, never `--follow` or `--foreground` -
  or `git -C <dir> [--no-optional-locks] <read> …` on a registered checkout, `<read>` one
  of `log`, `show`, `diff`, `blame`, `ls-tree`, `ls-files`, `rev-parse`, `branch --list` and
  `--no-optional-locks status` (never `--output*`, `--ext-diff`, `--no-index`, `--exec`, nor a
  global option other than `-C`, `--no-optional-locks` and the two hardening `-c` pairs below).
  Search is `grep`, free only as `git -C <checkout> -c core.fsmonitor=false
  -c core.hooksPath=/dev/null --no-lazy-fetch grep [--cached] <options> <pattern> -- [<paths>]
  ':(top,exclude,glob)**/.env*'` (or `cd <checkout> && git -c core.fsmonitor=false
  -c core.hooksPath=/dev/null --no-lazy-fetch grep … -- ':(top,exclude,glob)**/.env*'`), the
  same `-C` spelling in a job worktree, with no other global option, full option names from an
  exact allow list, OR written `-e a -e b`, and every glob, brace or parenthesis quoted
  (`-- 'src/*.mjs'`, `'('`). `--no-lazy-fetch` keeps a promisor remote in the shared
  `.git/config` from running its fetch program (a missing object errors instead). The exclusion
  pathspec after `--` is required, so no tracked `.env*` file the Read rule refuses is printed
  (`.envrc` and other `.env*`-prefixed names are left out too). It searches only the working
  tree or the index (`--cached`): any revision (a ref, `HEAD`, `HEAD~n`, `'HEAD@{n}'`, an
  object id, `<rev>:<path>`) or a path before `--` is never, since a ref can name a blob no
  pathspec filters; search history with `git -C <dir> log -S<text>` or read a commit with
  `git -C <dir> show <rev>`. The plain `git -C <checkout> grep …` and the spelling without
  `--no-lazy-fetch` or the exclusion are never, and the reason shows the full spelling, so no
  program planted in the shared `.git/config` runs. `-O`/
  `--open-files-in-pager`, `-f`, `--textconv`, `--no-index`, `--untracked`, `--ext-grep`,
  submodule options, an abbreviation or any option off the list are never. A free command holding
  an unquoted `* ? [ ] { }`, which zsh expands, is not free and its refusal says
  to quote it (`git -C <checkout> show 'HEAD@{1}'`, not `HEAD@{1}`).
  The root of a job worktree under the home whose `.git` points to the admin dir git keeps for
  it in the checkout's `.git/worktrees` is read only hardened, `git -C <worktree>
  -c core.fsmonitor=false -c core.hooksPath=/dev/null [--no-optional-locks] <read>` (`stash
  list` also reads there), `status` and `diff` with `--ignore-submodules=all`, never another
  `--submodule*` or `--recurse-submodules`, nor an abbreviation git accepts for one
  (`--ignore-submod=none`); any other spelling there is never. A subagent's
  free Bash is one bare nightqueue read
  (`queue status|log`, `project list`, `org list`, `connection list`, `memory stats`, `doctor`
  without `--fix`, `libs`, `version`), the main thread's `git -C` reads (also written
  `cd <checkout> && git <read>`), `gh pr view|diff|checks|list|status` or `gh issue view|list`.
  `Agent`/`Task` launches any plugin agent but the operator itself, spelled
  `nightqueue:<name>` or `plugin_nightqueue_<name>` (`architect`, `coder`, `explore`, `merger`,
  `qa-guardian`, `reflector`, `reviewer`, `triager`, `verifier`); a bare name is refused.
- **with consent**: a write (`Edit`, `Write`, `MultiEdit`, `NotebookEdit`) is `edit` on an
  existing path and `create` on a new one, and an `edit` outside every registered checkout is
  refused; any other Bash is `git-write` (a git subcommand that is neither a read nor never:
  `add`, `commit`, `push`, `checkout`, `stash`, `merge`, …) or `run` (`nightqueue verify` and
  `nightqueue sandbox <cmd>` included). It must be one bare command written
  `cd <registered checkout> && <command>`, `git -C <registered checkout> <command>`, or bare
  with the cwd inside a checkout; any other shape, a glob or brace character (`* ? [ ] { }`)
  included, is refused with the accepted form. `nightqueue doctor --fix` is a `run` from any
  directory, covered only by a consent naming `--fix`, and only spelled so: another spelling of
  the program (`/abs/bin/nightqueue doctor --fix`) or a wrapper before it (`env`, `nice`,
  `sudo`, `FOO=1`, `stdbuf`, `sh -c`; only a leading `timeout <n>` may lead) is never. git and
  home maintenance behind a wrapper, or git spelled by its path (`/usr/bin/git`), are refused
  as a request and as a consent scope, and a consent covers exact words, wrappers included
  (`run env NODE_ENV=test npm test` never covers `npm test`). `home-maintenance` removes ONE run
  dir or worktree of the home (`rm -rf <home>/runs/<project id>/<slug>`, `find <entry> -delete`,
  `git -C <checkout> worktree remove <absolute worktree path>`) or runs
  `git -C <checkout> worktree prune`, on the main thread only, and covers that exact command:
  an absolute or `~/.nightqueue/` path, never a relative one, a glob, a brace, a wrapper or
  `sh -c`. git maintenance runs with the project's checkout as its git dir (`git -C <checkout>`
  or `cd <checkout> &&`), never a worktree's, and `git worktree remove|move` of a worktree not
  named by its absolute path (`.`, a bare name, `../…`, a link) is never. `git worktree
  remove|prune` is never `git-write`. Salvage from a worktree of a closed or cancelled job is
  `git -C <worktree root> format-patch` (`git-write`, its `.git` pointing to git's admin
  dir) or `cd <checkout> && cp <worktree>/… …` (`run`); `git stash` of a worktree under the
  home is never. A path is judged as the entry stored on
  disk, so a case variant names the same owner. Before the grant and again on every call, the
  guard looks up the job that holds the entry (its slug, its start worktree or its run state's worktree) and refuses as never when
  it is `pending`, `running`, `gate` or being closed (`<path> belongs to J-248 (gate)`), when
  the worktree is locked by a live process or by hand, or when the queue cannot be read; a
  `done` owner with a pull request holds until `gh pr view` (3 s for the whole decision, each
  pull request read once, in parallel, inside the hook's 5 s) answers merged or closed (`<path> belongs to J-248 (done, pull request <url> is open)`; a
  draft, conflicts, a gh failure, `NIGHTQUEUE_NO_PR_CHECK=1` or a non-GitHub URL hold too),
  and a `done` job with no pull request does not hold;
  salvage also refuses a
  `done` or `failed` owner. It passes
  only when a live consent of the session covers it, else
  `operator guard: needs consent (<kind> <scope>): ask the person …, record the answer with operator_consent, then retry`.
- **never**, refused even with a consent: deleting files (`rm`, `rmdir`, `unlink`, `shred`,
  `find -delete`, `-exec rm`) but the one `home-maintenance` entry above (so `runs/`,
  `worktrees/`, a project's whole directory, `.by-id`, `.start-points.lock`, `logs/`,
  `nightqueue.db*` and the rest of the home stay never), `git push` with `--force*`/`-f`/`--delete`/`--mirror`/`--prune`
  or a `+`/`:` refspec, `git branch -D|-d`, `git reset --hard`, `git clean`, `git rm`, writing
  the nightqueue home, the Claude config dir, `~/.codex`, any `.claude/settings*.json` or
  anything inside a `.git` directory (its config and hooks run commands; `.gitattributes` stays
  editable), naming `.env*` or `secrets.json` (a `<rev>:<path>`, a glob that could match one
  and a brace that expands to one included), the refused nightqueue forms
  (`queue add --run`, `queue session`, `project add|move`, `open`,
  `sandbox worktree`, …), `sh -c`/`eval` text, and a git global option other than `-C <dir>`,
  `--no-optional-locks`, `--no-pager` and the exact `-c core.fsmonitor=false` /
  `-c core.hooksPath=/dev/null` pairs (`--config-env`, `--attr-source`, `--git-dir`,
  `-c <other>`, `--`, an unknown flag), behind every wrapper. Any command with an unquoted `(`
  or `)` is never (``operator guard: never (an unquoted `(` or `)` lets zsh run a command:
  quote it)``), since zsh runs a program through `=(…)` or a glob qualifier `*(e:…:)`; a quoted
  `'('` stays allowed. Any command with an unquoted `#` is never too, since zsh reads it as a
  comment that drops the rest of the command, or as a pattern operator under EXTENDED_GLOB;
  `'#'` and `"fix #12"` stay allowed. Any command with an unquoted `^` anywhere in a word is
  never as well, since zsh reads it as a pattern operator under EXTENDED_GLOB (`--^x`, `HEAD^`);
  `'^main'` and `"HEAD^"` stay allowed. Any command with a control character other than a tab
  or a newline is never, quoted or not, since zsh cuts a word at a NUL byte. A git command run after a `cd` into a job worktree is
  never, and its reason names `git -C <worktree>`, the only way a worktree is read. A path is judged where it really points: a
  symlink, a dangling one included, is followed. Every segment of a chain is scanned, relative
  words against the cwd and then each `cd`, so `cd <checkout> && rm -rf x` is never, not a
  shape refusal.

**Consents.** The `operator_consent` MCP tool records what the person said yes to, in an
append-only JSONL file `<home>/operator/<session>.jsonl` (never in a checkout), one event per
line: a grant carries the kind, the scope, the reason and the person's answer quoted verbatim;
a revoke (`revoke: true`) withdraws the live grants of the same project, kind and scope. Each
event also appends one line to the session log `<home>/logs/operator-<session>.log`
(`<ISO> consent <kind> <scope> · <project> · "<answer>"`, or `<ISO> revoke …`). A scope is
exactly what was consented and nothing wider is inferred: a path covers itself and what lies
under it; a command consent is a prefix of words: it covers every command that opens with
them, run in that project's checkout (`npm test` covers `npm test -- --grep x`, never
`npm run build`; `git push origin` covers a push of any ref), so the ask shows that reach; a
`home-maintenance` consent covers only its exact command, word for word, in its own project;
`<connection> <METHOD> <path>` covers that request with any body, and in an operator session
`connection_call` answers `needs-consent` to a POST, PATCH or PUT no live `connection-write`
consent covers, or when the record cannot be read, sending nothing. A scope with a newline,
tab or other control character, or a command scope with a glob or brace character, is
refused. Consents end with the
`nightqueue open` process: a resumed session starts with none. Inside a job, or outside an
operator session, the tool is refused.

The runtime record is the audit and the guard; the host's permission prompt is the barrier
for `Edit`, `Write`, `Bash` and the person's own MCP servers. `operator_consent` and `connection_call` are pre-approved
MCP tools, so no prompt stands before them: for them the guard's record is the only control,
and the operator agent never calls either without the person's answer in the conversation.
An allowed call answers nothing, never `allow`, so Claude Code still prompts for it, and the
never band does not rely on the prompt.

A registry that cannot be read refuses `git -C` (the reason names `nightqueue doctor`), a
consent record that cannot be read or an error inside the guard refuses every tool but the
reads, and an edit, `Bash`, `Agent` or `Task` call whose `tool_input` is not an object is
refused: the operator guard fails closed, unlike a job's.

**Direct changes.** For a small change, the operator states the scope, asks consent for `edit`
(+`create`) and `run`, records each answer, and launches `nightqueue:coder` on the person's
current checkout and branch, with no worktree; then optionally `nightqueue:verifier` and
`git -C <checkout> diff --stat`. No commit, push or pull request without a `git-write`
consent. A direct change is no job: nothing is queued, and no telemetry is recorded.

A fresh session opens with the operator's greeting: who it is (the nightqueue operator), the
preselected project or the list of registered ones (from the session block, no tool call), what it does, what needs the person's consent, and
where to start. A resumed session is not greeted again. The `nightqueue` MCP tools are
pre-approved for the session (`permissions.allow: ["mcp__nightqueue__*"]` in the settings it
is started with), so the operator never asks before reading the queue or the
memory; every other tool keeps Claude Code's own prompts. That covers the person's own MCP
servers (user, project and local scope, and their user-scope plugins): nightqueue pre-approves
none of them, the guard passes them to the host prompt, and the person's own allow rules apply.
A guard `deny` still wins over a user allow rule. The operator agent has no `tools:` allowlist,
since `mcp__*` there matches nothing: it inherits every tool and its `disallowedTools` drops the
built-ins it never had (listed against Claude Code 2.1.312), `RemoteTrigger` included, which
only a claude.ai login exposes.

`--prompt <text>` starts the session with that request instead of the opening prompt (after
`--resume <session>` when resuming): it is passed verbatim as claude's first positional
prompt, which claude submits itself once its own prompt is up, after any startup dialog
(workspace trust, MCP approval) has been answered. A value that starts with `-` or is empty is
refused. A value that is exactly one of claude's command names (`mcp`, `update`, `purge`,
`plugin`, `help`, ...) is passed with one trailing space: claude dispatches its first operand
as a command when it names one, even after `--`, so the bare word would run that command
instead of opening the session with it as the first message. The text is on the command line of the `claude` process (and of `nightqueue`
itself), so `ps` shows it to any user of the machine while the session runs; do not put
secrets in it.

## Chat

```sh
nightqueue chat                          # plain claude with the plugin, recorded as a session
nightqueue chat coder                    # a built-in agent as the main thread
nightqueue chat rev --project my-app     # your own agent, in the project's checkout
nightqueue chat coder --worktree ~/.nightqueue/worktrees/<project id>/<slug>   # work inside a job worktree
nightqueue chat --resume <id>            # resume a recorded session with its agent and directory
nightqueue chat operator                 # the same as `nightqueue open`
```

`nightqueue chat [agent] [--project <p>] [--worktree <path>] [--resume <id>] [--prompt <text>]`
starts an interactive `claude` (the `chat` spawn profile) with the plugin, the nightqueue MCP
server, `--permission-mode default` and `--setting-sources user,project,local`, so Claude Code's
own permission prompts and the person's MCP servers, plugins and settings apply. With no agent it
is plain claude with the plugin; a built-in agent goes as `--agent nightqueue:<name>`, and one of
yours (below) as `--agents <json> --agent <name>`. `chat operator` (or `nightqueue-operator`) runs
`nightqueue open` unchanged: the operator keeps its own launch and guard and is never recorded.

**Where it runs.** `--worktree <path>` on a directory outside the nightqueue home runs there.
Under the home it must lie in a git worktree under `<NIGHTQUEUE_HOME>/worktrees` (its `.git` is a
file whose `gitdir:` still exists); the directory you gave stays the cwd, a subdirectory included,
and its `<project id>/<slug>` entry becomes the session's own worktree. A worktree whose git
directory is gone is refused, and so is any other path under the home. Without `--worktree` the
session runs in the project's checkout (the one named by `--project`, else the one registered for
the current directory), else in the current directory, judged by the same rules: a chat never
runs in the nightqueue home itself (pass `--project`, `--worktree` or run it from another
directory). Nothing stops a chat from editing a worktree a queued job is running in: you chose the
path.

**Sessions.** Each chat is recorded in `<NIGHTQUEUE_HOME>/sessions/<ULID>.json` with the Claude
session id it was launched with (`--session-id`), so `--resume <id>` runs `claude --resume` in the
recorded directory, with the recorded agent and worktree. A resume is refused for an unknown id, a
session still open, a directory that no longer exists, or a session closed before its first
message (no transcript). `--resume` takes no agent, `--project` nor `--worktree`. A launch holds an
exclusive claim, `<NIGHTQUEUE_HOME>/sessions/<ULID>.launcher` (its pid and start time), so two
resumes of one session never run at once; a session is live while that launcher still runs, and a
claim left by a launcher that died is taken over by the next resume, under a short
`<ULID>.launcher.takeover` lock. The record itself is never
rewritten after it is created.

```sh
nightqueue sessions list [--json]        # newest first: id · live|stopped · agent · project · cwd · last update
nightqueue sessions show <id> [--json]   # the record, its transcript and the resume command
nightqueue sessions rm <id>              # removes the record only, never the worktree nor the transcript
```

**Agents.** `nightqueue agent list [--json]` lists the plugin's agents and yours;
`nightqueue agent new <name>` writes a skeleton to `<NIGHTQUEUE_HOME>/agents/<name>.md` (never in
a project repository), ready to edit and use with `nightqueue chat <name>`; `nightqueue agent show
<name>` prints one. A user agent needs a `---` frontmatter with `name` (lowercase letters, digits
and `-`, equal to the file name) and `description`; `tools` (comma list, `[a, b]` flow list or
`- item` list) and `model` are optional, a ` # comment` after a plain or quoted value is dropped, and a
nested list or map is refused rather than guessed; the body is its prompt (at most 100 KB). A
built-in name, `operator`, and Claude Code's own agent names are refused; an invalid file is
listed as a warning and never loaded. `nightqueue:<name>` names a built-in only; call your own
agent by its bare name.

**The chat guard.** A chat session carries one PreToolUse hook, `nightqueue hook chat-guard`
(Bash and the edit tools, 10 s timeout, fail closed):

- **never** (denied, no prompt): the never band of the operator — reading secrets or `.env*`,
  writing under the nightqueue home, Claude/Codex settings or a `.git` directory, a force push,
  a branch delete, a hard reset, `git clean`, and every nightqueue command that writes the home or
  nests a session. A command that mixes a delete with any of these is denied as a whole.
- **ask**: a file delete (`rm`, `unlink`, `find -delete`, `git rm`, the same inside `sh -c`,
  `bash -lc` or `eval`) shows Claude Code's own permission prompt naming the command; approving
  runs it once, refusing keeps the files. Nothing is recorded. Deleting the nightqueue home, a
  directory that holds it, or the session worktree itself stays never, and so does a delete of a
  glob that could match `.git` (`.g[i]t`, `.git*`) or of a path the shell computes (`$…`, a
  command substitution). Every word after a shell's `-c` is read as its script, a wrapper such as
  `setsid`, `stdbuf`, `ionice` or `doas` is looked through, and a shell reading its script from
  stdin (`… | sh`, `bash <<< …`, `sh < file`) asks, its quoted text judged as the script.
- **the session's worktree**: edits inside the worktree recorded for the session are allowed,
  except its `.git`, `.env*` and Claude settings; every other worktree and the rest of the home
  stay never. In Bash every word is read the way the shell reads it, from the real cwd, so a
  relative path (`src/a.mjs`, `.`, `../x`) is judged as the path it names: inside the session
  worktree it is free by any relative spelling, and `../../../secrets.json` is refused like its
  absolute twin. Name the worktree's files by relative paths: an absolute path under the home is
  still judged as the home.
- **the second line**: past the guard, Claude Code's own permission prompt decides
  (`--permission-mode default`), so every Bash command outside Claude's built-in read-only set
  asks you, including a delete the guard cannot read (`python3 -c "import os; os.remove(...)"`,
  `perl -e unlink`, `rsync --delete`, `bash script.sh`). Your own pre-authorization (an allow rule,
  "Yes, and don't ask again", auto mode) lets such a program run unprompted: that grant is your
  authorization. A delete the guard does recognise keeps forcing the prompt over an allow rule.

## Libs

```sh
nightqueue libs zod express        # the INSTALLED version of each name, one line each
```

`nightqueue libs <name>...` prints one `<lib> <version>` line per argument, in
the order the arguments were given, read from the lockfiles of the current
directory. It reports the version that is **installed**, never the range the
manifest declares. A name no lockfile carries prints `<lib> not-found` rather
than no line at all, so the caller can always zip its input to the output, and
the exit code is `0` either way: `libs` is a report, not a check.

The lockfiles are read in this order, the first one carrying the name answering:
`package-lock.json` (v1, v2 and v3), `pnpm-lock.yaml`, `yarn.lock` (classic and
berry), `poetry.lock`, `requirements.txt`, `Cargo.lock`, `go.sum` and `go.mod`.
`bun.lockb` is deliberately **not** read - it is a binary format that would need
a `bun` subprocess - so a bun-only project reports every name `not-found`.
Python names are matched the way pip identifies a distribution (case-insensitive,
`-`, `_` and `.` equivalent); crate names are matched exactly, because
`serde_json` and `serde-json` are different crates.

The command opens no network connection, spawns no subprocess, reads no database
and writes nothing; it looks only at the current directory, never at a parent.
A directory with no lockfile at all still prints a `not-found` line per name on
stdout and says why on stderr, exiting `0`. A lockfile that exists but cannot be
read or parsed is a user error (exit `1`) naming the file, instead of a silent
`not-found`.

## Run

```sh
nightqueue run --help                                      # the steps, one usage line each
nightqueue run index-save <RUN_DIR>/02-explore.md          # persist an explore artifact into the project index
nightqueue run index-save <artifact> --repo-root ~/code/api --project api
nightqueue run secrets-sweep --files src/a.js,src/b.js     # log calls that may print a secret
```

`nightqueue run <step>` holds the mechanical steps the pipeline's agents used to
perform by hand. It has exactly two steps, and `nightqueue run` with no step (or
`--help`) prints them.

**`index-save <artifact> [--project <name>] [--repo-root <path>]`** reads the
`## File map` and `## Third-party libraries` sections of an explore artifact
(`## Libs` is accepted as an alias for the second) and saves them into the
project index, so the Explore subagent no longer keeps two identical lists in
sync. It prints `index saved: N files, M libs` and exits `0`. `--repo-root`
(default: the current directory) is the path the file-map entries are stored
relative to, and `--project` defaults to that same path - the runtime resolves a
path inside a registered project to the project's name. The database is reached
only through the store, the same door the `index_save` MCP tool uses.

The file map is parsed strictly and the libs section leniently: a bullet that is
not `<path> — <responsibility>` is a user error (exit `1`) naming the line
number, because a dropped entry writes a silently incomplete index, while a libs
bullet that is not `<lib>@<version>` is skipped with a note on stderr (a `None`
bullet is the documented "no libs" marker and is not even reported). A missing
artifact, an artifact with no `## File map` and a repository that is not
registered are each exit `1` with a message naming what was missing.

Both paths are resolved through the filesystem, every component of them, before
anything is read: the artifact must be an existing **regular file** and
`--repo-root` an existing **directory**, each refused by name otherwise. Neither
is required to sit under the current directory - the pipeline's run directory
lives outside the worktree on purpose - and the write side stays bounded by the
store, which still refuses a repository that is not a registered project.

**`secrets-sweep --files <list>`** prints the log calls whose arguments may carry
a secret. `--files` is repeatable and comma-separated, the same shape `verify`
uses. For every file it finds the log calls of the sinks it recognises
(`console.*`, `logger.*`, `fmt.Print*`, `System.out.print*`, `printf`,
`println!`, `print`, `var_dump`, `puts` and their neighbours) and flags a call
whose argument identifiers - or the line where such an identifier is **defined in
the same file** - name a token, password, secret, key, cookie or credential. That
second hop is the point: the leak is rarely `console.log(apiToken)`, it is
`console.log(requestCurl)` where `requestCurl` was built from an
`Authorization` header. Each candidate is two lines:

```
<file>:<line>: <source line>
    def <file>:<line>: <definition line>
```

and the sweep ends with `secrets-sweep: N candidates in M files`. The match is on
identifier parts, not substrings, and string literals are blanked before the
arguments are read, so `console.log(keyboard)` and `console.log("token
refreshed")` are not candidates. The exit code is **always** `0` for a sweep that
ran - the command reports, the reviewer judges, and `0 candidates` is not a clean
bill of health. A file that cannot be read and a binary file are each named on
stderr and the remaining files are still swept; `--files` absent altogether is a
user error (exit `1`), which is not the same event as a `--files` list that is
empty. A file that resolves outside the current directory - by an absolute path,
by `..`, or through a symlinked component - is a user error (exit `1`) naming the
path: the sweep reads the files of the worktree it was called in and nothing
else. Nothing is written, and no database is opened.

