export const MAX_DIFF_LINES = 2000;
const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

// A count of a hunk header, 1 when git omitted it.
function countOf(raw) {
  return raw === undefined ? 1 : Number(raw);
}

// The open hunk a `@@` header starts, null when the line is not one.
function hunkStart(line) {
  const match = HUNK_HEADER.exec(line);
  if (!match) return null;
  return { hunk: { header: line, lines: [] }, oldNo: Number(match[1]), newNo: Number(match[3]), oldLeft: countOf(match[2]), newLeft: countOf(match[4]) };
}

// The numbered line one row of a hunk is, moving the hunk's counters past it.
function hunkLine(open, line) {
  const marker = line[0];
  const text = line.slice(1);
  if (marker === "+") {
    open.newLeft -= 1;
    return { type: "add", new: open.newNo++, text };
  }
  if (marker === "-") {
    open.oldLeft -= 1;
    return { type: "del", old: open.oldNo++, text };
  }
  open.oldLeft -= 1;
  open.newLeft -= 1;
  return { type: "ctx", old: open.oldNo++, new: open.newNo++, text };
}

// Whether a hunk has read every line its header announced.
function isDone(open) {
  return open.oldLeft <= 0 && open.newLeft <= 0;
}

// The lines of a diff text, without the empty piece a final newline leaves.
function diffLines(text) {
  if (typeof text !== "string" || text === "") return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

// The hunks of a unified diff with old/new line numbers, whether git called the file binary, and whether lines were cut at the cap.
export function parseHunks(text, maxLines = MAX_DIFF_LINES) {
  const hunks = [];
  let binary = false;
  let count = 0;
  let open = null;
  for (const line of diffLines(text)) {
    if (open && line.startsWith("\\")) continue;
    if (open && !isDone(open)) {
      if (count >= maxLines) return { hunks: hunks.filter((hunk) => hunk.lines.length > 0), binary, capped: true };
      count += 1;
      open.hunk.lines.push(hunkLine(open, line));
      continue;
    }
    open = hunkStart(line);
    if (open) hunks.push(open.hunk);
    else if (line.startsWith("Binary files ")) binary = true;
  }
  return { hunks, binary, capped: false };
}
