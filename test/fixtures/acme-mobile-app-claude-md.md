## Git & PR workflow

### Branch

```
feat/<short-name>       # new feature
fix/<short-description> # bug fix
chore/<task>            # housekeeping, deps, configs
refactor/<area>         # change with no feature or fix
```

**1 branch = 1 PR.** Never mix scopes (e.g. a refactor plus a new feature).

### Commits

```
feat(area): short description in the imperative

Body explaining WHY (not what — the diff shows that).
A list of changes when it helps.
No emoji.

Fixes MOBILE-XX   # only when the commit fixes a tracked crash
```

No `Co-Authored-By` (rule of the repository owner).

**A crash fix ALWAYS references the crash id in the commit.** When the fix resolves an imported crash (`MOBILE-XX`), put `Fixes MOBILE-XX` in the footer of the commit that reaches `main`. The tracker **closes the crash automatically** once the commit is merged — without it the crash stays `unresolved` even after the release. Details:

- The board reference (`APP-XX`) stays in the title and the branch — **one does not replace the other**. Use both.
- Merges are rebases, so every commit keeps its own reference; put the `Fixes` on the right commit.
- Several crashes in one PR: one `Fixes` line per crash (`Fixes MOBILE-22` / `Fixes MOBILE-1Y`).
- Take the crash id from the board (the issue body carries `Crash-ID: MOBILE-XX`) or from the tracker URL itself.

### Pre-commit checklist

- [ ] `yarn tsc --noEmit` with zero errors
- [ ] Zero `console.log` added
- [ ] Zero commented-out code
- [ ] Zero dead imports
- [ ] Visually tested when the change touches UI
- [ ] When it fixes a crash, the commit carries `Fixes MOBILE-XX` (closes it on merge)

### PR description (minimal template)

```markdown
## Summary
- What changes (1-3 bullets)
- Why (the real motivation, not "general improvement")

## Changes
- File X: what changed
- File Y: what changed

## Test plan
- [ ] Physical iOS — scenario tested
- [ ] Physical Android — scenario tested
- [ ] Edge case A
- [ ] Edge case B
- [ ] (if UI) before/after screenshot or video

## OTA-able?
- [ ] Yes (JS/TS only, no native change) — can ship in an OTA
- [ ] No (changed .json, a native plugin, ios/, android/, plugins/) — needs a new build
```

### When to refuse a PR

- Blocking (a critical rule violated) → refuse, list the points
- Medium + no test plan → ask for the test plan before approving
- Large (>300 lines) with no stated reason → ask for smaller PRs

---
