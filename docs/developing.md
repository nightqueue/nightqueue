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

