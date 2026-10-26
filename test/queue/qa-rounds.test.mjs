import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluateCheck } from "../../src/queue/check-contract.mjs";
import { validConsolidatedText } from "../../src/cli/run.mjs";
import { appendedText, proverRound } from "../../src/cli/run-append.mjs";
import { lastRound, nextRound, roundDefects, roundsOf, unclosedFenceOf, withClosedFence } from "../../src/queue/phase-artifacts.mjs";
import { aggregateVerdict, appendRoundText, breakItems, consolidationOf, roundSource } from "../../src/queue/qa-rounds.mjs";
import { decideResume } from "../../src/queue/resume.mjs";

const ANALYST = "## Round 1\n## Mapped rules\n- rule A\n\n## Proven breaks\nNone\n\n## Break hypotheses\n- H1 · group: g1\n\n## Test recipe\nnode --test\n\n## Validated risks\n- R1 → hypothesis H1\n\n## Invalidated assumptions\nNone\n\n## Generated PoCs\nNone — this request writes no runtime PoC\n\n## Verdict\nAPPROVED\n";

const HYPOTHESIS_STATUS = { "NEEDS FIX": "BROKE (PROVEN)", "NEEDS DISCUSSION": "INCONCLUSIVE", APPROVED: "HELD (REFUTED)" };

// A prover round body for a group, its verdict, the H1 line that verdict implies and one proven break when it found one.
function prover(group, verdict) {
  const breaks = verdict === "NEEDS FIX" ? `| # | File |\n|---|------|\n| 1 | ${group}.mjs |` : "None";
  return `source: prover · group: ${group}\n\n## Proven breaks\n${breaks}\n\n## Validated risks\nH1: ${HYPOTHESIS_STATUS[verdict]} — ${group}\n\n## Generated PoCs\n- ${group}.poc.test.mjs\n\n## Verdict\n${verdict}`;
}

// The artifact after the provers' rounds were appended in order.
function withProvers(text, rounds) {
  return rounds.reduce((acc, [group, verdict]) => appendRoundText(acc, nextRound(acc), prover(group, verdict)), text);
}

test("a round heading inside a fence or an HTML comment is no round, a delimiter opening mid-line included", () => {
  const text = "## Round 1\nbody\n```\n## Round 9\n```\n<!-- ## Round 10 -->\nsee <!-- start\n## Round 11\n-->\ninline ``` fence\n## Round 2\nlast\n";
  assert.deepEqual(roundsOf(text).map((round) => round.number), [1, 2]);
  assert.equal(nextRound(text), 3);
  assert.equal(lastRound(text), "## Round 2\nlast\n");
  assert.equal(lastRound("no rounds"), "no rounds");
});

test("the source of a round is the runtime's, a prover's with its group, the analyst's or a lite lane's", () => {
  assert.deepEqual(roundSource("## Round 3\nsource: runtime consolidation · rounds 1, 2"), { kind: "consolidation", group: null });
  assert.deepEqual(roundSource("## Round 2\n\n**source: prover · group: h1-h2**"), { kind: "prover", group: "h1-h2" });
  for (const label of ["H1-H2", "cache · H1", "a b", ""]) {
    assert.deepEqual(roundSource(`## Round 2\nsource: prover · group: ${label}`), { kind: "prover", group: null }, label);
  }
  assert.deepEqual(roundSource("## Round 2\nsource: prover"), { kind: "prover", group: null });
  assert.equal(roundSource(ANALYST).kind, "analyst");
  assert.equal(roundSource("## Round 1\n## Verdict\nAPPROVED").kind, "lite");
});

test("the consolidation merges the analyst and the latest round of each group, once", () => {
  const text = withProvers(ANALYST, [["g1", "APPROVED"], ["g2", "NEEDS FIX"], ["g1", "NEEDS DISCUSSION"]]);
  const consolidation = consolidationOf(text);
  assert.equal(consolidation.number, 5);
  assert.ok(consolidation.body.startsWith("source: runtime consolidation · rounds 1, 3, 4\n"));
  assert.ok(consolidation.body.includes("## Mapped rules\n- rule A"));
  assert.ok(consolidation.body.includes("- R1 → hypothesis H1\n\nH1: BROKE (PROVEN) — g2\n\nH1: INCONCLUSIVE — g1"));
  assert.ok(!consolidation.body.includes("HELD (REFUTED) — g1"));
  assert.ok(!consolidation.body.includes("## Suggestions"));
  assert.ok(consolidation.body.endsWith("## Verdict\nNEEDS FIX\nBROKE: H1\nINCONCLUSIVE: H1"));
  const written = appendRoundText(text, consolidation.number, consolidation.body);
  assert.equal(consolidationOf(written), null);
  const late = consolidationOf(withProvers(written, [["g2", "APPROVED"]]));
  assert.ok(late.body.startsWith("source: runtime consolidation · rounds 1, 4, 6\n"));
  assert.ok(late.body.endsWith("## Verdict\nNEEDS DISCUSSION\nINCONCLUSIVE: H1"));
});

