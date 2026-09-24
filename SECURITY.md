# Security policy

nightqueue runs coding agents on your machine, with your Claude Code
subscription, and opens pull requests on your repositories. A bug in its guards
can therefore run commands, write files or publish code where it should not.
Reports of that kind are taken seriously and handled privately.

## Reporting

Use GitHub's private vulnerability reporting on this repository
(**Security → Report a vulnerability**). Please include the version
(`nightqueue --version` or the `package.json` of the runtime), the host
(macOS/Linux, Node version) and a reproduction or a description of the path.

You will get an acknowledgement within a few days. Fixes ship as a patch release
on npm and are noted in `CHANGELOG.md`; the report is credited unless you prefer
otherwise.

## Supported versions

Only the latest published version on npm receives fixes.

## In scope

- Escapes from a job's environment: a run that reaches outside its worktree or
  its home when the runtime contract says it cannot.
- The guards documented in `docs/runtime-contract.md` and the QA rules of the
  plugin (real pull requests only on the designated demo repository, the job
  environment variables never unset).
- The MCP server exposing more than it documents.
- Secrets handled by `nightqueue connection` reaching a log, a prompt or a file
  they should not.

## Out of scope

- What Claude Code itself does with the permissions you granted it.
- A repository's own CI, hooks or scripts that a job legitimately runs.
