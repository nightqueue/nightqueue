import assert from "node:assert/strict";
import { test } from "node:test";
import { SILENT_STOP_NOTICE, classifyJobResult } from "../../src/queue/classify.mjs";
import { extractResultText } from "../../src/queue/stream.mjs";
import { GATE_MARKER, NOTICE_HEADING, PR_URL, resultEvent, systemInitEvent, toNdjson } from "../../test-support/streams.mjs";

// A log whose only result event carries text, wrapping the pieces classify.mjs reads off it.
function logWithResultText(text) {
  return toNdjson([systemInitEvent(), resultEvent({ text })]);
}

// A log that never emitted a `result` event at all, the case `extractResultText` reports as null.
function logWithNoResultEvent() {
  return toNdjson([systemInitEvent()]);
}

// A log whose result event carries no string at all, the case `extractResultText` reports as "".
function logWithResultEventButNoText() {
  return toNdjson([systemInitEvent(), { type: "result", subtype: "success", session_id: "sess-abc12345" }]);
}

// Builds the final text of a run out of the pieces the classifier looks for, notice always last so its body is exact.
function composeText({ pr = false, gate = false, notice = null, body = "" } = {}) {
  const parts = [];
  if (gate) parts.push(GATE_MARKER);
  if (body) parts.push(body);
  if (pr) parts.push(`Done. Pull request: ${PR_URL}`);
  if (notice !== null) parts.push(`${NOTICE_HEADING}\n\n${notice}`);
  return parts.join("\n\n");
}

