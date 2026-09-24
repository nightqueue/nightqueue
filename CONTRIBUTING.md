# Contributing to nightshift

Thanks for looking under the hood. nightshift is a small, opinionated codebase
with a large test suite; most contributions are bug reports with a reproduction,
fixes with a test, and documentation that says what the code actually does.

## Before you open a pull request

- **Open an issue first for anything beyond a fix.** The pipeline, the runtime
  contract and the memory schema are deliberate; a change to them needs a short
  discussion before the code exists.
- **One pull request, one deliverable.** A fix, a feature or a refactor — never
  two of them in one branch.
- **Every behaviour change carries a test.** The suite is hermetic (no network,
  no `~/.nightshift`, no global git configuration) and must stay that way.
  `npm test` runs it; `npm run release:check` runs it the way the release does.
- **Plain JavaScript, ESM, Node >= 22, no build step.** No TypeScript, no
  transpiler, no new runtime dependency without a reason in the pull request.
- **Code, comments, commits and docs are in English.**

## Setting up

```sh
git clone https://github.com/maykonVinicius/nightshift.git
cd nightshift
npm ci
npm test
```

To try a change end to end, install the runtime from your checkout instead of
the registry — [docs/developing.md](docs/developing.md) explains `setup --from`
and `update --from`, and why nothing is ever linked.

## Commits and pull requests

Commits follow `type(scope): short description in the imperative`
(`fix(queue): ...`, `feat(memory): ...`, `docs: ...`, `test: ...`). The body says
why; the diff already says what.

Pull requests are squash-merged into `main`, so the pull request title becomes
the commit. The pull request template asks for four sections — **Report**,
**Cause**, **Changes**, **QA** — and QA reports only what really ran
(automated, API, browser, device) plus what was not tested. Add a line under
`## Unreleased` in `CHANGELOG.md` for anything a user would notice.

CI runs the suite on Node 22 and 24, and once more from inside a git worktree,
on every pull request. A pull request is merged when CI is green and the
maintainer has reviewed it.

## What is off the table

- Anything that weakens a guard: the job environment variables, the demo-repo
  rule for real pull request QA, the refusal to run unattended where the docs say
  it must not. Those are the product.
- Changes that move the free, local product toward requiring a hosted service.

## Reporting a security issue

See [SECURITY.md](SECURITY.md). Please do not open a public issue for it.

## License

By contributing you agree that your contribution is licensed under the
[Business Source License 1.1](LICENSE) of this repository, with the same Change
Date and Change License.