test("a lite round or a QA with no analyst round is never consolidated", () => {
  assert.equal(consolidationOf("## Round 1\n## Verdict\nAPPROVED\n"), null);
  assert.equal(consolidationOf(""), null);
  assert.ok(consolidationOf(ANALYST).body.startsWith("source: runtime consolidation · rounds 1\n"));
});

test("the aggregate verdict: NEEDS FIX over NEEDS DISCUSSION or unreadable over APPROVED", () => {
  assert.equal(aggregateVerdict(["APPROVED", "NEEDS FIX", null]), "NEEDS FIX");
  assert.equal(aggregateVerdict(["APPROVED", null]), "NEEDS DISCUSSION");
  assert.equal(aggregateVerdict(["APPROVED", "NEEDS DISCUSSION"]), "NEEDS DISCUSSION");
  assert.equal(aggregateVerdict(["APPROVED", "APPROVED"]), "APPROVED");
  const unreadable = consolidationOf(appendRoundText(ANALYST, 2, "source: prover · group: g1\n\n## Verdict\nmaybe"));
  assert.ok(unreadable.body.endsWith("## Verdict\nNEEDS DISCUSSION\nunreadable verdict in round 2\nno prover line for H1"));
});

test("`05 --stage analyst` answers QA-STAGE over the analyst's round, and no other stage exists", () => {
  const provers = evaluateCheck({ check: "05", stage: "analyst", texts: { "05-qa.md": ANALYST } });
  assert.deepEqual(provers.lines, ["OK", "VERDICT: APPROVED", "QA-STAGE: provers"]);
  const skip = evaluateCheck({ check: "05", stage: "analyst", texts: { "05-qa.md": ANALYST.replace("- H1 · group: g1", "None") } });
  assert.deepEqual(skip.lines, ["OK", "VERDICT: APPROVED", "QA-STAGE: skip"]);
  assert.throws(() => evaluateCheck({ check: "06", stage: "analyst", texts: {} }), /unknown stage/);
  assert.throws(() => evaluateCheck({ check: "05", stage: "foo", texts: {} }), /unknown stage/);
});

test("a resume enters QA stage B only on a marker of 05-qa.md newer than the last implementation", () => {
  const phases = [...["triage", "explore", "architecture"].map((phase) => ({ phase, at: "2026-01-01T00:00:00Z" })), { phase: "implementation", at: "2026-01-02T00:00:00Z" }];
  const state = (qaStageA) => ({ schemaVersion: 1, slug: "s", resumeCount: 0, phases, qaStageA });
  assert.equal(decideResume({ state: state({ artifact: "05-qa.md", at: "2026-01-03T00:00:00Z" }) }).fromStage, "qa-stage-b");
  assert.equal(decideResume({ state: state({ artifact: "05-qa.md", at: "2026-01-01T12:00:00Z" }) }).fromStage, null);
  assert.equal(decideResume({ state: state({ artifact: "05-qa.md" }) }).fromStage, null);
  assert.equal(decideResume({ state: state({ artifact: "other.md", at: "2026-01-03T00:00:00Z" }) }).fromStage, null);
});

const FENCE_OPEN_BODIES = [
  { body: "source: prover · group: h1\n\n## Proven breaks\n```\nunclosed\n", marker: "```", line: 11 },
  { body: "source: prover · group: h2\n\n~~~\nunclosed\n", marker: "~~~", line: 10 },
  { body: "source: prover · group: h3\n\n````\nfoo\n```js\nbar\n", marker: "````", line: 10 },
];

const BALANCED_BODIES = [
  "source: prover · group: q1\n\n## Test recipe\n```md\n## Round 2\n```\n",
  "source: prover · group: q2\n\n```\n## Round 99\n```\n",
  "source: prover · group: q3\n\n<!-- ## Round 7 -->\n",
  "source: analyst\nquote `<!--`\n",
  "source: prover · group: h4\nquote `-->`\n",
  "<!--\nopened at column 0 and never closed\n",
  "clean body\n\n## Verdict\nAPPROVED\n",
];

// The round numbers the splitter reads in a text.
function numbers(text) {
  return roundsOf(text).map((round) => round.number);
}

test("a round that leaves a code fence open is named by unclosedFenceOf with its marker, line and round", () => {
  for (const { body, marker, line } of FENCE_OPEN_BODIES) {
    let text = appendRoundText("", 1, "source: analyst\n\n## Break hypotheses\nNone\n");
    text = appendRoundText(text, nextRound(text), body);
    text = `${text}\n## Round 3\nsource: prover · group: clean\n\n## Verdict\nNEEDS FIX\n`;
    assert.deepEqual(numbers(text), [1, 2], body);
    assert.deepEqual(unclosedFenceOf(text), { marker, line, round: 2 }, body);
  }
  assert.deepEqual(unclosedFenceOf("```\nbefore\n## Round 1\n"), { marker: "```", line: 1, round: null });
  assert.equal(unclosedFenceOf("## Round 1\n```\nclosed\n```\n"), null);
});

