import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runDir } from "../src/config/paths.mjs";
import { run } from "../src/cli/index.mjs";
import { proverRound } from "../src/cli/run-append.mjs";
import { roundsOf } from "../src/queue/phase-artifacts.mjs";
import { appendRoundText, consolidationOf } from "../src/queue/qa-rounds.mjs";
import { recordRunFields } from "../src/queue/run-state.mjs";
import { ensureProject, makeDir, makeHome, makeProject } from "../test-support/memory.mjs";

const SLUG = "prove-the-groups";
const BIN = fileURLToPath(new URL("../bin/nightqueue.mjs", import.meta.url));
const ANALYST = "## Round 1\n## Proven breaks\nNone\n\n## Break hypotheses\n- H1 · group: g1\n\n## Test recipe\nnode --test\n\n## Validated risks\n- R1 → hypothesis H1\n\n## Invalidated assumptions\nNone\n\n## Generated PoCs\nNone — the provers write them\n\n## Verdict\nAPPROVED\n";

// A home with one operator run of project `alpha` whose `05-qa.md` holds the analyst's round.
function seededRun(t, name) {
  const env = makeHome(t, name);
  makeProject(t, env, "alpha");
  const projectId = ensureProject(env, "alpha");
  recordRunFields({ projectId, slug: SLUG, fields: { origin: "operator" }, env });
  const dir = runDir(projectId, SLUG, env);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "05-qa.md"), ANALYST);
  return { env, path: join(dir, "05-qa.md"), drafts: makeDir(t, `${name}-drafts`) };
}

// A prover's round draft written to a file of its own.
function draft(dir, group) {
  const path = join(dir, `${group}.md`);
  writeFileSync(path, `source: prover · group: ${group}\n\n## Proven breaks\nNone\n\n## Validated risks\nH1: HELD (REFUTED) ${group}\n\n## Generated PoCs\nNone\n\n## Verdict\nAPPROVED\n`);
  return path;
}

// Runs `nightqueue run append` in a child process of its own, resolving its exit code and output.
function spawnAppend(env, from, group) {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [BIN, "run", "append", "05", "--group", group, "--from", from, "--project", "alpha", "--slug", SLUG], { env });
    let out = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", (chunk) => (out += chunk));
    child.on("error", fail);
    child.on("close", (code) => done({ code, out }));
  });
}

// Runs the CLI in this process with the environment of the test, capturing what it printed.
async function runCli(env, argv) {
  const out = [];
  const err = [];
  const code = await run(argv, { env, cwd: process.cwd(), out: (line) => out.push(line), err: (line) => err.push(line), stdout: { write: () => {} } }).catch((error) => {
    err.push(error.message);
    return 1;
  });
  return { code, out, err };
}

test("`run append 05` from six concurrent processes keeps every round, each with its own contiguous number", async (t) => {
  const { env, path, drafts } = seededRun(t, "cli-run-append-concurrent");
  const groups = ["g1", "g2", "g3", "g4", "g5", "g6"];
  const results = await Promise.all(groups.map((group) => spawnAppend(env, draft(drafts, group), group)));
  for (const result of results) assert.equal(result.code, 0, result.out);
  const text = readFileSync(path, "utf8");
  assert.ok(text.startsWith(ANALYST.trimEnd()));
  const rounds = roundsOf(text);
  assert.deepEqual(rounds.map((round) => round.number), [1, 2, 3, 4, 5, 6, 7]);
  for (const group of groups) assert.equal(text.split(`HELD (REFUTED) ${group}\n`).length - 1, 1, group);
});

test("`run check 05 --stage analyst` records stage A only, and `run check 05` writes the consolidation once", async (t) => {
  const { env, path, drafts } = seededRun(t, "cli-run-append-check");
  const target = ["--project", "alpha", "--slug", SLUG];
  const stageA = await runCli(env, ["run", "check", "05", "--stage", "analyst", ...target]);
  assert.deepEqual(stageA.out, ["OK", "VERDICT: APPROVED", "QA-STAGE: provers", "recorded: qa_stage_a APPROVED"]);
  const state = JSON.parse(readFileSync(join(runDir(ensureProject(env, "alpha"), SLUG, env), "state.json"), "utf8"));
  assert.equal(state.qaStageA.artifact, "05-qa.md");
  assert.ok(!(state.phases ?? []).some((entry) => entry.phase === "qa"));
  assert.equal((await spawnAppend(env, draft(drafts, "g1"), "g1")).code, 0);
  const full = await runCli(env, ["run", "check", "05", ...target]);
  assert.equal(full.out[0], "OK");
  assert.equal(full.out[1], "VERDICT: APPROVED");
  await runCli(env, ["run", "check", "05", ...target]);
  const rounds = roundsOf(readFileSync(path, "utf8"));
  assert.deepEqual(rounds.map((round) => round.number), [1, 2, 3]);
  assert.ok(rounds[2].text.startsWith("## Round 3\nsource: runtime consolidation · rounds 1, 2\n"));
  for (const stage of [["06", "analyst"], ["05", "foo"]]) {
    const refused = await runCli(env, ["run", "check", stage[0], "--stage", stage[1], ...target]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.err.join("\n"), /unknown stage/);
  }
});

