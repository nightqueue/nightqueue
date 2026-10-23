# Commit template

Standard for the commit message that `/nightqueue:resolve` writes in Phase 7 and hands
to `nightqueue run publish --message-file`. The message is filled with what the run
really did. Nothing is invented.

## Which template applies

`nightqueue run start` answers the template in effect as `commitTemplate`
(`{ source, path, label }`). Never decide it yourself. The runtime takes the first match,
in this order:

1. **Project config** (`source: "config"`): git's own `commit.template` key, read in the
   run's checkout (local, then global git config). `path` is the file it names; a key
   that names no existing file does not count.
2. **The repository's convention** (`source: "repo"`): a commitlint config, `.husky`,
   `.gitmessage`, `CONTRIBUTING.md` / `CONTRIBUTING`, or a `commitlint` key in
   `package.json`. `label` names the file; `path` is set only for `.gitmessage`. The
   repository's own hooks still run on the commit.
3. **Fallback** (`source: "nightqueue"`): the format below.

Under a config or repository template, write the message the way that template asks.
`commitConvention` (and the `CONVENTION:` line the command prints) shows what the
repository's last commits look like.

## Fallback format

```
<type>(<scope>): <subject>

<body: what changed and why, when the task is not trivial>

Tests: <only the checks that actually passed>
Fixes <tracker ID, when the task came from one>
```

- `<type>` is the Conventional Commits type of Phase 0 (`feat`, `fix`, `refactor`, ...).
- The subject is imperative, lowercase after the colon, with no final period.
- The body, the `Tests:` line and the `Fixes` line are optional; a trivial change is the
  subject alone.

## What `run publish` rejects

The command checks the message before it stages anything. Each violation prints one
`REJECTED: commit message — <reason>` line, and nothing is committed or pushed.

Under every template:

- An empty first line, or a first line that starts with `#`.
- A body whose line 2 is not blank.
- A `Co-Authored-By:` trailer line.
- A `Refs` trailer line.

Under the fallback only:

- A subject that is not `<type>(<scope>): <subject>` (the scope and a `!` are optional).

## Never write

- Never write a `Refs:` trailer; `run publish` adds it.
- A `Co-Authored-By` trailer.
- The name of an agent, a model or a vendor. To identify the automation, use the nickname
  `nightqueue`.
- A test that did not run in the `Tests:` line.
