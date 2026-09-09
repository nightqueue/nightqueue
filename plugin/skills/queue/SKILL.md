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
- No project matches: stop there and say that the current directory belongs to
  no registered project, and that `nightshift project add <path>` registers it.
  Do not queue the job against another project.

## 3. Write the prompt

Write it in English, between 20 and 10000 characters, self-contained — the job
runs unattended, with no access to this conversation:

- the area affected (files, module, command, surface);
- the expected result;
- the constraints (what must not change, what must not be touched);
- how the result is verified (test command, check, observable behaviour).

## 4. Call `queue_add`

- `project` is the registered NAME of the project, never a path.
- `prompt` is the text of step 3.
- There is no `run` parameter, and there is nothing to ask for: recording the
  job is all this tool does.
- Never start the job. Only when the user explicitly asks for that one job now
  do you call `queue_run` with its `job_id`; otherwise the whole batch is
  started by the user, later, with `nightshift queue run`.

## 5. Answer

Three short lines, no more:

- the job id `queue_add` returned;
- how many jobs are pending;
- the one-line hint the tool itself returned in `hint`, reused as it came
  (`queued job #<id> for <project> (<pending> pending). Start the batch with
  queue_run when you are ready.`) — do not rewrite it.