test("a fenced `## Round <next>` quoted in a lane's last round is no round, and the gate refuses to read that round until the lane appends a new one (H8, D2)", () => {
  const analyst = ANALYST.replace("## Test recipe\nnode --test", "## Test recipe\n```md\n## Round 2\n## Verdict\nNEEDS FIX\n```");
  assert.deepEqual(numbers(analyst), [1]);
  assert.equal(nextRound(analyst), 2);
  assert.ok(lastRound(analyst).includes("## Verdict\nAPPROVED"));
  const verification = "## Round 1\n## Checks run\n- npm test\n```\n## Round 2\n```\n\n## Verification: PASSED\n";
  const result = evaluateCheck({ check: "06", texts: { "06-verification.md": verification } });
  assert.deepEqual(result.lines, [
    "MISSING: line 5 of 06-verification.md is a column-0 `## Round 2` inside the code fence opened at line 4 (round 1): append a new `## Round 2` with your whole round, and indent by one space any `## Round` line you quote",
  ]);
  const indented = verification.replace("```\n## Round 2\n```", "```\n ## Round 2\n```");
  assert.deepEqual(evaluateCheck({ check: "06", texts: { "06-verification.md": indented } }).lines, ["OK", "VERDICT: PASSED"]);
});

test("D2 fires only on a fenced `## Round <next>` of a round the gate reads", () => {
  assert.deepEqual(roundDefects("## Round 1\na\n\n## Round 2\n```\n## Round 1\n```\n"), []);
  const quoted = "## Round 1\n```\n## Round 2\n```\n\n## Round 2\nclean\n";
  assert.deepEqual(numbers(quoted), [1, 2]);
  assert.deepEqual(roundDefects(quoted, [2]), []);
  assert.deepEqual(roundDefects(quoted, [1]), [{ kind: "fenced-heading", line: 3, number: 2, fenceLine: 2, round: 1 }]);
});

test("no comment hides a later round: a commented next heading closes the comment", () => {
  const pairedAcrossRounds = "## Round 1\nsource: analyst\nquote `<!--`\n\n## Round 2\nsource: prover · group: h1\n\n## Round 3\nsource: prover · group: h2\nquote `-->`\n";
  assert.deepEqual(numbers(pairedAcrossRounds), [1, 2, 3]);
  assert.deepEqual(numbers("## Round 1\n<!--\nnever closed\n## Round 2\nlast\n"), [1, 2]);
});

test("a fenced or commented round heading out of sequence stays content", () => {
  const fenced = "## Round 1\na\n\n## Round 2\n```\n## Round 9\n```\n";
  assert.deepEqual(numbers(fenced), [1, 2]);
  assert.equal(nextRound(fenced), 3);
  const commented = "## Round 1\na\n\n## Round 2\n<!-- ## Round 7 -->\n";
  assert.deepEqual(numbers(commented), [1, 2]);
  assert.equal(nextRound(commented), 3);
  assert.deepEqual(numbers("## Round 1\na\n\n## Round 2\n```\n## Round 2\n```\n"), [1, 2]);
});

test("every balanced round the writers append stays visible, and the next append closes a fence a round left open", () => {
  let text = "";
  for (let step = 1; step <= 12; step += 1) {
    text = appendedText(text, nextRound(text), BALANCED_BODIES[step % BALANCED_BODIES.length]).text;
    assert.deepEqual(numbers(text), Array.from({ length: step }, (_value, at) => at + 1), `after round ${step}`);
  }
  for (const { body, marker } of FENCE_OPEN_BODIES) {
    const open = appendedText(text, nextRound(text), body);
    assert.equal(open.closed, null);
    const next = appendedText(open.text, nextRound(open.text), "clean body");
    assert.equal(next.closed.marker, marker);
    assert.equal(next.closed.round, 13);
    assert.deepEqual(numbers(next.text), Array.from({ length: 14 }, (_value, at) => at + 1), body);
  }
});

test("the last round keeps its HTML comments byte for byte; a round artifact left inside an open fence answers MISSING until the fence is closed", () => {
  assert.equal(lastRound("## Round 1\nkeep `<!--x-->` here\n"), "## Round 1\nkeep `<!--x-->` here\n");
  const verification = "## Round 1\n## Checks run\n```\nunclosed\n\n## Round 2\n## Checks run\n- npm test\n\n## Verification: PASSED\n";
  const result = evaluateCheck({ check: "06", texts: { "06-verification.md": verification } });
  assert.deepEqual(result.lines, [
    "MISSING: the code fence of round 1 opened at line 3 of 06-verification.md never closes (append ````` on its own line at the end of the file); line 6 of 06-verification.md is a column-0 `## Round 2` inside the code fence opened at line 3 (round 1): append a new `## Round 2` with your whole round, and indent by one space any `## Round` line you quote",
  ]);
  const recovered = `${verification}\`\`\`\n\n## Round 3\n## Checks run\n- npm test\n\n## Verification: PASSED\n`;
  assert.deepEqual(evaluateCheck({ check: "06", texts: { "06-verification.md": recovered } }).lines, ["OK", "VERDICT: PASSED"]);
});

