# Developing nightshift

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
nightshift setup --from ~/code/nightshift   # install the runtime from a checkout
nightshift update --from ~/code/nightshift  # ...and again, after a change
nightshift update --from ./nightshift.tgz   # install a tarball exactly as it is
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

`scripts/` is not part of the published tarball.

## Real pull request QA

The only target of a verification that creates, merges or closes a real pull request is
the demo checkout `~/Dev/nstest-demo` (remote
`maykonVinicius/nstest-demo`) - never nightshift's own repository or any other remote. The
pipeline and QA instructions (`plugin/skills/resolve/SKILL.md`, `plugin/agents/verifier.md`,
`plugin/agents/qa-guardian.md`, `plugin/skills/qa-guardian/SKILL.md`) carry this as a hard
rule, together with its twin: a nightshift guard or its environment variables
(`NIGHTSHIFT_JOB_ID`, `NIGHTSHIFT_JOB_HOME`, `NIGHTSHIFT_JOB_CLAUDE_DIR`) are never unset,
stubbed or worked around - a verification that needs to is a gate for the operator.
`test/plugin-home-isolation.test.mjs` keeps the four copies identical.

That is why the real acceptance of `nightshift queue close` is operator-run. An unattended
run is refused by `queue close` itself, so from your own terminal (no nightshift job
variables set), in this checkout:

```sh
node scripts/close-qa-demo.mjs                      # default demo checkout
node scripts/close-qa-demo.mjs --repo <nstest-demo> # another clone of the same remote
```

It refuses to start inside a nightshift job and refuses a checkout whose `origin` is not
`maykonVinicius/nstest-demo`. Otherwise it builds a throwaway home, registers the demo in
it, seeds each `done` job through the store and drives this checkout's real
`nightshift queue close` over six scenarios: (i) a real merge that leaves the job `closed`,
(ii) a base that moved after the pull request opened (the conflict step's path is recorded
as it happened), (iii) a close interrupted after preflight and resumed, (iv) a second close
of the closed job refused with ``job `<id>` is already closed``, (v) a pull request on another
branch than the job's refused with `pr-not-the-job-branch`, and still refused with `--force`,
the pull request left open, and (vi) a pull request closed without merge (`gh pr close`)
that cancels the job, with nothing merged. It prints a pass/fail table, closes any scratch
pull request still open, deletes its branches and removes the throwaway home; it never
touches `~/.nightshift`.

A queued job that changes the closing pipeline runs everything except the real merge
inside the job - the hermetic suite, a migration dry-run on a copy of the database, and the
refusal of `queue close` inside the job as evidence the guard works - and lists the real
close as pending. After its pull request merges, the operator runs the real close from
their own terminal and records the result as a comment on that pull request.

### The real close by hand

When the script is not enough - to watch each step, or to rerun one scenario - the same
acceptance runs by hand on the demo, from your own terminal and never inside a job, in one
`nightshift sandbox` shell so the throwaway home lives across the steps:

1. `cd ~/Dev/nstest-demo`, then `node <nightshift>/bin/nightshift.mjs
   sandbox sh` (every later `nightshift` below is `node <nightshift>/bin/nightshift.mjs`,
   this checkout's build, inside that shell).
2. Open a throwaway pull request: `git switch -c qa/close-<stamp> origin/main`, commit one
   scratch file, `git push -u origin qa/close-<stamp>`, then `gh pr create --repo
   maykonVinicius/nstest-demo --base main --head qa/close-<stamp> --title "close QA <stamp>"
   --body "throwaway"`.
3. `nightshift project add "$PWD" --name nstest-demo`, then seed one `done` job for that pull
   request through the store, the way `seedDoneJob` in `scripts/close-qa-demo.mjs` does
   (`addJob`, `claimJobById`, `persistRunFacts` with the branch `qa/close-<stamp>`,
   `finishJob` with `status: "done"` and the pull request URL) - never by SQL. The branch
   must be the pull request's head, or preflight stops at `pr-not-the-job-branch`.
4. `nightshift queue close <id> --foreground` exits `0` after `✓ preflight`, `- conflict`,
   `✓ merge`, `✓ settle` and `job #<id> closed: PR #<n> merged as <sha7>`. When the checks
   are red it stops at `preflight` with `checks-red`: record that, then run it again with
   `--force`.
5. `nightshift queue status <id> --json` shows `status: "closed"`, `close_status: null`,
   `close.data.merged: true`, and the notice ends with `Closed: PR #<n> ...`.
6. `nightshift queue close <id>` and `nightshift queue close <id> --foreground` both exit
   non-zero with ``job `<id>` is already closed``, and nothing is started.
7. Leave the shell (the sandbox removes its home), then delete the scratch branch:
   `git push origin --delete qa/close-<stamp>` and `git branch -D qa/close-<stamp>`.

