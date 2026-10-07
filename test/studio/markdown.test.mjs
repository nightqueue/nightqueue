import assert from "node:assert/strict";
import { test } from "node:test";
import { inlineParts, markdownBlocks } from "../../studio/src/lib/markdown.ts";

const CORPUS = ["# Title", "Intro with `code` and a [link](https://a.example/x).", "| a | b |", "|---|---|", "| 1 | 2 |", "", "- one", "- two", "1. first", "```js", "const x = 1;", "```", "last *em* line"].join("\r\n");

const INTRO = "Intro with `code` and a [link](https://a.example/x).";

// What the renderer answered for the corpus before rich mode existed: the table is one joined paragraph, the link plain text.
const PLAIN_BLOCKS = [
  { kind: "heading", text: "Title" },
  { kind: "paragraph", text: `${INTRO} | a | b | |---|---| | 1 | 2 |` },
  { kind: "list", ordered: false, items: ["one", "two"] },
  { kind: "list", ordered: true, items: ["first"] },
  { kind: "code", text: "const x = 1;" },
  { kind: "paragraph", text: "last *em* line" },
];

const PLAIN_INTRO_PARTS = [
  { kind: "text", text: "Intro with " },
  { kind: "code", text: "code" },
  { kind: "text", text: " and a [link](https://a.example/x)." },
];

test("without rich the blocks and inline parts are exactly what the cards rendered before", () => {
  assert.deepEqual(markdownBlocks(CORPUS), PLAIN_BLOCKS);
  assert.deepEqual(markdownBlocks(CORPUS, { rich: false }), PLAIN_BLOCKS);
  assert.deepEqual(inlineParts(INTRO), PLAIN_INTRO_PARTS);
  assert.deepEqual(inlineParts(INTRO, { rich: false }), PLAIN_INTRO_PARTS);
  assert.deepEqual(inlineParts("[x](javascript:alert(1)) **b** _i_"), [
    { kind: "text", text: "[x](javascript:alert(1)) " },
    { kind: "strong", text: "b" },
    { kind: "text", text: " " },
    { kind: "em", text: "i" },
  ]);
});

test("in rich mode a pipe table right under a paragraph line becomes one table block", () => {
  assert.deepEqual(markdownBlocks(CORPUS, { rich: true }).slice(0, 3), [
    { kind: "heading", text: "Title" },
    { kind: "paragraph", text: INTRO },
    { kind: "table", header: ["a", "b"], rows: [["1", "2"]] },
  ]);
});

test("a rich table accepts alignment colons, fits ragged rows to the header and keeps escaped pipes", () => {
  const source = ["| left | right |", "|:--|--:|", "| only |", "| a | b | extra |", "| x \\| y | z |", "", "after the table"].join("\n");
  assert.deepEqual(markdownBlocks(source, { rich: true }), [
    {
      kind: "table",
      header: ["left", "right"],
      rows: [
        ["only", ""],
        ["a", "b"],
        ["x | y", "z"],
      ],
    },
    { kind: "paragraph", text: "after the table" },
  ]);
});

test("a header whose cell count differs from the separator's is no table", () => {
  const source = "| a | b | c |\n|---|---|\n| 1 | 2 | 3 |";
  assert.deepEqual(markdownBlocks(source, { rich: true }), [{ kind: "paragraph", text: "| a | b | c | |---|---| | 1 | 2 | 3 |" }]);
});

test("in rich mode only an http(s) link becomes a link part, and never inside code", () => {
  assert.deepEqual(inlineParts("see [the PR](https://github.com/acme/api/pull/7) now", { rich: true }), [
    { kind: "text", text: "see " },
    { kind: "link", text: "the PR", href: "https://github.com/acme/api/pull/7" },
    { kind: "text", text: " now" },
  ]);
  for (const literal of ["[x](javascript:alert(1))", "[x](data:text/html,hi)", "[x](/relative)"]) {
    assert.deepEqual(inlineParts(literal, { rich: true }), [{ kind: "text", text: literal }], `${literal} became a link`);
  }
  assert.deepEqual(inlineParts("`[x](https://a.example)`", { rich: true }), [{ kind: "code", text: "[x](https://a.example)" }]);
});

const HOSTILE_BUDGET_MS = 200;
const LARGE_REPORT_BUDGET_MS = 1000;

// How long one call takes, in milliseconds, with its answer.
function timed(fn) {
  const start = performance.now();
  const out = fn();
  return { ms: performance.now() - start, out };
}

// A rich markdown text folded the way a log block renders it: its blocks, then the inline parts of every text they hold.
function renderRich(source) {
  for (const block of markdownBlocks(source, { rich: true })) {
    const texts = block.kind === "list" ? block.items : block.kind === "table" ? [...block.header, ...block.rows.flat()] : [block.text];
    for (const text of texts) inlineParts(text, { rich: true });
  }
}

test("a separator-like line with a long whitespace tail is read in linear time and is still no table", () => {
  const { ms, out } = timed(() => markdownBlocks(`a|b\n---${" ".repeat(30000)}x`, { rich: true }));
  assert.ok(ms < HOSTILE_BUDGET_MS, `took ${ms.toFixed(0)} ms`);
  assert.equal(out[0].kind, markdownBlocks("a|b\nc", { rich: true })[0].kind);
});

test("a long run of opening brackets, closed or not, is scanned for links in linear time", () => {
  for (const input of ["[".repeat(30000), `${"[".repeat(30000)}]`]) {
    const { ms } = timed(() => inlineParts(input, { rich: true }));
    assert.ok(ms < HOSTILE_BUDGET_MS, `took ${ms.toFixed(0)} ms for ${input.length} chars`);
  }
});

test("a 1 MiB report mixing the hostile patterns renders under a second", () => {
  const chunk = `a|b\n---${" ".repeat(2000)}x\n${"[".repeat(2000)}]\n| a | b |\n|---|---|\n| [x](https://a.example) | 2 |\n\n`;
  const source = chunk.repeat(Math.ceil((1024 * 1024) / chunk.length));
  const { ms } = timed(() => renderRich(source));
  assert.ok(ms < LARGE_REPORT_BUDGET_MS, `took ${ms.toFixed(0)} ms`);
});

test("a link label holds no bracket and at most 1000 characters", () => {
  assert.deepEqual(inlineParts("[a [b](https://x.example)", { rich: true }), [
    { kind: "text", text: "[a " },
    { kind: "link", text: "b", href: "https://x.example" },
  ]);
  const long = `[${"a".repeat(1001)}](https://x.example)`;
  assert.deepEqual(inlineParts(long, { rich: true }), [{ kind: "text", text: long }]);
});
