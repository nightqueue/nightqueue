# Developing nightqueue

`init` and `setup` install the package that is running: they pack it with
`npm pack` (honouring the `files` of its `package.json`) and install the tarball
into the runtime prefix. Nothing is ever linked, so the runtime never borrows the
`node_modules` of a checkout, and the registry is not consulted.

That is what makes a checkout testable end to end: `--from <dir>` packs that
directory instead, and `--from <file.tgz>` installs that tarball as it is. It
works the same on `setup`, on `init` and on `update`. Each of them installs into a
new `runtime/versions/<version>-<stamp>/` and moves the `current` link onto it, so
reinstalling from a checkout while a job is running is refused rather than pulled out
from under the runner - `--force` is the way to say you mean it anyway.

```sh
nightqueue setup --from ~/code/nightqueue   # install the runtime from a checkout
nightqueue update --from ~/code/nightqueue  # ...and again, after a change
nightqueue update --from ./nightqueue.tgz   # install a tarball exactly as it is
npm test                                    # the whole suite, hermetic, no network
npm run release:check                       # the suite, then the tarball and the versions
```

`npm run release:check` is the checklist before a release: it runs the suite,
refuses a working tree with uncommitted changes, runs `npm pack --dry-run` to
prove the tarball still builds, and checks that `package.json`, the top entry of
`CHANGELOG.md` and the `Licensed Work:` line of `LICENSE` all declare the same
version. Any divergence prints what disagrees and exits 1. It never publishes
anything.

Publishing itself is a pushed tag, never a local `npm publish`:
[RELEASING.md](RELEASING.md) has the four-step flow and the one-time npmjs.com setup that
the release workflow depends on.

## The studio

The studio's page is a Vite/React/TypeScript app under `studio/`; its build,
`studio/dist`, is git-ignored and shipped in the package. Its toolchain is
devDependencies only: the runtime dependencies stay the MCP SDK and zod.

```sh
npm run studio:dev     # the API-only studio on 127.0.0.1:4747 plus Vite with HMR on http://127.0.0.1:5173
npm run studio:build   # typecheck, build studio/dist and stamp it with the hash of the studio sources
```

`studio:build` writes `studio/dist/.stamp.json` with a sha256 of `studio/index.html`,
`studio/src/**`, the Vite and TypeScript configs and the installed devDependency
versions. `npm run release:check` recomputes it and refuses a missing dist, a missing
stamp or a stamp of other sources, and checks that the tarball carries
`studio/dist/index.html` and no studio source. The release workflow builds the studio
before that check.

The contributor flow is `nq update --from .`: a `--from <dir>` install (on `update`,
`setup` and `init`) checks the stamp of that directory first and builds nothing when
`studio/dist` is fresh. Otherwise it runs `npm ci` there when `node_modules` is missing
or `package-lock.json` differs from the `lock_sha256` the stamp recorded (`update
--no-install` only says so), then `npm run studio:build`, before anything is packed or
installed; a build that fails on a missing module or command installs once and builds
once more. A build that still fails or times out degrades only the studio step
(`studio: degraded - <error>`): the runtime is installed with the previous `studio/dist`,
if any. `--force` does not skip the check. Tarballs and the registry are installed as
they are.

## Schema steps that rewrite tables

A schema change that only adds (a table, an index, a column with a default) goes in
`src/memory/ddl.mjs` and the per-open `migrate()` of `src/memory/db.mjs`. A change that
rebuilds tables or has to fill a column row by row is a **one-shot step**: its own module
under `src/memory/migration/` (`v18.mjs`, `v19.mjs`), built on the shared machinery of
`migration/one-shot.mjs` - copy the file to `nightqueue.db.pre-v<N>`, re-check under the
write lock that the step is still pending, refuse while a runner holds a live lease
(naming the job `J-<id>`), then run the whole step in one transaction and stamp
`user_version`. A step describes itself as `{ version, backupPath, isPending,
migrateInside }`; the older shapes it rebuilds FROM are frozen copies under
`migration/` (`v18-shape.mjs`), never the current DDL. `initConnection` runs the steps
of `ONE_SHOT_STEPS` in order, each gate read after the previous step, so a v17 home goes
to v18 and then v19 in one migration, leaving both copies. A new step appends to that list,
freezes the shapes it changes, and adds a test that a migrated database has exactly the
`sqlite_master` of a fresh one (`test/memory/migration-v19.test.mjs` is the model).

`initConnection` migrates only when `migrateHomeDatabase` called it (the single migrating entry,
reached by `nightqueue update --schema-only`); every other open refuses an older database with
`SchemaOutdatedError` before writing anything. A test that builds an older fixture therefore
migrates it explicitly with `migrateTestHome(env)` from `test-support/migrate.mjs` (backup, then
migration, then the writable connection), never by opening it; an assertion about what a plain
open does on an older file expects the `SCHEMA_OUTDATED` refusal. A per-open step must write
nothing on a current database (`test/memory/db-outdated-refusal.test.mjs` opens a migrated home
twice and compares the file and its sidecars byte for byte): one that needs a write belongs in
the migration.