test("`run append` refuses a draft it cannot append as one prover round", async (t) => {
  const { env, path, drafts } = seededRun(t, "cli-run-append-refusals");
  const write = (name, body) => {
    const file = join(drafts, name);
    writeFileSync(file, body);
    return file;
  };
  const target = ["--project", "alpha", "--slug", SLUG];
  const ok = write("ok.md", "x\n");
  const append = (from) => ["run", "append", "05", "--group", "a-1", "--from", from, ...target];
  const cases = [
    [["run", "append", "05", "--group", "a-1", ...target], /`--from <file>` is required/],
    [["run", "append", "05", "--from", ok, ...target], /`--group <id>` is required/],
    [["run", "append", "05", "--group", "A B", "--from", ok, ...target], /invalid group id/],
    [["run", "append", "05", "--group", "cache · H1", "--from", ok, ...target], /invalid group id/],
    [["run", "append", "05", "--group", "Upper", "--from", ok, ...target], /invalid group id/],
    [append(write("empty.md", "  \n")), /the draft is empty/],
    [append(write("two.md", "## Round 2\na\n## Round 3\nb\n")), /holds a `## Round` line/],
    [append(write("fenced-round.md", "a\n```\n## Round 1\n```\n")), /holds a `## Round` line/],
    [append(write("fence.md", "a\n```\nunclosed\n")), /leaves a code fence open \(line 2\)/],
    [append(write("comment.md", "a\n<!--\nunclosed\n")), /leaves an HTML comment open \(line 2\): close it with `-->` or write a literal `<!--` in backticks/],
    [append(write("cons.md", "source: runtime consolidation\nx\n")), /written by `nightqueue run check 05`/],
    [["run", "append", "06", "--group", "a-1", "--from", ok, ...target], /only takes `05`/],
  ];
  for (const [argv, expected] of cases) {
    const result = await runCli(env, argv);
    assert.notEqual(result.code, 0, argv.join(" "));
    assert.match(result.err.join("\n"), expected);
  }
  assert.equal(readFileSync(path, "utf8"), ANALYST);
});

// A draft with no source line, its one proven-break row and its verdict.
function plainDraft(dir, name, row, verdict) {
  const path = join(dir, `${name}.md`);
  writeFileSync(path, `## Proven breaks\n${row}\n\n## Verdict\n${verdict}\n`);
  return path;
}

test("`run append --group` stamps the runtime's group: the same group supersedes, another group is kept", async (t) => {
  const { env, path, drafts } = seededRun(t, "cli-run-append-groups");
  const target = ["--project", "alpha", "--slug", SLUG];
  const foreign = join(drafts, "foreign.md");
  writeFileSync(foreign, "source: prover · group: other\n\n## Proven breaks\nNone\n\n## Verdict\nAPPROVED\n");
  assert.equal((await spawnAppend(env, foreign, "a-1")).code, 0);
  const stamped = roundsOf(readFileSync(path, "utf8")).at(-1).text;
  assert.ok(stamped.startsWith("## Round 2\nsource: prover · group: a-1\n"), stamped);
  assert.ok(!stamped.includes("group: other"));
  assert.equal((await spawnAppend(env, plainDraft(drafts, "a1-late", "| 1 | LATE-A1 |", "NEEDS FIX"), "a-1")).code, 0);
  assert.equal((await spawnAppend(env, plainDraft(drafts, "b2", "| 1 | KEPT-B2 |", "NEEDS FIX"), "b-2")).code, 0);
  const full = await runCli(env, ["run", "check", "05", ...target]);
  assert.equal(full.out[1], "VERDICT: NEEDS FIX");
  const consolidated = roundsOf(readFileSync(path, "utf8")).at(-1).text;
  assert.ok(consolidated.startsWith("## Round 5\nsource: runtime consolidation · rounds 1, 3, 4\n"), consolidated);
  assert.ok(consolidated.includes("LATE-A1") && consolidated.includes("KEPT-B2"));
});