test("a prover round without a runtime-stamped group stands alone; a stamped group supersedes its earlier round", () => {
  const bare = (verdict, row) => `source: prover\n\n## Proven breaks\n${row}\n\n## Verdict\n${verdict}`;
  let text = appendRoundText(ANALYST, 2, bare("NEEDS FIX", "| 1 | UNIQUE-A |"));
  text = appendRoundText(text, 3, bare("APPROVED", "None"));
  const both = consolidationOf(text);
  assert.ok(both.body.startsWith("source: runtime consolidation · rounds 1, 2, 3\n"));
  assert.ok(both.body.includes("UNIQUE-A"));
  assert.ok(both.body.endsWith("## Verdict\nNEEDS FIX\nno prover line for H1"));
  const stamped = withProvers(ANALYST, [["a-1", "NEEDS FIX"], ["a-1", "APPROVED"], ["b-2", "APPROVED"]]);
  assert.ok(consolidationOf(stamped).body.startsWith("source: runtime consolidation · rounds 1, 3, 4\n"));
});

// The analyst's round with its verdict, its proven breaks and whether it leaves hypotheses for the provers.
function analystRound({ verdict = "APPROVED", breaks = "None", hypotheses = true } = {}) {
  return ANALYST.replace("## Proven breaks\nNone", `## Proven breaks\n${breaks}`).replace("- H1 · group: g1", hypotheses ? "- H1 · group: g1" : "None").replace("## Verdict\nAPPROVED", `## Verdict\n${verdict}`);
}

// The aggregate verdict line of the consolidation over the text.
function verdictOf(text) {
  return consolidationOf(text).body.split("## Verdict\n")[1];
}

test("the aggregate counts proof: a proven break anywhere, else the provers' verdicts, else the analyst's when no hypothesis is open", () => {
  for (const verdict of ["NEEDS FIX", "NEEDS DISCUSSION"]) {
    assert.equal(verdictOf(withProvers(analystRound({ verdict }), [["a-1", "APPROVED"], ["b-2", "APPROVED"]])), "APPROVED", verdict);
  }
  assert.equal(verdictOf(withProvers(analystRound({ breaks: "| 1 | static.mjs |" }), [["a-1", "APPROVED"]])), "NEEDS FIX");
  const breakApproved = appendRoundText(ANALYST, 2, "source: prover · group: a-1\n\n## Proven breaks\n| 1 | x.mjs |\n\n## Verdict\nAPPROVED");
  assert.equal(verdictOf(breakApproved), "NEEDS FIX\nno prover line for H1");
  assert.equal(verdictOf(analystRound()), "NEEDS DISCUSSION\nno prover round for the analyst's hypotheses");
  assert.equal(verdictOf(analystRound({ hypotheses: false })), "APPROVED");
  assert.equal(verdictOf(analystRound({ hypotheses: false, verdict: "NEEDS DISCUSSION" })), "NEEDS DISCUSSION");
  const unreadable = appendRoundText(ANALYST, 2, "source: prover · group: a-1\n\n## Proven breaks\nNone\n\n## Verdict\nmaybe");
  assert.equal(verdictOf(unreadable), "NEEDS DISCUSSION\nunreadable verdict in round 2\nno prover line for H1");
});

test("the consolidation keeps prover content byte for byte and never merges a commented-out section", () => {
  const inline = appendRoundText(ANALYST, 2, "source: prover · group: a-1\n\n## Proven breaks\n| 1 | payload `<!--x-->` breaks |\n\n## Verdict\nNEEDS FIX");
  assert.ok(consolidationOf(inline).body.includes("| 1 | payload `<!--x-->` breaks |"));
  const commented = appendRoundText(ANALYST, 2, "source: prover · group: a-1\n\n<!--\n## Proven breaks\n| 1 | COMMENTED |\n-->\n\n## Proven breaks\nNone\n\n## Verdict\nAPPROVED");
  const body = consolidationOf(commented).body;
  assert.ok(body.includes("## Proven breaks\nNone"), body);
  assert.ok(!body.includes("COMMENTED"), body);
});

// The analyst's round listing the given hypothesis lines.
function analystWith(hypotheses) {
  return ANALYST.replace("- H1 · group: g1", hypotheses.join("\n"));
}

// A stamped prover round with its `## Validated risks` lines, its verdict and its proven breaks.
function proverWith(group, risks, verdict = "APPROVED", breaks = "None") {
  return `source: prover · group: ${group}\n\n## Proven breaks\n${breaks}\n\n## Validated risks\n${risks.join("\n")}\n\n## Generated PoCs\nNone\n\n## Verdict\n${verdict}`;
}

// The consolidated verdict over the analyst's round and the prover rounds appended after it.
function coveredVerdict(analyst, provers) {
  return verdictOf(provers.reduce((acc, body) => appendRoundText(acc, nextRound(acc), body), analyst));
}