`scripts/` is not part of the published tarball. How to contribute — branches, commits,
the pull request template, what is off the table — is in [CONTRIBUTING.md](../CONTRIBUTING.md).

## Real pull request QA

The only target of a verification that creates, merges or closes a real pull request is
the maintainer's demo checkout `~/Dev/nstest-demo` (remote
`maykonVinicius/nstest-demo`) - never nightqueue's own repository or any other remote. The
pipeline and QA instructions (`plugin/skills/resolve/SKILL.md`, `plugin/agents/verifier.md`,
`plugin/agents/qa-guardian.md`, `plugin/skills/qa-guardian/SKILL.md`) carry this as a hard
rule, together with its twin: a nightqueue guard or its environment variables
(`NIGHTQUEUE_JOB_ID`, `NIGHTQUEUE_JOB_HOME`, `NIGHTQUEUE_JOB_CLAUDE_DIR`) are never unset,
stubbed or worked around - a verification that needs to is a gate for the operator.
`test/plugin-home-isolation.test.mjs` keeps the four copies identical.

That is why the real acceptance of `nightqueue queue close` is operator-run. An unattended
run is refused by `queue close` itself, so from your own terminal (no nightqueue job
variables set), in this checkout:

```sh
node scripts/close-demo.mjs                      # default demo checkout
node scripts/close-demo.mjs --repo <nstest-demo> # another clone of the same remote
```

It refuses to start inside a nightqueue job and refuses a checkout whose `origin` is not
`maykonVinicius/nstest-demo`. Otherwise it builds a throwaway home, registers the demo in
it, seeds each `done` job through the store and drives this checkout's real
`nightqueue queue close` over six scenarios: (i) a real merge that leaves the job `closed`,
(ii) a base that moved after the pull request opened (the conflict step's path is recorded
as it happened), (iii) a close interrupted after preflight and resumed, (iv) a second close
of the closed job refused with ``job `<id>` is already closed``, (v) a pull request on another
branch than the job's refused with `pr-not-the-job-branch`, and still refused with `--force`,
the pull request left open, and (vi) a pull request closed without merge (`gh pr close`)
that cancels the job, with nothing merged. It prints a pass/fail table, closes any scratch
pull request still open, deletes its branches and removes the throwaway home; it never
touches `~/.nightqueue`.

A queued job that changes the closing pipeline runs everything except the real merge
inside the job - the hermetic suite, a migration dry-run on a copy of the database, and the
refusal of `queue close` inside the job as evidence the guard works - and lists the real
close as pending. After its pull request merges, the operator runs the real close from
their own terminal and records the result as a comment on that pull request.

### The real close by hand

When the script is not enough - to watch each step, or to rerun one scenario - the same
acceptance runs by hand on the demo, from your own terminal and never inside a job, in one
`nightqueue sandbox` shell so the throwaway home lives across the steps:

1. `cd ~/Dev/nstest-demo`, then `node <nightqueue>/bin/nightqueue.mjs
   sandbox sh` (every later `nightqueue` below is `node <nightqueue>/bin/nightqueue.mjs`,
   this checkout's build, inside that shell).
2. Open a throwaway pull request: `git switch -c qa/close-<stamp> origin/main`, commit one
   scratch file, `git push -u origin qa/close-<stamp>`, then `gh pr create --repo
   maykonVinicius/nstest-demo --base main --head qa/close-<stamp> --title "close QA <stamp>"
   --body "throwaway"`.
3. `nightqueue project add "$PWD" --name nstest-demo`, then seed one `done` job for that pull
   request through the store, the way `seedDoneJob` in `scripts/close-demo.mjs` does
   (`addJob`, `claimJobById`, `persistRunFacts` with the branch `qa/close-<stamp>`,
   `finishJob` with `status: "done"` and the pull request URL) - never by SQL. The branch
   must be the pull request's head, or preflight stops at `pr-not-the-job-branch`.
4. `nightqueue queue close <id> --foreground` exits `0` after `✓ preflight`, `- conflict`,
   `✓ merge`, `✓ settle` and `J-<id> closed: PR #<n> merged as <sha7>`. When the checks
   are red it stops at `preflight` with `checks-red`: record that, then run it again with
   `--force`.
5. `nightqueue queue status J-<id> --json` shows `status: "closed"`, `close_status: null`,
   `close.data.merged: true`, and the notice ends with `Closed: PR #<n> ...`.
6. `nightqueue queue close <id>` and `nightqueue queue close <id> --foreground` both exit
   non-zero with ``job `<id>` is already closed``, and nothing is started.
7. Leave the shell (the sandbox removes its home), then delete the scratch branch:
   `git push origin --delete qa/close-<stamp>` and `git branch -D qa/close-<stamp>`.