// A regex that catches a surrogate half left without its pair, the signature of a UTF-16-unit cut.
const LONE_HIGH_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/;
const LONE_LOW_SURROGATE_RE = /(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

test("extractResultText keeps the documented distinction: '' means a result event with no text, null means no result event at all", () => {
  assert.equal(extractResultText(logWithResultEventButNoText()), "", "a result event without a string result must read back as ''");
  assert.equal(extractResultText(logWithNoResultEvent()), null, "no result event at all must read back as null");
  assert.equal(extractResultText(logWithResultText("")), "", "an explicit empty string result must read back as ''");
});

test("H3: classifyJobResult collapses '' and null to the exact same silent-stop outcome, because every consumer downstream already treats them as equally falsy", () => {
  const missing = classifyJobResult({ log: logWithNoResultEvent(), exitCode: 0 });
  const emptyEvent = classifyJobResult({ log: logWithResultEventButNoText(), exitCode: 0 });
  const emptyString = classifyJobResult({ log: logWithResultText(""), exitCode: 0 });

  for (const outcome of [missing, emptyEvent, emptyString]) {
    assert.equal(outcome.status, "failed");
    assert.equal(outcome.noticeMd, SILENT_STOP_NOTICE);
  }
  // The `?? ""` in classify.mjs erases a distinction extractResultText still makes (proved above),
  // but no code path in src/ branches on resultText's null-vs-"" difference, so the three logs are
  // truly indistinguishable to the operator today: a coverage gap, not observable damage.
  assert.equal(missing.resultText, "");
  assert.equal(emptyEvent.resultText, "");
  assert.equal(emptyString.resultText, "");
});

test("a real crash never flips to gate or cancelled because of a PR link, a gate marker or a notice sitting in the log (matches origin/main's early-return order)", () => {
  const variants = [
    composeText({}),
    composeText({ pr: true }),
    composeText({ gate: true }),
    composeText({ pr: true, gate: true, notice: "some notice body", body: "narration before the crash" }),
  ];
  const endings = [
    { exitCode: 1, expected: "failed" },
    { exitCode: 0, timedOut: true, expected: "failed" },
    { exitCode: 0, idleTimedOut: true, expected: "failed" },
    { exitCode: -1, stopped: true, expected: "cancelled" },
    { exitCode: -1, stopped: true, timedOut: true, expected: "cancelled" },
  ];
  for (const { expected, ...ending } of endings) {
    for (const text of variants) {
      const outcome = classifyJobResult({ log: logWithResultText(text), ...ending });
      assert.equal(outcome.status, expected, `${JSON.stringify(ending)} with text=${JSON.stringify(text)}`);
    }
    // The same non-clean endings behave identically with no result event at all.
    assert.equal(classifyJobResult({ log: logWithNoResultEvent(), ...ending }).status, expected, JSON.stringify(ending));
  }
});

test("the exit-0 matrix: every combination of PR, gate marker and notice lands on the one status the operator expects", () => {
  const cases = [
    { text: composeText({ pr: true, gate: true }), expectedStatus: "gate", expectedPr: PR_URL },
    { text: composeText({ pr: true }), expectedStatus: "done", expectedPr: PR_URL },
    { text: composeText({ notice: "please pick a column name" }), expectedStatus: "gate", expectedPr: null, expectedNotice: "please pick a column name" },
    { text: composeText({ body: "I need a human to decide something." }), expectedStatus: "gate", expectedPr: null, expectedNotice: "I need a human to decide something." },
    { text: "", expectedStatus: "failed", expectedPr: null, expectedNotice: SILENT_STOP_NOTICE },
    { text: "   \n\t  ", expectedStatus: "failed", expectedPr: null, expectedNotice: SILENT_STOP_NOTICE },
  ];
  for (const { text, expectedStatus, expectedPr, expectedNotice } of cases) {
    const outcome = classifyJobResult({ log: logWithResultText(text), exitCode: 0 });
    assert.equal(outcome.status, expectedStatus, JSON.stringify(text));
    assert.equal(outcome.prUrl, expectedPr, JSON.stringify(text));
    if (expectedNotice !== undefined) assert.equal(outcome.noticeMd, expectedNotice, JSON.stringify(text));
  }
  // No result event at all lands on the exact same outcome as an explicit empty string (H3 again, at exit 0).
  const missing = classifyJobResult({ log: logWithNoResultEvent(), exitCode: 0 });
  assert.equal(missing.status, "failed");
  assert.equal(missing.noticeMd, SILENT_STOP_NOTICE);
});

test("central invariant: no combination of ending flags, PR, gate marker or notice ever produces a gate with an empty or blank notice", () => {
  const endings = [
    { exitCode: 0 },
    { exitCode: 1 },
    { exitCode: 0, timedOut: true },
    { exitCode: 0, idleTimedOut: true },
    { exitCode: -1, stopped: true },
  ];
  const texts = [
    composeText({}),
    composeText({ pr: true }),
    composeText({ gate: true }),
    composeText({ notice: "" }),
    composeText({ notice: "   " }),
    composeText({ notice: "a real reason" }),
    composeText({ pr: true, gate: true, notice: "a real reason" }),
    composeText({ body: "some narration with no heading at all" }),
    "",
    "   \n  ",
  ];
  let sawGate = false;
  for (const ending of endings) {
    for (const text of texts) {
      const outcome = classifyJobResult({ log: logWithResultText(text), ...ending });
      if (outcome.status === "gate") {
        sawGate = true;
        assert.ok(typeof outcome.noticeMd === "string" && outcome.noticeMd.trim().length > 0, `gate with blank notice for ending=${JSON.stringify(ending)} text=${JSON.stringify(text)}`);
      }
    }
    assert.equal(classifyJobResult({ log: logWithNoResultEvent(), ...ending }).status === "gate", false, "no result event at all must never reach gate");
  }
  assert.ok(sawGate, "the matrix must actually exercise at least one gate outcome, otherwise the invariant is vacuous");
});

test("the 8000 code-point cap on the fallback notice never splits a surrogate pair straddling the boundary", () => {
  const emoji = "\u{1F600}"; // a single code point, two UTF-16 units
  const text = `${"a".repeat(7999)}${emoji}${"a".repeat(200)}`;
  const outcome = classifyJobResult({ log: logWithResultText(text), exitCode: 0 });
  assert.equal(outcome.status, "gate");

  const naiveUtf16Cut = `${text.slice(0, 8000)}...`;
  assert.ok(LONE_HIGH_SURROGATE_RE.test(naiveUtf16Cut) || LONE_LOW_SURROGATE_RE.test(naiveUtf16Cut), "the naive UTF-16-unit cut must actually break the pair, or this test proves nothing");

  assert.equal(LONE_HIGH_SURROGATE_RE.test(outcome.noticeMd), false, "the real cap must never leave a lone high surrogate");
  assert.equal(LONE_LOW_SURROGATE_RE.test(outcome.noticeMd), false, "the real cap must never leave a lone low surrogate");
  assert.equal(Array.from(outcome.noticeMd).length, 8003, "8000 code points kept plus the three dots of the ellipsis");
  assert.ok(outcome.noticeMd.includes(emoji), "the emoji sitting right at the boundary must survive whole");
});