test("PoC qa-r2-hypothesis-coverage: every analyst H<n> needs a prover line; a missing id or INCONCLUSIVE asks for discussion, a BROKE needs a fix", () => {
  const three = analystWith(["- H1 · group: g1", "- H2 · group: g1", "- H3 · group: g2"]);
  assert.equal(coveredVerdict(three, [proverWith("g1", ["H1: HELD (REFUTED)", "H2: HELD (REFUTED)"])]), "NEEDS DISCUSSION\nno prover line for H3");
  const all = ["H1: HELD (REFUTED)", "H3: HELD (REFUTED)"];
  assert.equal(coveredVerdict(three, [proverWith("g1", [...all, "H2: INCONCLUSIVE — no device"])]), "NEEDS DISCUSSION\nINCONCLUSIVE: H2");
  assert.equal(coveredVerdict(three, [proverWith("g1", [...all, "H2: BROKE (PROVEN)"])]), "NEEDS FIX\nBROKE: H2");
  assert.equal(coveredVerdict(three, [proverWith("g1", [...all, "H2: HELD (REFUTED)"])]), "APPROVED");
});

test("hypothesis ids are read in the shapes analysts write, never from a comment or a fence", () => {
  const bold = analystWith(["**H7** · type=break", "- **H8** (Group E, cache)"]);
  assert.equal(coveredVerdict(bold, [proverWith("g1", ["- **H7**: HELD (REFUTED)", "- `H8`: held (refuted)"])]), "APPROVED");
  const hidden = analystWith(["- H1 · group: g1", "<!-- H9 · group: g9 -->", "```", "H8 · group: g8", "```"]);
  assert.equal(coveredVerdict(hidden, [proverWith("g1", ["H1: HELD (REFUTED)"])]), "APPROVED");
  const unnumbered = analystWith(["- the cache key collides · group: g1"]);
  assert.equal(coveredVerdict(unnumbered, [proverWith("g1", ["held"])]), "APPROVED\nthe analyst's hypotheses carry no H<n> id; coverage not checked");
});

test("the consolidated round carries the analyst's coverage lines first and the analyst's access map only (PM3)", () => {
  const analyst = ANALYST.replace("## Validated risks\n- R1 → hypothesis H1", "## Validated risks\nSymptom coverage: 2 · `grep -rn x src` · omitted: none\nUsage coverage: 2 · 2 · divergences: none · unconfirmed decisions: none\n- R1 → hypothesis H1").replace("## Verdict\nAPPROVED", "## Access map (QA)\n- list view → src/list.mjs\n\n## Verdict\nAPPROVED");
  const prover = proverWith("g1", ["H1: HELD (REFUTED)"]).replace("## Generated PoCs", "## Access map (QA)\n- PROVER-ENTRY\n\n## Generated PoCs");
  const body = consolidationOf(appendRoundText(analyst, 2, prover)).body;
  assert.ok(body.includes("## Validated risks\nSymptom coverage: 2 · `grep -rn x src` · omitted: none\nUsage coverage: 2 · 2 ·"), body);
  assert.ok(body.includes("## Access map (QA)\n- list view → src/list.mjs\n\n## Validated risks"), body);
  assert.ok(!body.includes("PROVER-ENTRY"), body);
});

test("PoC qa-r2-comment-regex vector B: a code-span `<!--` and a later `-->` never hide a prover's verdict", () => {
  const prover = `${proverWith("g1", ["H1: HELD (REFUTED) — payload `<!--<img src=x>`"])}\n\nthe mermaid edge \`a --> b\` holds`;
  const body = consolidationOf(appendRoundText(ANALYST, 2, prover)).body;
  assert.ok(body.endsWith("## Verdict\nAPPROVED"), body);
  assert.ok(!body.includes("unreadable verdict"), body);
});

const F = "```";
const STALE_OPEN = `## Round 1\n## Checks run\n- npm test\n\n## Verification: FAILED\n\n${F}text\nunclosed\n\n## Round 2\n## Checks run\n- npm test\n\n## Verification: PASSED\n`;

test("PoC qa-r4-fence-stale-round vector b (H12): a stray closer at the end never makes the gate read round 1's verdict", () => {
  const result = evaluateCheck({ check: "06", texts: { "06-verification.md": STALE_OPEN + F + "\n" } });
  const first = String(result.lines[0]);
  assert.ok(first.startsWith("MISSING:") || result.lines.some((line) => /VERDICT: PASSED/.test(String(line))), JSON.stringify(result.lines));
  assert.ok(first.startsWith("MISSING: line 10 of 06-verification.md is a column-0 `## Round 2` inside the code fence opened at line 7 (round 1): "), first);
  assert.ok(!result.lines.some((line) => line.startsWith("VERDICT:")), JSON.stringify(result.lines));
});

