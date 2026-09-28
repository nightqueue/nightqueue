import { test } from "node:test";

// QA PROVER — Group A hypothesis (05a-qa-analyst.md): `adoptSlug` (src/queue/runner.mjs:153-165)
// claims the new slug, then on `renameRunDir` returning "kept" reverts with
// `await store.jobs.bindRunSlug(job.id, { candidates: [facts.slug] })` WITHOUT checking the
// result. If another job claims `facts.slug` in the gap between the two calls, the revert
// silently fails ("taken") and the row is left at the NEW slug while the files never moved.
//
// This PoC was NOT written as a passing/failing assertion: the interleaving it needs cannot be
// produced through any public or injectable surface of this codebase, and forcing it would mean
// fabricating a race that never really interleaves (forbidden by the QA methodology). The
// investigation, so the next reader does not repeat it:
//
// 1. `ctx.store` is hardcoded to `openStore(env)` inside `runCycle` (runner.mjs:831). `deps`
//    (the runner's only injection seam - spawnImpl, gitImpl, existsImpl, stopSignalImpl,
//    pauseSignalImpl, finishJobImpl, killImpl, ...) carries no `store`/`storeImpl` key, and
//    `withDefaults` never reads one. There is no way for a caller of `runCycle` to hand
//    `adoptSlug` a wrapped `store.jobs.bindRunSlug` that could claim `from` for a second job
//    right after the first call resolves.
// 2. `renameRunDir` (resume.mjs:276) is imported directly by `runner.mjs` (`import { ...,
//    renameRunDir, ... } from "./resume.mjs"`), not passed through `deps` either, so it cannot
//    be substituted from a test without module mocking.
// 3. `node:test`'s `mock.module` (the one tool that COULD replace a directly-imported binding)
//    needs `--experimental-test-module-mocks`, which the project's own recipe/`npm test` script
//    (`node --test --test-timeout=240000 --disable-warning=ExperimentalWarning "test/**/*.test.mjs"`)
//    does not pass. A PoC that only fails for lack of that flag would be failing by setup, not by
//    the real break - explicitly disallowed.
// 4. Even a real two-OS-process race (the technique that DOES work for `renameRunDir`'s own
//    existsSync-then-renameSync gap in test/queue/rename-run-dir-race.poc.test.mjs, and for
//    `bindRunSlug` contention in test/memory/run-slug-bind-concurrency.test.mjs) does not apply
//    here: the window this hypothesis needs is bounded by ONE microtask tick plus a single
//    synchronous `existsSync` call between adoptSlug's two `bindRunSlug` transactions - on the
//    order of low microseconds. SQLite's own `busy_timeout` (set via `PRAGMA busy_timeout`,
//    db.mjs:530) polls on a schedule that starts at 1ms and grows (1, 2, 5, 10, 15, 20, 25...ms).
//    A second OS process contending for the same write lock cannot resolve its own retry at a
//    finer grain than that schedule, so it either observes the lock still held by A's FIRST
//    transaction, or already re-taken by A's SECOND (revert) transaction - it structurally
//    cannot land inside a gap an order of magnitude narrower than its own polling floor. Unlike
//    the `renameRunDir` race (two independent processes racing the SAME two-step check from a
//    shared start line, where OS scheduling jitter naturally straddles the gap), this hypothesis
//    needs a THIRD PARTY to interleave inside ONE process's own two sequential DB transactions,
//    which nothing in this runtime exposes a hook for.
//
// Verdict: INCONCLUSIVE - the break described by Group A is real by reading (`adoptSlug` truly
// never inspects the second `bindRunSlug`'s return value), but the interleaving it depends on is
// not producible through this codebase's public/injectable surface, static module mocking (blocked
// by the project's test flags) or a real OS-level race (the window is narrower than SQLite's own
// busy_timeout polling floor). What is missing to turn this into a provable break: a test seam in
// `adoptSlug` (or `runJob`'s ctx) that lets a test observe/pause between its two `bindRunSlug`
// calls - e.g. an injectable `store` the way `deps` already injects `gitImpl`/`spawnImpl` - or the
// project's test script adopting `--experimental-test-module-mocks` so `mock.module` can stand in
// for `resume.mjs`'s `renameRunDir` at the exact call site.
test("Group A (adoptSlug revert-on-kept ignores its own write's outcome) — INCONCLUSIVE, no injectable interleaving surface", { skip: "see file header: no public/injectable seam reaches the gap between adoptSlug's two bindRunSlug calls" }, () => {});
