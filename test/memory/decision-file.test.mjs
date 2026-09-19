import assert from "node:assert/strict";
import { test } from "node:test";
import { UserError } from "../../src/config/errors.mjs";
import { parseDecisionFile, renderDecisionFile, slugOf, stampPointer } from "../../src/memory/decision-file.mjs";

const MULTI_LINE_STATUS = `# 0003 - One widget per shelf

Status: Accepted (2026-01-05), later narrowed when shelves
became configurable; see the shelf notes.

## Context

Shelves hold widgets.

## Decision

Each shelf holds exactly one widget.

## Consequences

A second widget needs a second shelf.
`;

const HEADING_WITH_TEXT = `# 0005 - Gadgets are rendered on the server

Status: Accepted (2026-02-10).

## Context

Clients are slow.

## Decision

Render gadgets on the server.

## Consequences - what changes for the client

The client only paints.
`;

const EXTRA_SECTIONS = `# 0006 - A studio for gizmos

Status: Proposed (2026-03-01).

## Context

Gizmos are edited by hand.

## Decision

Build a studio.

## Pros

Faster edits.

## Cons

One more app.

## Consequences

Someone maintains the studio.
`;

const POINTER_IN_STATUS = `# 0007 - Sprockets run in parallel

Status: Accepted (2026-04-12). Decision #23 in the gadget store.

## Context

One sprocket at a time is slow.

## Decision

Run sprockets in parallel.
`;

// A decision row in the shape the database returns it.
function row(overrides = {}) {
  return {
    scope: "project",
    project: "alpha",
    org: null,
    number: 7,
    title: "Store everything in one file",
    context: "several writers",
    decision: "open it in WAL",
    consequences: "one file to back up",
    status: "accepted",
    created_at: "2026-05-04 00:00:00",
    ...overrides,
  };
}

test("a multi-line Status: paragraph yields its first word and its date", () => {
  const parsed = parseDecisionFile(MULTI_LINE_STATUS);
  assert.equal(parsed.title, "One widget per shelf");
  assert.equal(parsed.status, "accepted");
  assert.equal(parsed.date, "2026-01-05");
  assert.equal(parsed.pointer, null);
  assert.equal(parsed.context, "Shelves hold widgets.");
  assert.equal(parsed.decision, "Each shelf holds exactly one widget.");
  assert.equal(parsed.consequences, "A second widget needs a second shelf.");
});

test("the text after the field word of a heading becomes the first line of the field", () => {
  const parsed = parseDecisionFile(HEADING_WITH_TEXT);
  assert.equal(parsed.consequences, "what changes for the client\n\nThe client only paints.");
});

test("any other level-2 section stays inside the field it follows, heading included", () => {
  const parsed = parseDecisionFile(EXTRA_SECTIONS);
  assert.equal(parsed.status, "proposed");
  assert.equal(parsed.decision, "Build a studio.\n\n## Pros\n\nFaster edits.\n\n## Cons\n\nOne more app.");
  assert.equal(parsed.consequences, "Someone maintains the studio.");
});

test("a pointer inside the status line names the row and its owner", () => {
  const parsed = parseDecisionFile(POINTER_IN_STATUS);
  assert.deepEqual(parsed.pointer, { label: "#23", number: 23, owner: "gadget" });
  assert.equal(parsed.status, "accepted");
  assert.equal(parsed.consequences, null);
});

test("an org pointer and a successor are read with their owner prefix", () => {
  const parsed = parseDecisionFile(
    "# Shared rule\n\nStatus: Superseded (2026-01-01). Decision acme#4 in the acme store. Superseded by acme#9.\n\n## Context\n\nc\n\n## Decision\n\nd\n",
  );
  assert.deepEqual(parsed.pointer, { label: "acme#4", number: 4, owner: "acme" });
  assert.deepEqual(parsed.successor, { label: "acme#9", number: 9 });
  assert.equal(parsed.status, "superseded");
});

test("a status outside the enum reads as none", () => {
  assert.equal(parseDecisionFile("# t\n\nStatus: Draft\n\n## Context\n\nc\n\n## Decision\n\nd\n").status, null);
});