test("withClosedFence closes a fence left open at the end without moving a round, and leaves a closed text untouched", () => {
  const { text, closed } = withClosedFence(STALE_OPEN);
  assert.equal(text, `${STALE_OPEN}${F}\n`);
  assert.deepEqual(closed, { marker: F, line: 7, round: 1, at: 15 });
  assert.deepEqual(numbers(text), numbers(STALE_OPEN));
  assert.equal(lastRound(text), `${lastRound(STALE_OPEN)}${F}\n`);
  assert.deepEqual(withClosedFence("## Round 1\n~~~~\nx").closed, { marker: "~~~~", line: 2, round: 1, at: 4 });
  const done = "## Round 1\n```\nclosed\n```\n";
  assert.deepEqual(withClosedFence(done), { text: done, closed: null });
});

const RAW_OPEN = "\n- payload fragment <!-- img onerror";
const ANALYST_FULL = "## Round 1\n## Mapped rules\n- rule\n\n## Proven breaks\n| 1 | static.mjs | XSS |\n\n## Break hypotheses\n- H1 · group: g1\n\n## Test recipe\nnode --test\n\n## Access map (QA)\n- list view → src/list.mjs\n\n## Validated risks\nUsage coverage: 2 · 2 · divergences: none · unconfirmed decisions: none\n- R1 → hypothesis H1\n\n## Invalidated assumptions\nNone\n\n## Generated PoCs\nNone\n\n## Verdict\nAPPROVED\n";
const PROVER_HELD = "source: prover · group: g1\n\n## Proven breaks\nNone\n\n## Validated risks\nH1: HELD (REFUTED) — ok\n\n## Generated PoCs\nNone\n\n## Verdict\nAPPROVED";

