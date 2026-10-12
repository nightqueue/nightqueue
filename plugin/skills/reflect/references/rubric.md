# Reflect rubric — what a session or run is worth remembering

The single rubric of nightqueue's reflection. Two consumers apply it: the interactive
`/nightqueue:reflect` skill (the operator through it), which saves only what the person
confirms, and the resolve reflector at the end of a run, which saves on its own. Neither
restates these rules; both read this file.

## Inputs

What happened in the session or the run: the conversation, or the run's handoffs, timeline and
the lessons the run was given.

## Kinds

| Kind | Saved as | Fields |
|---|---|---|
| `error` | **lesson** (`lesson_save`) | `title`, `root_cause`, `solution`, `prevention`, `target` |
| `correction` | **lesson** (`lesson_save`) | `title`, `root_cause`, `solution`, `prevention`, `target` |
| `decision` | **memory** (`memory_save`) | `key`, `value` |

- `error`: something went wrong and had to be fixed (a failed check, a wrong assumption, a loop).
- `correction`: the person or a later phase corrected an approach that was not wrong by accident.
- `decision`: a fact or choice about the project's code worth knowing next time.
- `target` is one of `triager|architect|coder|qa|verifier` when the phase that should have
  prevented it is known. In an interactive session it is omitted when none fits.
- `attempts` is optional: an integer ≥2, sent only when the attempts were actually counted.
- A `decision` is saved with `memory_save` as a `key` (a short stable noun phrase) and a
  `value`. It is NEVER saved with `decision_save` or `decision_update`.

**Each field is ONE short English sentence.**

## Skip rules

Do not propose:

- an isolated slip, such as a typo;
- a detail specific to one ticket that will not recur;
- what the code or the git history already states;
- secrets, tokens, paths on the user's machine, or personal data;
- a restatement of an existing lesson or memory.

No candidate at all is a valid result.

## Dedup before proposing

1. For a lesson, run `lesson_recall` with `query` = the candidate's title plus its prevention,
   and the `project`. A hit whose `via` is not `fallback` and that covers the candidate is a
   **recurrence**: re-save it with that lesson's EXACT `title`. The server bumps `attempts`,
   and inside a queued job also `violated` when the run had been given that lesson. Never
   invent a near-duplicate title, and never skip a recurrence.
2. For a memory, run `memory_recall` with the key's words. An existing key means skip; the
   server keeps an existing key anyway (`deduped: true`).

## Output

One ref per saved item: `L<id>` for a lesson, `M<id>` for a memory.