test("PoC qa-group-collapse: distinct provers never collapse into one group, whatever their own labels say", () => {
  const analyst = ["source: analyst", "## Proven breaks\nNone", "## Break hypotheses\nH1 x\nH2 y", "## Verdict\nAPPROVED"].join("\n\n");
  const row = "| 1 | src/a.mjs | 10 | UNIQUE-BREAK-A | Correctness | red | PoC: a.poc |";
  const body = (cells, verdict) => `## Proven breaks\n| # | File | Line | Break | Front | Severity | Proof |\n|---|---|---|---|---|---|---|\n${cells}\n\n## Verdict\n${verdict}`;
  const cases = [
    [body(row, "NEEDS FIX"), body("None", "APPROVED")],
    [`source: prover · group: cache · H1\n\n${body(row, "NEEDS FIX")}`, `source: prover · group: cache · H2\n\n${body("None", "APPROVED")}`],
    [`source: prover · group: H1\n\n${body(row, "NEEDS FIX")}`, `source: prover · group: H2\n\n${body("None", "APPROVED")}`],
  ];
  for (const [draftA, draftB] of cases) {
    let text = appendRoundText("", 1, analyst);
    text = appendRoundText(text, 2, proverRound(draftA));
    text = appendRoundText(text, 3, proverRound(draftB));
    const consolidation = consolidationOf(text);
    assert.ok(consolidation.body.includes("UNIQUE-BREAK-A"), consolidation.body);
    assert.match(consolidation.body, /## Verdict\nNEEDS FIX/);
  }
});

test("PoC qa-skip-consolidation: an analyst-only skip round that passed stage A passes check 05", async (t) => {
  const { env, path } = seededRun(t, "cli-run-append-skip");
  writeFileSync(path, readFileSync(new URL("./fixtures/check/qa-analyst-skip/05-qa.md", import.meta.url), "utf8"));
  const target = ["--project", "alpha", "--slug", SLUG];
  const stageA = await runCli(env, ["run", "check", "05", "--stage", "analyst", ...target]);
  assert.equal(stageA.out[0], "OK");
  assert.ok(stageA.out.includes("QA-STAGE: skip"));
  const final = await runCli(env, ["run", "check", "05", ...target]);
  assert.equal(final.out[0], "OK", final.out.join("\n"));
});

test("PoC qa-r2-comment-regex vector A: a code-span `<!--` in a prover round and a later `-->` hide no section from check 05", async (t) => {
  const { env, path, drafts } = seededRun(t, "cli-run-append-comment-regex");
  const from = join(drafts, "g1.md");
  writeFileSync(from, "## Proven breaks\nNone\n\n## Validated risks\nH1: HELD (REFUTED) — payload `<!--<img src=x>`\n\n## Generated PoCs\n- the mermaid edge `a --> b`\n\n## Verdict\nAPPROVED\n");
  assert.equal((await spawnAppend(env, from, "g1")).code, 0);
  const full = await runCli(env, ["run", "check", "05", "--project", "alpha", "--slug", SLUG]);
  assert.deepEqual(full.out.slice(0, 2), ["OK", "VERDICT: APPROVED"], full.out.join("\n"));
  assert.ok(roundsOf(readFileSync(path, "utf8")).at(-1).text.startsWith("## Round 3\nsource: runtime consolidation · rounds 1, 2\n"));
});

test("`run check 05` over an analyst round left inside an open fence closes the fence, refuses the fenced round and writes no consolidation", async (t) => {
  const { env, path } = seededRun(t, "cli-run-append-open-fence");
  const open = `${ANALYST.replace("## Test recipe\nnode --test", "## Test recipe\n```sh\nnode --test")}\n## Round 2\nsource: prover · group: g1\n\n## Proven breaks\nNone\n\n## Verdict\nAPPROVED\n`;
  writeFileSync(path, open);
  const full = await runCli(env, ["run", "check", "05", "--project", "alpha", "--slug", SLUG]);
  assert.equal(full.out[0], "MISSING: line 24 of 05-qa.md is a column-0 `## Round 2` inside the code fence opened at line 9 (round 1): append a new `## Round 2` with your whole round, and indent by one space any `## Round` line you quote");
  assert.equal(full.out[1], "REPAIRED: the code fence of round 1 opened at line 9 of 05-qa.md never closed; the runtime appended ````` at line 32");
  assert.ok(!full.out.some((line) => line.startsWith("VERDICT:")), full.out.join("\n"));
  assert.equal(readFileSync(path, "utf8"), `${open}\`\`\`\n`);
});

test("`run append` over a round that leaves a fence open closes it first, then appends the round", async (t) => {
  const { env, path, drafts } = seededRun(t, "cli-run-append-repair");
  writeFileSync(path, ANALYST.replace("## Verdict\nAPPROVED\n", "## Verdict\nAPPROVED\n\n```\nlog\n"));
  const result = await spawnAppend(env, draft(drafts, "g1"), "g1");
  assert.equal(result.code, 0, result.out);
  const lines = result.out.trim().split("\n");
  assert.equal(lines[0], "REPAIRED: the code fence of round 1 opened at line 23 of 05-qa.md never closed; the runtime appended ````` at line 25");
  assert.match(lines[1], /^APPENDED: ## Round 2 to /);
  assert.deepEqual(roundsOf(readFileSync(path, "utf8")).map((round) => round.number), [1, 2]);
});

const OPEN_COMMENT_ANALYST = ANALYST.replace("## Test recipe\nnode --test", "## Test recipe\nnode --test\n- payload fragment <!-- img onerror");

test("D3: `run check 05 --stage analyst` refuses an analyst round that leaves a `<!--` open and records nothing", async (t) => {
  const passed = ["OK", "VERDICT: APPROVED", "QA-STAGE: provers", "recorded: qa_stage_a APPROVED"];
  const cases = [
    ["open", OPEN_COMMENT_ANALYST, ["MISSING: round 1 of 05-qa.md leaves the HTML comment opened at line 10 open: append a new `## Round 2` with your whole round, closing every `<!--` with `-->` or writing a literal `<!--` in backticks"]],
    ["literal", OPEN_COMMENT_ANALYST.replace("<!-- img", "`<!--` img"), passed],
    ["closed", OPEN_COMMENT_ANALYST.replace("<!-- img onerror", "<!-- img onerror -->"), passed],
  ];
  for (const [name, text, expected] of cases) {
    const { env, path } = seededRun(t, `cli-run-append-comment-${name}`);
    writeFileSync(path, text);
    const { out } = await runCli(env, ["run", "check", "05", "--stage", "analyst", "--project", "alpha", "--slug", SLUG]);
    assert.deepEqual(out, expected, name);
  }
});

test("D3 in the consolidation window: `run check 05` writes no consolidation and answers one MISSING line", async (t) => {
  const { env, path } = seededRun(t, "cli-run-append-window-defect");
  const text = `${OPEN_COMMENT_ANALYST}\n## Round 2\nsource: prover · group: g1\n\n## Proven breaks\nNone\n\n## Validated risks\nH1: HELD (REFUTED)\n\n## Generated PoCs\nNone\n\n## Verdict\nAPPROVED\n`;
  writeFileSync(path, text);
  const full = await runCli(env, ["run", "check", "05", "--project", "alpha", "--slug", SLUG]);
  assert.deepEqual(full.out, ["MISSING: round 1 of 05-qa.md leaves the HTML comment opened at line 10 open: append a new `## Round 3` with your whole round, closing every `<!--` with `-->` or writing a literal `<!--` in backticks"]);
  assert.equal(readFileSync(path, "utf8"), text);
});

test("`run append` writes the prover's REFUTED lines in the canonical form, keeps a PROVEN as written (its reading depends on the hypothesis type) and keeps every other byte", () => {
  const risks = (lines) => proverRound(`## Proven breaks\nH7: PROVEN\n\n## Validated risks\n${lines.join("\n")}\n\n## Verdict\nAPPROVED`, "g1").split("## Validated risks\n")[1].split("\n\n## Verdict")[0].split("\n");
  const rewritten = ["H1: PROVEN — x", "- **H2**: refuted — y", "**H3: REFUTED**", "1. H4:PROVEN"];
  assert.deepEqual(risks(rewritten), ["H1: PROVEN — x", "- **H2**: HELD (REFUTED) — y", "**H3: HELD (REFUTED)**", "1. H4:PROVEN"]);
  const kept = ["H5: HELD (REFUTED)", "H8: BROKE (PROVEN)", "```", "H6: REFUTED", "```", "the hypothesis was REFUTED"];
  assert.deepEqual(risks(kept), kept);
  assert.ok(proverRound("## Proven breaks\nH7: PROVEN\n\n## Verdict\nAPPROVED", "g1").includes("## Proven breaks\nH7: PROVEN\n"));
});
