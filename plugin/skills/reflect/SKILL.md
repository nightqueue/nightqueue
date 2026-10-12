---
name: reflect
description: >-
  Proposes the lessons and memories this session taught and saves only the ones
  the person confirms. Use when the user says "reflect", "save what we learned",
  "what did we learn", at the end of a session that changed or learned
  something, or runs /nightqueue:reflect. It saves with the `lesson_save` and
  `memory_save` MCP tools and answers with the saved refs (`L<id>`, `M<id>`).
---

# Reflect — save what this session learned

You turn what happened in this conversation into lessons and memories, and you
save only what the person confirms. The capture rules live in one place: the
rubric.

## 1. Read the rubric

Read `references/rubric.md` from this skill's base directory. It defines the
kinds, the fields, the skip rules and the dedup. Apply it as written.

## 2. Find the project

- A project the conversation already names (an operator session) is used as
  is.
- Otherwise run `nightqueue project list --json`. It answers one entry per
  registered project, each with its `name` and its `path`. Pick the project
  whose `path` is the longest prefix of the current working directory. That is
  the same registered-path match `queue_add` applies to its `cwd`.
- No project matches: offer to register the current directory with
  `project_register` (`cwd`), and call it ONLY after an explicit yes. On a no,
  say that the saves will be global, and continue only if the person agrees.

## 3. Draft the candidates

Draft the candidates per the rubric, and dedup each one first with
`lesson_recall` / `memory_recall` and the `project`. No candidate at all is a
valid result: say so in one line and stop.

## 4. Ask once

Present the candidates numbered, one line each, with the kind and, for a
lesson, the target:

```
1. lesson · coder · <title>
2. memory · <key> · <value>
3. lesson (recurrence of L<id>) · qa · <exact title>
```

Ask once which ones to save. The default is none: without an answer that names
them, nothing is saved.

## 5. Save only the confirmed ones

Save each confirmed candidate with `lesson_save` or `memory_save`, with
`project` = the project's registered NAME, never a path. Never save a
candidate the person did not confirm.

In an interactive session a recurrence bumps the lesson's `attempts` only; the
`violated` counter is bumped only inside a queued job, where the server knows
which lessons the run was given.

## 6. Report

Answer with the saved refs in one line: `Saved: L<id>, M<id>, …`, or
`Saved: none`.

## Never

- Never record a decision record: this skill writes lessons and memories only.
- Never queue a job, and never call `queue_add`.