test("a file without Context or Decision is refused, naming the file", () => {
  assert.throws(() => parseDecisionFile("# t\n\n## Context\n\nc\n", "x.md"), (err) => err instanceof UserError && /^x\.md has no non-empty `## Decision` section; nothing imported$/.test(err.message));
  assert.throws(() => parseDecisionFile("# t\n\n## Decision\n\nd\n", "y.md"), /y\.md .*## Context/);
  assert.throws(() => parseDecisionFile("## Context\n\nc\n\n## Decision\n\nd\n", "z.md"), /z\.md .*# <title>/);
});

test("the rendered file carries status, date, pointer and every field, and parses back to the row", () => {
  const text = renderDecisionFile(row());
  assert.equal(
    text,
    "# 0007 - Store everything in one file\n\nStatus: Accepted (2026-05-04). Decision #7 in the alpha store.\n\n## Context\n\nseveral writers\n\n## Decision\n\nopen it in WAL\n\n## Consequences\n\none file to back up\n",
  );
  const parsed = parseDecisionFile(text);
  assert.equal(parsed.title, "Store everything in one file");
  assert.equal(parsed.status, "accepted");
  assert.equal(parsed.date, "2026-05-04");
  assert.deepEqual(parsed.pointer, { label: "#7", number: 7, owner: "alpha" });
  assert.equal(parsed.consequences, "one file to back up");
});

test("a row without consequences omits the section, and a superseded one names its successor", () => {
  const text = renderDecisionFile(row({ consequences: null, status: "superseded" }), { successorLabel: "#9" });
  assert.ok(!text.includes("## Consequences"));
  assert.ok(text.includes("Status: Superseded (2026-05-04). Decision #7 in the alpha store. Superseded by #9.\n"));
  assert.equal(parseDecisionFile(text).successor.number, 9);
});

test("slugOf strips diacritics, lower-cases, dashes and cuts at a dash within 60 characters", () => {
  assert.equal(slugOf("Décisions à l'Échelle: v2!"), "decisions-a-l-echelle-v2");
  assert.equal(slugOf("!!!"), "decision");
  const long = slugOf("one job per runner and any number of runners register while jobs of a project run in parallel");
  assert.ok(long.length <= 60, long);
  assert.equal(long, "one-job-per-runner-and-any-number-of-runners-register-while");
  assert.equal(slugOf("a".repeat(70)), "a".repeat(60));
});

test("stampPointer inserts the line after the title, and replaces it on a second stamp", () => {
  const stamped = stampPointer(MULTI_LINE_STATUS, "#12", "gadget");
  assert.ok(stamped.startsWith("# 0003 - One widget per shelf\n\nDecision #12 in the gadget store.\n\nStatus: Accepted (2026-01-05)"));
  assert.deepEqual(parseDecisionFile(stamped).pointer, { label: "#12", number: 12, owner: "gadget" });
  const again = stampPointer(stamped, "#13", "gadget");
  assert.equal(again.match(/Decision #\d+ in the/g).length, 1);
  assert.ok(again.includes("Decision #13 in the gadget store."));
});

test("stampPointer replaces a pointer inside the status line and keeps the rest of the line", () => {
  const stamped = stampPointer(POINTER_IN_STATUS, "#2", "alpha");
  assert.ok(stamped.includes("Status: Accepted (2026-04-12). Decision #2 in the alpha store.\n"));
  assert.equal(stamped.replace("Decision #2 in the alpha store", "Decision #23 in the gadget store"), POINTER_IN_STATUS);
});

const COMMENTED_HEADER = `# 0004 - Shelves hold widgets

<!-- Decision #9 in the old store. Superseded by #10. -->
Status: Accepted (2026-02-01). <!-- Status: rejected
still inside an unclosed comment

## Context

Shelves were empty.

## Decision

Shelves hold widgets.
`;

test("HTML comments in the header zone, closed or not, carry no status, pointer or successor", () => {
  const parsed = parseDecisionFile(COMMENTED_HEADER);
  assert.equal(parsed.status, "accepted");
  assert.equal(parsed.pointer, null);
  assert.equal(parsed.successor, null);
});

test("stampPointer never replaces a pointer that only sits inside an HTML comment", () => {
  const stamped = stampPointer(COMMENTED_HEADER, "#4", "alpha");
  assert.ok(stamped.includes("<!-- Decision #9 in the old store. Superseded by #10. -->"));
  assert.deepEqual(parseDecisionFile(stamped).pointer, { label: "#4", number: 4, owner: "alpha" });
});

test("a field heading inside a tilde or backtick fence stays inside the field", () => {
  const row = {
    scope: "project",
    project: "alpha",
    org: null,
    number: 5,
    title: "Quote the format",
    context: "~~~~\n## Decision\n~~~\nstill fenced\n~~~~",
    decision: "````md\n## Consequences\n```\n````\nafter the fence",
    consequences: null,
    status: "accepted",
    created_at: "2026-06-01 00:00:00",
  };
  const parsed = parseDecisionFile(renderDecisionFile(row));
  assert.equal(parsed.context, row.context);
  assert.equal(parsed.decision, row.decision);
  assert.equal(parsed.consequences, null);
});
