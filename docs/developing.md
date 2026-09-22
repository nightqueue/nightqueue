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

That is why the real acceptance of `nightshift queue ship` is operator-run. An unattended
run is refused by `queue ship` itself, so from your own terminal (no nightshift job
variables set), in this checkout:

```sh
node scripts/ship-qa-demo.mjs                      # default demo checkout
node scripts/ship-qa-demo.mjs --repo <nstest-demo> # another clone of the same remote
```

It refuses to start inside a nightshift job and refuses a checkout whose `origin` is not
`maykonVinicius/nstest-demo`. Otherwise it builds a throwaway home, registers the demo in
it, seeds each `done` job through the store and drives this checkout's real
`nightshift queue ship` over five scenarios: (i) a real merge, (ii) a base that moved
after the pull request opened (the conflict step's path is recorded as it happened),
(iii) a ship interrupted after preflight and resumed, (iv) a second ship of a shipped job
refused, and (v) a pull request on another branch than the job's refused with
`pr-not-the-job-branch`, then shipped with `--force`. It prints a pass/fail table, closes
any scratch pull request still open, deletes its branches and removes the throwaway home;
it never touches `~/.nightshift`.

