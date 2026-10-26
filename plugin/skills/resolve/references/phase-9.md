# Phase 9 — Report

Use the visual identity of the legend and the status icons throughout the report.

**Open the report with `nightqueue run report`, pasted verbatim** (Bash, inside the job; outside
one, with `--project <project> --slug <slug>`). It prints the `## 🗂️ Report — <slug>` header, then
ONE table — one row per recorded execution, in order: every step, a re-run as its own row
(`🔁N`, N its launch number), `⏭️` only for a step the run legitimately skipped, `⚠️ not
recorded` for a planned step with no record — with the Time column the runtime measured and
its `**Total:**`; then a `Happy: yes|no — <first failing gate>` line decided from the run's
own records. Your judgment may only turn a `Happy: yes` into not
happy — never the reverse — and then names the gate right below the pasted output.

**Fail-safe.** `run report` decides Happy from the records; in doubt about any gate, the run is
not happy — the complete detail is the safe behavior, hiding is the risk.

**Happy path — output ≤~30 lines.** Print only the `run report` output above and,
right after, the section **🎯 Objective met**: repeat the `Expected outcome` of Phase 0
and the concrete evidence that proves it was met (a without-fix/with-fix proof, a screenshot,
or the acceptance gate item by item), closing with the PR link (or "local commit,
no PR" when applicable). Re-read only `01-triage.md` (## Validated brief, ## Diagnosis if a bug)
and the evidence in `06-verification.md`. Do NOT print the detail sections below. Print also
the `🪞 Reflection:` line (Phase 10) and the `## Notice` section; both are mandatory and do not
enter the ~30-line cap.

**Non-happy path (any ⚠️, ❌, 🔁 or gate_stop):** the table already carries every execution
with its Time and the `**Total:**`. Never compute a duration and never write a timestamp: the times belong to the runtime.
Re-read the artifacts via Read for the detail (the handoff dropped them from context):
`01-triage.md`, `05-qa.md` (last round), `06-verification.md` and `03-plan.md` when necessary.
A missing artifact → a ⚠️ open item on its line, never a reconstruction nor a failed report.
After the table, detail only what needs more than one line:

0. **🎯 Objective met**: the `Expected outcome` of Phase 0 and the evidence item by item; an item
   left NOT MET is said in the first line — never declare success against another criterion.
1. **🔍 Diagnosis (bug only)**: the triager's `## Diagnosis` — the hypotheses, how each was
   validated, and the confirmed root cause with its direct evidence.
2. **QA — proven breaks**: what the qa-guardian broke, its PoCs and each `## Validated risks`
   item with severity 🔴🟡🟢; reference the `🔁N` rows of the table.
3. **Verification**: the checks + the QA's PoCs run, the final result, the 🔁 count.
4. **🛡️ Prevention**: the QA's recommendations to avoid recurrence.

A run that ended without a commit leaves its line ❌/⚠️ and explains the block below the table.

**Open items.** Translate every `## Open items` entry of the report into the Notice's Still open,
in user language.

**Telemetry:** `run report` records the run; a failure is an open item.

## Notice

Mandatory on BOTH paths: the executive notice the operator reviews before closing the job. A gate
notice (the pauses of Phases 1, 3 and 7) is never written here: the runtime composes it from the
gate's `run_outcome` record.

Model (the fence delimits the MODEL in this document; the real report emits it **without** a fence):

```
## Notice

✅ Fixed and live — <short symptom>

What was happening: <the symptom in user language, with the cause in one sentence>.

What was done: <the fix and how it is now, from the point of view of whoever uses it>.

What the review found: <only when there was adversarial QA; max 3 bullets>
• <break 1 in user language>

How it was validated: <what was in fact exercised>.

For support to guide whoever uses it: <how whoever uses it gets the fix; only when there is a real delivery channel, otherwise omit the whole line>

Still open — a DIFFERENT problem, does not affect this fix: <only when there is one; max 3 bullets>
• <open item 1, saying in one sentence that it will be handled separately>
```

A task that is not a bug fix swaps the header for `✅ Delivered — <what changed>` and "What was
happening" for "What was missing". The header ends with a `(<ID>)` only when the task came from an
issue tracker with a real ID.

The writing rules:

1. **User language.** The body is plain text under `## Notice`, the LAST section of the final
   text; never fenced; no line starts with `# `, `## ` or `QUEUE_`; no function, file or
   identifier names — describe the effect for whoever uses it.
2. **No placeholder.** Never a value in double curly braces; an unknown value omits the line. No
   PR URL, no `Record:` line, no invented ID, hash or channel: the runtime shows the delivery.
3. **The cap.** Target ≤1000 characters, never above 1900. Cut whole content (a bullet, a
   conditional section), never the outcome line nor a mandatory section.
4. **"Still open" is mandatory and never omitted** for every real open item (≤3 bullets); "What
   the review found" is mandatory when the QA ran (≤3 bullets). Omitting an open item to look
   clean is the most expensive mistake of this notice.
5. **The header and the label are derived from the artifacts:**
   - a `not-covered` vector in `03-plan.md` `## Symptom coverage`, or a `NOT MET` row of the
     Phase 7 table → `⚠️ Partially fixed — <what was left out>` + `Still open IN THIS FIX:`;
   - a `dedicated ticket: yes` item → `Still open — a DIFFERENT problem, does not affect this fix:`;
   - otherwise the ✅ family (`✅ Fixed and live`, `✅ Fixed — goes out in the next release`,
     `✅ Delivered — <what changed>`);
   - in doubt, the partial form.
6. **A run terminated by `NO-CHANGE-NEEDED`.** Its header is `✅ Resolved — no code change needed`;
   the body is the conclusion with its evidence, in user language. Record it BEFORE printing:
   `run_outcome` with `status: "no_change"` and `notice` = this body. The runtime appends the
   close-the-job line; the notice does NOT write it (it would reach the origins).

The runtime validates a notice recorded through `run_outcome` and says why it refused one; fix and
emit again.

## Visual identity of the agents

Every agent has a fixed icon and title. ALWAYS use this identity when
announcing phases, building the execution log and the final report.

| Icon | Agent | Family | Role |
| ----- | ------ | ------- | ----- |
| 🔍 | **Triager** | Intake & analysis | Reproduces the bug / validates requirements (gate) |
| 🧭 | **Explore** | Intake & analysis | Locates files and lib versions |
| 📐 | **Architect** | Design | Implementation plan + risks |
| ⚙️ | **Coder** | Implementation | Writes the code |
| 🛡️ | **QA-Guardian** | Quality | Risk matrix, robustness test, fuzz |
| ✅ | **Verifier** | Verification & delivery | Runs real checks (final gate) |
| 📱 | **Runtime** | Verification & delivery | Runs the app (emulator/device), screenshot, confirms the fix |
| 🚀 | **Commit/PR** | Verification & delivery | Commit, push and PR |
| 🪞 | **Reflector** | Memory | Saves the run's lessons and memories (final phase) |

**Status icons (use them in tables and verdicts):**

| Icon | Meaning |
| ----- | ----------- |
| ✅ | passed / done |
| ❌ | failed |
| ⏭️ | skipped (the runtime phase on a purely static change, or a fix loop that did not run) |
| 🔁 | re-run (fix loop) |
| ⚠️ | open item / attention / requires the user |
| ⏳ | in progress |

**Severity icons (QA/risks):** 🔴 high · 🟡 medium · 🟢 low.
