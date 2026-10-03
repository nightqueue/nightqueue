import assert from "node:assert/strict";
import { test } from "node:test";
import { emptyConfig, normalizeConfig } from "../../src/config/schema.mjs";
import { conflictStep } from "../../src/queue/close.mjs";
import { countHunks, generatedByHeader, generatedByPath, hasMarkers, mergerTimeoutMs, parseVerdict, riskFile } from "../../src/queue/merger.mjs";
import { CLOSE_PR_URL, fakeCloseDeps, gitFail, gitLines, gitOk, HEAD_SHA, openPr, PUSHED_SHA } from "../../test-support/close.mjs";

const DIR = "/tmp/fake-nightqueue-close-3-0";
const CONFLICTING = { mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" };
const CONTINUE = "-c core.editor=true rebase --continue";
const FLOOR_NOTE = "; merger: not enough of the close's timeout left for the merger and the suite; raise queue.closeTimeoutS";

// The text of a file with the given number of conflict hunks.
function conflicted(hunks) {
  return Array.from({ length: hunks }, (_, i) => `<<<<<<< HEAD\nbase ${i}\n=======\nhead ${i}\n>>>>>>> fix\n`).join("same\n");
}

// The close context of the conflict step, with a clock the test can move.
function ctxFor(clock, changes = {}) {
  return { jobId: 3, prUrl: CLOSE_PR_URL, prNumber: 7, project: "alpha", branch: "fix/worker", slug: null, type: null, force: false, checkout: "/work/alpha", remainingMs: () => clock.remaining, signal: new AbortController().signal, warning: null, data: {}, ...changes };
}

// A fake merger that clears the markers of the files it was given and answers the given final text.
function resolvingMerger(resultText = "RESOLVED", after = () => {}) {
  return async (options, world) => {
    for (const file of options.files) world.files[`${DIR}/${file}`] = "resolved\n";
    after(options, world);
    return { exitCode: 0, timedOut: false, stopped: false, spawnError: null, resultText };
  };
}

// A conflicting pull request whose rebase stops once on the given files and their hunks.
function conflictWorld(conflicts, changes = {}) {
  const files = Object.fromEntries(Object.entries(conflicts).map(([file, hunks]) => [`${DIR}/${file}`, conflicted(hunks)]));
  const { git = {}, ...rest } = changes;
  return fakeCloseDeps({
    pr: openPr(CONFLICTING),
    files,
    merger: resolvingMerger(),
    git: { "rebase origin/": gitFail("CONFLICT (content)"), "diff --name-only --diff-filter=U": gitOk(`${Object.keys(conflicts).join("\n")}\n`), ...git },
    ...rest,
  });
}

// Tells whether the fake close pushed anything.
function pushed(fake) {
  return gitLines(fake.log).some((line) => line.startsWith("push"));
}

test("an eligible conflict is resolved by the merger, verified, continued, tested and pushed with the merger's note", async () => {
  const fake = conflictWorld({ "docs/x.md": 2, "src/mcp/tools.mjs": 1 });
  const result = await conflictStep({ ctx: ctxFor({ remaining: 1_700_000 }), deps: fake.deps });
  assert.equal(result.status, "done", result.note);
  assert.equal(result.note, `resolved by merger: 3 hunks in 2 files (docs/x.md, src/mcp/tools.mjs); suite green; pushed ${HEAD_SHA.slice(0, 7)} -> ${PUSHED_SHA.slice(0, 7)}`);
  assert.deepEqual(result.reopen, ["preflight"]);
  assert.equal(result.data.verifiedSha, PUSHED_SHA);
  assert.deepEqual(result.data.merger, { status: "resolved", hunks: 3, files: ["docs/x.md", "src/mcp/tools.mjs"] });
  assert.equal(fake.log.mergers.length, 1);
  assert.equal(fake.log.mergers[0].cwd, DIR);
  assert.deepEqual(fake.log.mergers[0].files, ["docs/x.md", "src/mcp/tools.mjs"]);
  assert.equal(fake.log.mergers[0].timeoutMs, 805000);
  const lines = gitLines(fake.log, DIR);
  for (const line of ["add -- docs/x.md src/mcp/tools.mjs", CONTINUE, "diff --check origin/main HEAD"]) assert.ok(lines.includes(line), `${line} was not run`);
  assert.ok(lines.indexOf(CONTINUE) < lines.findIndex((line) => line.startsWith("push")), "pushed before the rebase continued");
  assert.equal(lines.includes("rebase --abort"), false, "a resolved rebase was aborted");
  assert.equal(fake.log.tests.length, 1, "the suite did not run after the resolution");
});

test("a merger resolution runs the suite even when the previous head had checks", async () => {
  const fake = conflictWorld({ "src/a.mjs": 1 });
  const result = await conflictStep({ ctx: ctxFor({ remaining: 1_700_000 }, { data: { checksOnHead: 4 } }), deps: fake.deps });
  assert.equal(result.status, "done", result.note);
  assert.equal(fake.log.tests.length, 1, "the suite was skipped after a merger resolution");
});

test("the merger's timeout is half of what the suite's reserve leaves, capped at 20 min", async () => {
  const fake = conflictWorld({ "src/a.mjs": 1 });
  await conflictStep({ ctx: ctxFor({ remaining: 3_600_000 }), deps: fake.deps });
  assert.equal(fake.log.mergers[0].timeoutMs, 1200000);
  assert.equal(mergerTimeoutMs(1_700_000, 90000), 805000);
});

test("below the 60 s floor the merger never runs and the note names closeTimeoutS", async () => {
  const fake = conflictWorld({ "src/a.mjs": 1 });
  const result = await conflictStep({ ctx: ctxFor({ remaining: 200_000 }), deps: fake.deps });
  assert.equal(result.reason, "real-conflict");
  assert.equal(result.note, `rebase onto origin/main conflicts in: src/a.mjs${FLOOR_NOTE}`);
  assert.equal(fake.log.mergers.length, 0);
  assert.ok(gitLines(fake.log, DIR).includes("rebase --abort"));
});

test("a risk-list or generated file is never handed to the merger, and the note stays exactly today's", async () => {
  const cases = [
    [{ "package.json": 1 }, {}],
    [{ "pnpm-lock.yaml": 1 }, {}],
    [{ "dist/app.js": 1 }, {}],
    [{ "src/memory/migration/v20.mjs": 1 }, {}],
    [{ "src/gen.mjs": 1 }, { git: { "check-attr": gitOk("src/gen.mjs: linguist-generated: set\n") } }],
  ];
  for (const [conflicts, changes] of cases) {
    const fake = conflictWorld(conflicts, changes);
    const result = await conflictStep({ ctx: ctxFor({ remaining: 1_700_000 }), deps: fake.deps });
    const [file] = Object.keys(conflicts);
    assert.equal(result.reason, "real-conflict");
    assert.equal(result.note, `rebase onto origin/main conflicts in: ${file}`);
    assert.equal(result.data.merger.status, "not-eligible");
    assert.equal(fake.log.mergers.length, 0, `${file} reached the merger`);
    assert.ok(gitLines(fake.log, DIR).includes("rebase --abort"));
  }
  const header = conflictWorld({ "src/gen.mjs": 1 });
  header.world.files[`${DIR}/src/gen.mjs`] = `// @generated by a tool\n${conflicted(1)}`;
  await conflictStep({ ctx: ctxFor({ remaining: 1_700_000 }), deps: header.deps });
  assert.equal(header.log.mergers.length, 0, "a file marked @generated reached the merger");
});

test("13 hunks are over the budget and never reach the merger", async () => {
  const fake = conflictWorld({ "src/a.mjs": 7, "src/b.mjs": 6 });
  const result = await conflictStep({ ctx: ctxFor({ remaining: 1_700_000 }), deps: fake.deps });
  assert.equal(result.reason, "real-conflict");
  assert.equal(result.data.merger.reason, "13 hunks in 2 files over the 12/6 budget");
  assert.equal(fake.log.mergers.length, 0);
});

// A world whose rebase stops twice: on `first`, then, after one continue, on `second`.
function twoStopWorld(first, second, changes = {}) {
  let continues = 0;
  let unmergedReads = 0;
  const all = { ...first, ...second };
  const fake = conflictWorld(all, {
    git: {
      "diff --name-only --diff-filter=U": () => {
        unmergedReads += 1;
        return gitOk(`${Object.keys(unmergedReads === 1 ? first : second).join("\n")}\n`);
      },
      [CONTINUE]: () => {
        continues += 1;
        return continues === 1 ? gitFail("CONFLICT (content)") : gitOk();
      },
    },
    ...changes,
  });
  return fake;
}

test("the budget is summed over every stop: a second stop that goes over it aborts after one merger call", async () => {
  const fake = twoStopWorld({ "src/a.mjs": 7 }, { "src/b.mjs": 7 });
  const result = await conflictStep({ ctx: ctxFor({ remaining: 1_700_000 }), deps: fake.deps });
  assert.equal(result.reason, "real-conflict");
  assert.equal(fake.log.mergers.length, 1);
  assert.equal(result.note, "rebase onto origin/main conflicts in: src/a.mjs, src/b.mjs");
  assert.equal(result.data.merger.reason, "14 hunks in 2 files over the 12/6 budget");
  assert.equal(pushed(fake), false);
});

test("each stop gets its own timeout from what is left of the close at that moment", async () => {
  const clock = { remaining: 1_700_000 };
  const fake = twoStopWorld({ "src/a.mjs": 2 }, { "src/b.mjs": 1 }, { merger: resolvingMerger("RESOLVED", () => (clock.remaining -= 700_000)) });
  const result = await conflictStep({ ctx: ctxFor(clock), deps: fake.deps });
  assert.equal(result.status, "done", result.note);
  assert.deepEqual(fake.log.mergers.map((call) => call.timeoutMs), [805000, 455000]);
  assert.match(result.note, /^resolved by merger: 3 hunks in 2 files \(src\/a\.mjs, src\/b\.mjs\); suite green; pushed /);
});

test("what the merger or the verification refuses aborts with real-conflict and the reason in the note, pushing nothing", async () => {
  const cases = [
    [{ merger: resolvingMerger("I looked.\nUNRESOLVED: same function changed on both sides") }, "; merger: UNRESOLVED: same function changed on both sides"],
    [{ merger: async () => ({ exitCode: 0, timedOut: false, stopped: false, spawnError: null, resultText: "RESOLVED" }) }, "; merger: conflict markers left in: src/a.mjs"],
    [{ git: { "diff --name-only": gitOk("src/a.mjs\nsrc/extra.mjs\n") } }, "; merger: the resolution touched files outside the conflict: src/extra.mjs"],
    [{ merger: async () => ({ exitCode: -1, timedOut: true, stopped: false, spawnError: null, resultText: "" }) }, "; merger: timed out after 805 s"],
    [{ merger: async () => ({ exitCode: 1, timedOut: false, stopped: false, spawnError: null, resultText: "" }) }, "; merger: exited with code 1"],
    [{ merger: resolvingMerger("all good") }, "; merger: ended without a RESOLVED/UNRESOLVED line"],
    [{ merger: async () => { throw new Error("boom"); } }, "; merger: the merger could not run (boom)"],
  ];
  for (const [changes, suffix] of cases) {
    const fake = conflictWorld({ "src/a.mjs": 1 }, changes);
    const result = await conflictStep({ ctx: ctxFor({ remaining: 1_700_000 }), deps: fake.deps });
    assert.equal(result.reason, "real-conflict", suffix);
    assert.equal(result.note, `rebase onto origin/main conflicts in: src/a.mjs${suffix}`);
    assert.equal(result.data.merger.status, "unresolved");
    assert.ok(gitLines(fake.log, DIR).includes("rebase --abort"), `${suffix}: not aborted`);
    assert.equal(gitLines(fake.log, DIR).includes(CONTINUE), false, `${suffix}: the rebase continued`);
    assert.equal(pushed(fake), false, `${suffix}: pushed`);
    assert.deepEqual(fake.log.removedDirs, fake.log.tempDirs);
  }
});

test("a red suite after a resolution stops with suite-red and pushes nothing", async () => {
  const fake = conflictWorld({ "src/a.mjs": 1 }, { suite: { ok: false, output: "not ok 1", timedOut: false } });
  const result = await conflictStep({ ctx: ctxFor({ remaining: 1_700_000 }), deps: fake.deps });
  assert.equal(result.reason, "suite-red");
  assert.equal(fake.log.mergers.length, 1);
  assert.equal(pushed(fake), false);
  assert.deepEqual(fake.log.removedDirs, fake.log.tempDirs);
});

test("--force never runs the merger: an eligible conflict stops with today's real-conflict", async () => {
  const fake = conflictWorld({ "src/a.mjs": 1 });
  const result = await conflictStep({ ctx: ctxFor({ remaining: 1_700_000 }, { force: true }), deps: fake.deps });
  assert.equal(result.reason, "real-conflict");
  assert.equal(result.note, "rebase onto origin/main conflicts in: src/a.mjs");
  assert.equal(fake.log.mergers.length, 0);
});

test("a close aborted while the merger runs never continues the rebase nor pushes", async () => {
  const controller = new AbortController();
  const fake = conflictWorld({ "src/a.mjs": 1 }, { merger: resolvingMerger("RESOLVED", () => controller.abort()) });
  const result = await conflictStep({ ctx: ctxFor({ remaining: 1_700_000 }, { signal: controller.signal }), deps: fake.deps });
  assert.equal(result.reason, "real-conflict");
  assert.match(result.note, /; merger: interrupted$/);
  assert.equal(gitLines(fake.log, DIR).includes(CONTINUE), false);
  assert.equal(pushed(fake), false);
});

test("a delete or binary conflict without markers is not eligible", async () => {
  const fake = conflictWorld({ "src/a.mjs": 0 });
  const result = await conflictStep({ ctx: ctxFor({ remaining: 1_700_000 }), deps: fake.deps });
  assert.equal(result.note, "rebase onto origin/main conflicts in: src/a.mjs");
  assert.match(result.data.merger.reason, /no conflict markers in src\/a\.mjs/);
  assert.equal(fake.log.mergers.length, 0);
});

test("the eligibility helpers match the approved lists", () => {
  for (const path of ["package.json", "web/package-lock.json", "yarn.lock", "Cargo.lock", "src/memory/schema.mjs", "src/memory/migration/v3.mjs"]) assert.equal(riskFile(path), true, path);
  for (const path of ["src/memory/schema.test.mjs", "src/a.mjs", "docs/package.md"]) assert.equal(riskFile(path), false, path);
  for (const path of ["pnpm-lock.yaml", "npm-shrinkwrap.json", "bun.lockb", "dist/a.js", "a/build/b.js", "src/__generated__/x.ts", "vendor/x.js", "app.min.js", "a.min.css", "a.js.map", "test/__snapshots__/a.snap"]) assert.equal(generatedByPath(path), true, path);
  for (const path of ["src/builder.mjs", "src/distance.mjs", "build.mjs"]) assert.equal(generatedByPath(path), false, path);
  assert.equal(generatedByHeader("// Code generated. DO NOT EDIT.\nx"), true);
  assert.equal(generatedByHeader("a\nb\nc\nd\ne\n// @generated"), false);
  assert.equal(countHunks(conflicted(3)), 3);
  assert.equal(hasMarkers("a\n=======\nb"), true);
  assert.equal(hasMarkers("a ======= b\n========\n"), false);
  assert.deepEqual(parseVerdict("RESOLVED\n\n"), { resolved: true });
  assert.equal(parseVerdict(`UNRESOLVED: ${"x".repeat(300)}`).reason.length, 200);
});

test("a verdict line decorated with backticks, asterisks or a trailing period still counts", () => {
  for (const text of ["done\n`RESOLVED`", "done\nRESOLVED.", "done\n**RESOLVED**", "done\n`RESOLVED`."]) {
    assert.deepEqual(parseVerdict(text), { resolved: true }, JSON.stringify(text));
  }
  for (const text of ["done\n`UNRESOLVED: needs a decision`", "done\n**UNRESOLVED:** needs a decision.", "done\nUNRESOLVED: needs a decision."]) {
    assert.deepEqual(parseVerdict(text), { resolved: false, reason: "UNRESOLVED: needs a decision" }, JSON.stringify(text));
  }
  assert.equal(parseVerdict("done\nRESOLVED it all").resolved, false);
});

test("queue.closeTimeoutS defaults to 1800, an invalid value falls back to it and an explicit 600 stays", () => {
  assert.equal(emptyConfig().queue.closeTimeoutS, 1800);
  assert.equal(normalizeConfig({ queue: { closeTimeoutS: "600" } }).queue.closeTimeoutS, 1800);
  assert.equal(normalizeConfig({ queue: { closeTimeoutS: 600 } }).queue.closeTimeoutS, 600);
});