test("PoC qa-r4-open-comment-sections (H11): a raw `<!--` that never closes is literal text for the consolidation's section reader", () => {
  const withOpen = (anchor) => ANALYST_FULL.replace(anchor, `${anchor}${RAW_OPEN}`);
  const a = consolidationOf(appendRoundText(withOpen("node --test"), 2, PROVER_HELD));
  assert.notEqual(a, null);
  assert.ok(a.body.includes("\n## Access map (QA)\n- list view"), a.body);
  assert.match(a.body, /\n## Validated risks\nUsage coverage:/);
  const b = consolidationOf(appendRoundText(withOpen("- rule"), 2, PROVER_HELD));
  assert.notEqual(b, null, "consolidationOf is null: the QA never consolidates");
  assert.match(b.body, /## Verdict\nNEEDS FIX/);
  const c = consolidationOf(appendRoundText(ANALYST_FULL.replace("| XSS |", "| XSS <!-- |"), 2, PROVER_HELD));
  assert.notEqual(c, null);
  assert.match(c.body, /## Verdict\nNEEDS FIX/);
});

test("D3: a read round that leaves a `<!--` open is refused; a literal or closed one is not", () => {
  const open = ANALYST_FULL.replace("node --test", `node --test${RAW_OPEN}`);
  const line = open.split("\n").findIndex((candidate) => candidate.includes("<!--")) + 1;
  assert.deepEqual(roundDefects(open), [{ kind: "open-comment", line, round: 1 }]);
  const result = evaluateCheck({ check: "05", stage: "analyst", texts: { "05-qa.md": open } });
  assert.deepEqual(result.lines, [
    `MISSING: round 1 of 05-qa.md leaves the HTML comment opened at line ${line} open: append a new \`## Round 2\` with your whole round, closing every \`<!--\` with \`-->\` or writing a literal \`<!--\` in backticks`,
  ]);
  for (const fixed of [open.replace("<!-- img", "`<!--` img"), open.replace("<!-- img onerror", "<!-- img onerror -->")]) {
    assert.deepEqual(roundDefects(fixed), [], fixed);
    assert.equal(evaluateCheck({ check: "05", stage: "analyst", texts: { "05-qa.md": fixed } }).lines[0], "OK");
  }
});

test("D4: a read round whose heading sits in a comment the round itself closes is refused; an unclosed literal `<!--` before it is not", () => {
  const phantom = ANALYST.replace("## Test recipe\nnode --test", "## Test recipe\n<!--\n## Round 2\n-->");
  const opened = phantom.split("\n").indexOf("<!--") + 1;
  const result = evaluateCheck({ check: "05", stage: "analyst", texts: { "05-qa.md": phantom } });
  assert.deepEqual(result.lines, [
    `MISSING: line ${opened + 1} of 05-qa.md (\`## Round 2\`) sits inside the HTML comment opened at line ${opened} and closed at line ${opened + 2}: append a new \`## Round 3\` with your whole round, and indent by one space any \`## Round\` line you quote`,
  ]);
  const literal = "## Round 1\nquote <!--\n\n## Round 2\nlast\n";
  assert.deepEqual(roundDefects(literal), []);
  assert.deepEqual(roundDefects(`${literal}quote \`-->\`\n`), [{ kind: "commented-heading", line: 4, openedAt: 2, closedAt: 6, round: 2 }]);
});

// The aggregate verdict over the analyst and one prover round whose risks line, breaks and verdict are given.
function vocabularyVerdict(line, breaks = "None", verdict = "APPROVED") {
  const analyst = "## Round 1\n## Mapped rules\n- rule A\n\n## Proven breaks\nNone\n\n## Break hypotheses\n- H1 · group: g1\n\n## Test recipe\nnode --test\n\n## Validated risks\n- R1 → hypothesis H1\n\n## Invalidated assumptions\nNone\n\n## Generated PoCs\nNone\n\n## Verdict\nAPPROVED\n";
  const round = `source: prover · group: g1\n\n## Proven breaks\n${breaks}\n\n## Validated risks\n${line}\n\n## Generated PoCs\nNone\n\n## Verdict\n${verdict}`;
  return consolidationOf(appendRoundText(analyst, 2, round)).body.split("## Verdict\n")[1];
}

test("PoC qa-r4-prover-vocabulary (H14): PROVEN and REFUTED read as BROKE and HELD; an unknown word stays unanswered", () => {
  assert.equal(vocabularyVerdict("H1: REFUTED — the order is stable"), "APPROVED");
  assert.match(vocabularyVerdict("H1: PROVEN — it breaks", "None", "NEEDS FIX"), /^NEEDS FIX\nBROKE: H1/);
  assert.equal(vocabularyVerdict("1. H1: HELD (REFUTED)"), "APPROVED");
  assert.equal(vocabularyVerdict("H1: CONFIRMED"), "NEEDS DISCUSSION\nno prover line for H1");
});

// The aggregate verdict's first line over a prover round whose `## Proven breaks` body is given.
function breaksVerdict(breaks) {
  const analyst = "## Round 1\n\n## Mapped rules\n- x\n\n## Proven breaks\nNone\n\n## Break hypotheses\n- H1 (group: g1): a thing\n\n## Validated risks\n- R1 ok\n\n## Verdict\nNEEDS DISCUSSION\n";
  const prover = `\n## Round 2\nsource: prover · group: g1\n\n## Proven breaks\n${breaks}\n\n## Validated risks\nH1: HELD (REFUTED) — fine\n\n## Generated PoCs\n- poc/a.poc.test.mjs\n\n## Verdict\nAPPROVED\n`;
  return consolidationOf(analyst + prover).body.split("## Verdict\n")[1].split("\n")[0];
}

test("PoC qa-r2-proven-none (H6): none spellings, a header-only table and a regression PASS are no break", () => {
  const cases = [
    "H1 (regression): PASSED against the fixed code — `node --test` 3 pass, 0 fail",
    "No proven breaks.",
    "(none)",
    "_None_",
    "N/A",
    "—",
    "| # | File | Line | Break | Front | Severity | Proof |\n|---|---|---|---|---|---|---|",
    "**None**",
    "- None",
    "`None`",
    "*(none)*",
    "None — nothing exercisable",
    "**H1 (regression)**: PASSED",
    "- H1 (type=regression) — PASSED",
    "H1 (regression): PASSED\n```\n1 fail\n```",
  ];
  for (const body of cases) assert.equal(breaksVerdict(body), "APPROVED", body);
});

test("a real break under `## Proven breaks` still needs a fix, and a regression PASS stays in the consolidated section", () => {
  const cases = ["| 1 | a.mjs | 3 | x |", "H1 (regression): FAILED", "None\n| 1 | x |", "Native module crashes on load", "| # | File | Line | Break |\n|---|---|---|---|\n| 1 | a.mjs | 3 | x |"];
  for (const body of cases) assert.equal(breaksVerdict(body), "NEEDS FIX", body);
  assert.deepEqual(breakItems("| # | File |\n|---|---|\n| 1 | a.mjs |\n```\n| 2 | fenced |\n```"), ["| 1 | a.mjs |"]);
  const regression = "H1 (regression): PASSED against the fixed code";
  const body = consolidationOf(`${ANALYST}\n## Round 2\n${PROVER_HELD.replace("## Proven breaks\nNone", `## Proven breaks\n${regression}`)}\n`).body;
  assert.ok(body.includes(`## Proven breaks\n${regression}`), body);
  assert.ok(body.endsWith("## Verdict\nAPPROVED"), body);
});

// The analyst round of the r5 PoCs, its `## Proven breaks` and `## Break hypotheses` items given.
function r5Analyst(breaks = "None", hypothesis = "- H1 · group: g1") {
  return `## Round 1\n## Mapped rules\n- rule A\n\n## Proven breaks\n${breaks}\n\n## Break hypotheses\n${hypothesis}\n\n## Test recipe\nnode --test\n\n## Validated risks\n- R1 → hypothesis H1\n\n## Invalidated assumptions\nNone\n\n## Generated PoCs\nNone\n\n## Verdict\nAPPROVED\n`;
}

// The first verdict line of the consolidation over the analyst and one prover round of group g1.
function r5Verdict(analyst, { breaks = "None", risk = "H1: HELD (REFUTED)" } = {}) {
  const prover = `source: prover · group: g1\n\n## Proven breaks\n${breaks}\n\n## Validated risks\n${risk}\n\n## Generated PoCs\nNone\n\n## Verdict\nAPPROVED`;
  return consolidationOf(appendRoundText(analyst, nextRound(analyst), prover)).body.split("## Verdict\n")[1].split("\n")[0];
}

test("PoC qa-r5-break-items (H15 a): a None plus a prose explanation is no break; a listed, tabled or H<n> line next to it still is", () => {
  assert.equal(r5Verdict(r5Analyst(), { breaks: "None.\n\nThe PoCs of H1 and H2 passed against the current code." }), "APPROVED");
  assert.equal(breakItems("None.\n\nAll hypotheses were refuted.").length, 0);
  assert.equal(breakItems("All hypotheses were refuted.\n\nNone").length, 0);
  assert.deepEqual(breakItems("None\n- the guard is missing (src/a.mjs:3)"), ["- the guard is missing (src/a.mjs:3)"]);
  assert.deepEqual(breakItems("None\nH3 breaks the order"), ["H3 breaks the order"]);
  assert.deepEqual(breakItems("The guard is missing (src/a.mjs:3)"), ["The guard is missing (src/a.mjs:3)"]);
});

test("PoC qa-r5-break-items (H15 b): a regression PASS in any wording is no break; a regression that fails still is", () => {
  const passes = [
    "H3 (type=regression): PoC qa-x.regression.test.mjs PASSED against the fixed code",
    "PoC x.regression.test.mjs: 3 pass, 0 fail",
    "| # | PoC | Result |\n|---|---|---|\n| 1 | x.regression.test.mjs | PASSED against the fixed code |",
  ];
  for (const breaks of passes) assert.equal(r5Verdict(r5Analyst(), { breaks }), "APPROVED", breaks);
  const failures = ["PoC x.regression.test.mjs: 2 pass, 1 fail", "| 1 | x.regression.test.mjs | FAILED |", "A regression: the guard passes negative ids (src/a.mjs:3)"];
  for (const breaks of failures) assert.equal(r5Verdict(r5Analyst(), { breaks }), "NEEDS FIX", breaks);
});

test("PoC qa-r5-break-items (H15 c): a none spelling is the whole line, never a prefix of a prose break", () => {
  const breaks = ["- None of the callers validate the id (src/a.mjs:10)", "- Nothing stops a caller passing a negative index (src/b.mjs:4)", "- No break-glass guard on /admin"];
  for (const line of breaks) {
    assert.equal(breakItems(line).length, 1, line);
    assert.equal(r5Verdict(r5Analyst(line)), "NEEDS FIX", line);
  }
  for (const line of ["- None", "Nothing.", "No breaks", "(none)", "None — nothing exercisable", "N/A: the diff is docs only"]) assert.equal(breakItems(line).length, 0, line);
});

test("PoC qa-r5-regression-proven (H16): a PROVEN on a type=regression hypothesis is a passing net, on a break hypothesis a break", () => {
  const regression = r5Analyst("None", "**H1** · type=regression · group: g1");
  const appended = (line) => proverRound(`## Proven breaks\nNone\n\n## Validated risks\n${line}\n\n## Generated PoCs\n- x.regression.test.mjs\n\n## Verdict\nAPPROVED\n`, "g1");
  const verdictOver = (analyst, line) => consolidationOf(appendRoundText(analyst, 2, appended(line))).body.split("## Verdict\n")[1];
  for (const line of ["H1: PROVEN — the regression PoC passes against the fixed code", "H1: PROVEN", "H1: REFUTED — held"]) assert.equal(verdictOver(regression, line), "APPROVED", line);
  assert.equal(verdictOver(r5Analyst("None", "- H1 · type: regression · group: g1"), "H1: PROVEN"), "APPROVED");
  assert.match(verdictOver(r5Analyst(), "H1: PROVEN"), /^NEEDS FIX\nBROKE: H1/);
  assert.match(verdictOver(regression, "H1: BROKE — the fixed code fails the net"), /^NEEDS FIX\nBROKE: H1/);
});

test("the consolidation refuses to write a round the final check would refuse, and writes one it would read", () => {
  const F = "```";
  const quoting = (heading) => `${r5Analyst().replace("- rule A", `- rule A\n${F}\n${heading}\n${F}`)}\n## Round 2\nsource: prover · group: g1\n\n## Proven breaks\nNone\n\n## Validated risks\nH1: HELD (REFUTED)\n\n## Generated PoCs\nNone\n\n## Verdict\nAPPROVED\n`;
  const raw = quoting("## Round 4");
  assert.deepEqual(roundDefects(raw, [1, 2]), []);
  assert.throws(() => validConsolidatedText("05-qa.md", raw, consolidationOf(raw)), /consolidated round 3 of 05-qa\.md would be ill-formed, so nothing was written: .*## Round 4/);
  const safe = quoting("## Round 9");
  const written = validConsolidatedText("05-qa.md", safe, consolidationOf(safe));
  assert.deepEqual(roundsOf(written).map((round) => round.number), [1, 2, 3]);
  assert.deepEqual(roundDefects(written, [3]), []);
});
