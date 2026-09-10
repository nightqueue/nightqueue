# Releasing nightshift

A release is a pushed tag. Nothing is published from a laptop: `.github/workflows/release.yml`
runs on every tag matching `v*`, publishes to npm with OIDC trusted publishing and opens the
GitHub release. There is no npm token in this repository, by design — not in a secret, not in a
workflow, not commented out.

## The flow

1. **Decide the next version and put it in the three files that declare it.** Edit `CHANGELOG.md`
   (turn `## Unreleased` into `## <version> - YYYY-MM-DD`) and the `Licensed Work:        nightshift <version>`
   line of `LICENSE`, then commit. This step is easy to miss and blocks everything after it:
   `release:check` compares `package.json`, `CHANGELOG.md` and `LICENSE`, and `npm version` refuses
   to run on a dirty tree.
2. **`npm version patch|minor`** — bumps `package.json`, commits the bump and creates the tag
   `v<version>`.
3. **`npm run release:check`** — runs the suite, refuses an uncommitted change, checks that the
   three files agree on the version and that `npm pack --dry-run` still builds the tarball npm
   would publish. If it fails, fix what it names, delete the tag (`git tag -d v<version>`) and redo
   from the step that failed.
4. **`git push --follow-tags`** — pushes the commit and the tag. The workflow takes it from there:
   `npm ci` → `npm run release:check` → the tag must equal `v<package.json version>` →
   `npm publish --provenance --access public` → a second job creates the GitHub release whose body
   is the `## <version>` section of `CHANGELOG.md`, extracted by `scripts/changelog-section.mjs`.

To see the release notes the workflow will publish, run `node scripts/changelog-section.mjs <version>`
before pushing.

## One-time setup on npmjs.com

Trusted publishing has to be granted once, by a maintainer of the package, before the first tag is
pushed. Until this is done, the workflow fails at `npm publish` with an authentication error.

- [ ] Sign in to npmjs.com as a maintainer of `@maykonv/nightshift`.
- [ ] Open the package settings → **Publishing access**.
- [ ] Add a trusted publisher: provider **GitHub Actions**.
- [ ] Repository: `maykonVinicius/nightshift`.
- [ ] Workflow filename: `release.yml`.
- [ ] Environment: leave it empty (the workflow declares no environment).
- [ ] Save, then push the tag.

Two constraints of trusted publishing shape the workflow and must not be undone: it needs
`permissions: id-token: write` on the publishing job, and it needs npm >= 11.5.1 while Node 22
still bundles npm 10.9.8 — which is why the workflow upgrades npm and then asserts the floor
before publishing.

## When the workflow fails

- **`npm publish` fails on authentication** — the trusted publisher above is not configured, or its
  repository/workflow filename does not match this one exactly.
- **the npm floor step fails** — `npm install -g npm@latest` produced something older than 11.5.1
  on the runner; the run stops before publishing, so nothing half-released was created.
- **the tag step fails** — the tag does not match the version in `package.json`. Delete the tag,
  fix the version, tag again.
- **`release:check` fails on the tree** — something is uncommitted in the checkout; that check
  exists because a publish ships what is on disk, not what is committed.
