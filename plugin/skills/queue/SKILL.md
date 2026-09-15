---
name: queue
description: >-
  Queues the current plan, task or request as ONE unattended nightshift job,
  without running it. Use when the user says "queue this", "queue this for
  tonight", "add this to the queue", "run this later", "leave this for the
  night", or runs /nightshift:queue. It records the job with the `queue_add`
  MCP tool and answers with the job id and how many jobs are pending; the batch
  itself is started later, by the user, with `nightshift queue run`.
---

# Queue — one unattended job

You turn what the user just asked for into ONE job in the nightshift backlog.
`queue_add` only records the job; it never runs it.

## 1. Decide the job

- Arguments given to the invocation (`$ARGUMENTS`) are the job. When they are
  empty, the job is the current plan, or the request under discussion in this
  conversation.
- One job is one self-contained deliverable that can be reviewed and merged on
  its own.
- Large work is ONE job with numbered stages written in the prompt
  (`Stages: 1) ... 2) ...`), never several jobs.
- Never queue a job whose precondition is another job's pull request being
  merged: fold it into that job as a later stage.

## 2. Find the project

- Run `nightshift project list --json`. It answers one entry per registered
  project, each with its `name` and its `path`.
- Pick the project whose `path` is the longest prefix of the current working
  directory. That is the same rule the CLI applies.
- No project matches: the job goes to the current directory and step 4's single
  question asks for the registration in the same line, with `<name>` the basename
  of the repository root. Never queue the job against another project.
- Two or more repos of the same `org` named here: propose saving the constraint or the intent ONCE at org scope (`org: <name>` instead of `project` in `decision_save`/`roadmap_save`, never both); the job itself stays one project's.

## 3. Write the prompt

Write it in English, between 20 and 10000 characters, self-contained — the job
runs unattended, with no access to this conversation:

- the area affected (files, module, command, surface) and the expected result;
- the constraints (what must not change) and how the result is verified.

## 4. Confirm once, then call `queue_add`

- `project` is the registered NAME of the project, never a path. It is replaced
  by `cwd` (absolute) when no project is registered for the current directory.
- `prompt` is the text of step 3.
- `tier` is your reading of the risk: `trivial` (the prompt fully describes the
  result — docs, copy, config, a rename), `simple` (a local change whose
  behaviour the prompt defines, one subsystem), `complex` (a design decision,
  concurrency/security/money, more than one subsystem, or stages). In doubt
  propose the lower one: the pipeline may raise it with evidence, never lower it.
- Ask ONCE before the call, naming the project, the job title (the first line of
  the prompt, shortened to fit) and the tier:
  `Queue "<title>" for <project> as <tier>? [Y/n]` — or, when step 2 matched no
  project, `Queue "<title>" for <cwd> (register as <name>) as <tier>? [Y/n]`,
  which is the registration question too and, on yes, sends `register: true`.
- One question, never more. Yes or an empty answer queues it as proposed; an
  answer naming another tier queues it with that tier; no queues nothing.
- There is no `run` parameter: recording the job is all this tool does.
- Never start the job. Only when the user explicitly asks for that one job now
  do you call `queue_run` with its `job_id`; otherwise the whole batch is
  started by the user, later, with `nightshift queue run`.

## 5. Answer

Three short lines, no more:

- the job id `queue_add` returned and the `tier` it was queued as;
- how many jobs are pending;
- the one-line hint the tool itself returned in `hint`, reused as it came
  (``queued job #<id> for <project> (<pending> pending). 0 runners online -
  pending jobs will wait until `nightshift queue run` starts one.``) — do not rewrite it.
